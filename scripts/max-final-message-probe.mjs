import fs from 'node:fs/promises';

import { loadMaxCommand } from './max-command-contract.mjs';
import { resolveDestination } from './max-destination.mjs';
import { launchAuthenticatedMax } from './max-runtime.mjs';
import { normalizeText } from './max-ui.mjs';

const REGISTRY_PATH = 'config/social-destinations.public.json';
const ATTEMPTS = 5;
const RETRY_DELAY_MS = 1_500;

function canonicalUrl(value) {
  try { return new URL(value).href; } catch { return ''; }
}

function requiredTextFragments(text) {
  const sentences = normalizeText(text).match(/[^.!?]+[.!?]+|[^.!?]+$/gu)
    ?.map((value) => normalizeText(value))
    .filter((value) => value.length >= 20) || [];
  if (!sentences.length) return [];
  const last = sentences.length - 1;
  return [...new Set([0, Math.floor(last / 3), Math.floor((last * 2) / 3), last])]
    .sort((left, right) => left - right)
    .map((index) => sentences[index])
    .filter(Boolean);
}

async function destinationConfig(command) {
  const payload = JSON.parse(await fs.readFile(REGISTRY_PATH, 'utf8'));
  const key = normalizeText(command.destination?.key);
  const matches = (payload?.destinations || []).filter((entry) => normalizeText(entry?.key) === key);
  if (matches.length !== 1) throw new Error(`MAX probe expected one registry entry for ${key}.`);
  const config = matches[0]?.platforms?.max;
  if (!config?.title) throw new Error(`MAX probe found no MAX title for ${key}.`);
  return { title: normalizeText(config.title), kind: normalizeText(config.type) || 'channel' };
}

async function matchingCandidates(page, command) {
  const fragments = requiredTextFragments(command.content.text);
  const links = (command.content.links || []).map((link) => ({
    text: normalizeText(link.text),
    href: canonicalUrl(link.url),
  }));
  const locator = page.locator('[role="listitem"], [role="presentation"]');
  const count = Math.min(await locator.count(), 900);
  const candidates = [];

  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    const details = await item.evaluate((element, expected) => {
      const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
      const canonical = (value) => {
        try { return new URL(value, location.href).href; } catch { return ''; }
      };
      const bodyText = clean(element.innerText || element.textContent || '');
      const anchors = Array.from(element.querySelectorAll('a')).map((anchor) => ({
        text: clean(anchor.innerText || anchor.textContent || ''),
        href: canonical(anchor.getAttribute('href') || anchor.href || ''),
      }));
      const fragmentMatches = expected.fragments.filter((fragment) => bodyText.includes(fragment)).length;
      const linkMatches = expected.links.every((link) => anchors.some((anchor) => (
        anchor.text === link.text && anchor.href === link.href
      )));
      const media = Boolean(element.querySelector(
        'img, video, canvas, [aria-label="Прикрепленные фото"], [aria-label*="Прикреплен" i]',
      ));
      const box = element.getBoundingClientRect();
      let depth = 0;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) depth += 1;
      return {
        fragmentMatches,
        fragmentTotal: expected.fragments.length,
        linkMatches,
        media,
        depth,
        box: [box.x, box.y, box.width, box.height],
      };
    }, { fragments, links }).catch(() => null);
    if (!details) continue;
    if (details.fragmentMatches !== details.fragmentTotal || !details.linkMatches || !details.media) continue;
    candidates.push({ index, ...details });
  }
  return candidates;
}

async function visibleOverlays(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) > 0
        && box.width > 0
        && box.height > 0
        && box.bottom > 0
        && box.top < innerHeight;
    };
    return Array.from(document.querySelectorAll(
      '[role="dialog"], [role="menu"], [role="menuitem"], [data-radix-popper-content-wrapper], .popover, .actionsMenu, button',
    )).filter(visible).map((element) => {
      const box = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') || '',
        aria: clean(element.getAttribute('aria-label') || ''),
        text: clean(element.innerText || element.textContent || '').slice(0, 1_200),
        box: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
        className: String(element.className || '').slice(0, 220),
      };
    }).filter((entry) => (
      entry.role === 'dialog'
      || entry.role === 'menu'
      || entry.role === 'menuitem'
      || /редакт|измен|удал|копир|ответ|закреп|пересл|выбрать|действ|ещ|меню|опци|сохран|отмен|реакц/i.test(
        `${entry.aria} ${entry.text} ${entry.className}`,
      )
    )).slice(0, 160);
  });
}

const command = await loadMaxCommand();
if (command.content.type !== 'rich_post') throw new Error('MAX edit-menu probe requires rich_post.');
const destination = await destinationConfig(command);
let runtime;

try {
  runtime = await launchAuthenticatedMax({
    timezoneId: command.delivery.timeZone,
    viewport: { width: 1440, height: 1800 },
  });
  const resolved = await resolveDestination(runtime.page, {
    exactTitle: destination.title,
    kind: destination.kind,
  });

  let candidates = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    await runtime.page.waitForTimeout(attempt === 1 ? 1_500 : RETRY_DELAY_MS);
    candidates = await matchingCandidates(runtime.page, command);
    if (candidates.length) break;
    await runtime.page.keyboard.press('End').catch(() => {});
  }
  if (!candidates.length) throw new Error(`MAX probe found no exact post in ${resolved.title}.`);

  const selected = [...candidates].sort((left, right) => (
    right.depth - left.depth
    || (left.box[2] * left.box[3]) - (right.box[2] * right.box[3])
  ))[0];
  const item = runtime.page.locator('[role="listitem"], [role="presentation"]').nth(selected.index);
  await item.evaluate((element) => element.scrollIntoView({ block: 'start', inline: 'nearest' }));
  await runtime.page.waitForTimeout(900);

  const message = item.locator('div.message[aria-haspopup="dialog"]').first();
  const messageCount = await message.count();
  const messageVisible = messageCount ? await message.isVisible().catch(() => false) : false;
  const messageBox = messageCount ? await message.boundingBox().catch(() => null) : null;
  if (!messageCount || !messageVisible) {
    throw new Error(`MAX exact message was not clickable; count=${messageCount}, box=${JSON.stringify(messageBox)}.`);
  }

  const before = await visibleOverlays(runtime.page);
  await message.click({ position: { x: 250, y: Math.min(250, Math.max(30, (messageBox?.height || 300) * 0.35)) } });
  await runtime.page.waitForTimeout(1_100);
  const after = await visibleOverlays(runtime.page);
  const messageExpanded = await message.getAttribute('aria-expanded').catch(() => null);

  console.log(`MAX_EDIT_MENU_DESTINATION=${resolved.title}`);
  console.log(`MAX_EDIT_MENU_CANDIDATES=${JSON.stringify(candidates)}`);
  console.log(`MAX_EDIT_MENU_TARGET=${JSON.stringify({ count: messageCount, visible: messageVisible, box: messageBox, expanded: messageExpanded })}`);
  console.log(`MAX_EDIT_MENU_OVERLAYS_BEFORE=${JSON.stringify(before)}`);
  console.log(`MAX_EDIT_MENU_OVERLAYS_AFTER=${JSON.stringify(after)}`);
  await runtime.page.keyboard.press('Escape').catch(() => {});
} finally {
  if (runtime?.context) await runtime.context.close().catch(() => {});
  if (runtime?.browser) await runtime.browser.close().catch(() => {});
}
