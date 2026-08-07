import fs from 'node:fs/promises';

import { loadMaxCommand } from './max-command-contract.mjs';
import { resolveDestination } from './max-destination.mjs';
import { launchAuthenticatedMax } from './max-runtime.mjs';
import { normalizeText } from './max-ui.mjs';

const REGISTRY_PATH = 'config/social-destinations.public.json';
const ATTEMPTS = 5;
const RETRY_DELAY_MS = 1_500;

function canonicalUrl(value) {
  try {
    return new URL(value).href;
  } catch {
    return '';
  }
}

function requiredTextFragments(text) {
  const normalized = normalizeText(text);
  const sentences = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/gu)
    ?.map((value) => normalizeText(value))
    .filter((value) => value.length >= 20) || [];
  if (!sentences.length) return [];
  const last = sentences.length - 1;
  const indexes = new Set([0, Math.floor(last / 3), Math.floor((last * 2) / 3), last]);
  return [...indexes]
    .sort((left, right) => left - right)
    .map((index) => sentences[index])
    .filter(Boolean);
}

async function destinationConfig(command) {
  const payload = JSON.parse(await fs.readFile(REGISTRY_PATH, 'utf8'));
  const key = normalizeText(command.destination?.key);
  const entries = Array.isArray(payload?.destinations) ? payload.destinations : [];
  const matches = entries.filter((entry) => normalizeText(entry?.key) === key);
  if (matches.length !== 1) {
    throw new Error(`MAX probe expected one destination registry entry for ${key}, found ${matches.length}.`);
  }
  const config = matches[0]?.platforms?.max;
  if (!config?.title) throw new Error(`MAX probe found no MAX title for ${key}.`);
  return { title: normalizeText(config.title), kind: normalizeText(config.type) || 'channel' };
}

async function matchingMessageCandidates(page, command) {
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
      const fragmentMatches = expected.fragments.filter((fragment) => bodyText.includes(fragment));
      const linkMatches = expected.links.map((link) => anchors.some((anchor) => (
        anchor.text === link.text && anchor.href === link.href
      )));
      const media = Boolean(element.querySelector(
        'img, video, canvas, [aria-label="Прикрепленные фото"], [aria-label*="Прикреплен" i]',
      ));
      const box = element.getBoundingClientRect();
      let depth = 0;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) depth += 1;
      return {
        bodyText,
        fragmentMatches: fragmentMatches.length,
        fragmentTotal: expected.fragments.length,
        linkMatches,
        media,
        depth,
        box: [box.x, box.y, box.width, box.height],
      };
    }, { fragments, links }).catch(() => null);

    if (!details) continue;
    if (details.fragmentMatches !== details.fragmentTotal) continue;
    if (!details.media || !details.linkMatches.every(Boolean)) continue;
    candidates.push({ index, ...details });
  }

  return { fragments, links, candidates };
}

async function inspectStructure(item) {
  return item.evaluate((element) => {
    const rawText = String(element.innerText || element.textContent || '');
    const lineBreakRuns = Array.from(rawText.matchAll(/\n+/g)).map((match) => match[0].length);
    const box = element.getBoundingClientRect();
    return {
      rawText: rawText.slice(0, 2_500),
      lineBreakRuns,
      doubleBreakCount: lineBreakRuns.filter((length) => length >= 2).length,
      htmlPrefix: String(element.innerHTML || '').slice(0, 4_000),
      box: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
    };
  });
}

async function overlaySnapshot(page) {
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
      '[role="menuitem"], [role="menu"], [role="dialog"], [data-radix-popper-content-wrapper], button, [role="button"], [aria-haspopup]',
    ))
      .filter(visible)
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role') || '',
          hasPopup: element.getAttribute('aria-haspopup') || '',
          expanded: element.getAttribute('aria-expanded') || '',
          aria: clean(element.getAttribute('aria-label') || ''),
          title: clean(element.getAttribute('title') || ''),
          text: clean(element.innerText || element.textContent || '').slice(0, 500),
          box: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
          className: String(element.className || '').slice(0, 180),
        };
      })
      .filter((entry) => (
        entry.role === 'dialog'
        || entry.role === 'menu'
        || entry.role === 'menuitem'
        || /редакт|измен|удал|копир|ответ|закреп|пересл|выбрать|действ|ещ|меню|опци|сохран|отмен/i.test(
          `${entry.aria} ${entry.title} ${entry.text} ${entry.className}`,
        )
      ))
      .slice(0, 120);
  });
}

const command = await loadMaxCommand();
if (command.content.type !== 'rich_post') throw new Error('MAX final-message probe requires rich_post content.');
const stableFragments = requiredTextFragments(command.content.text);
if (stableFragments.length < 3) throw new Error('MAX final-message probe requires at least three stable text fragments.');

const destination = await destinationConfig(command);
let runtime;

try {
  runtime = await launchAuthenticatedMax({ timezoneId: command.delivery.timeZone });
  const resolved = await resolveDestination(runtime.page, {
    exactTitle: destination.title,
    kind: destination.kind,
  });

  let match = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    await runtime.page.waitForTimeout(attempt === 1 ? 1_500 : RETRY_DELAY_MS);
    match = await matchingMessageCandidates(runtime.page, command);
    if (match.candidates.length) break;
    if (attempt < ATTEMPTS) await runtime.page.keyboard.press('End').catch(() => {});
  }
  if (!match?.candidates.length) throw new Error(`MAX probe found no rich-post candidate in ${resolved.title}.`);

  const selected = [...match.candidates]
    .sort((left, right) => (
      right.depth - left.depth
      || (left.box[2] * left.box[3]) - (right.box[2] * right.box[3])
    ))[0];
  const item = runtime.page.locator('[role="listitem"], [role="presentation"]').nth(selected.index);
  await item.scrollIntoViewIfNeeded().catch(() => {});
  await runtime.page.waitForTimeout(500);
  const structure = await inspectStructure(item);

  await item.hover().catch(() => {});
  await runtime.page.waitForTimeout(800);
  const actionButton = item.getByRole('button', { name: 'Действия с сообщением', exact: true });
  let firstLayer = [];
  let secondLayer = [];

  if (await actionButton.count()) {
    await actionButton.click({ timeout: 8_000 });
    await runtime.page.waitForTimeout(900);
    firstLayer = await overlaySnapshot(runtime.page);

    const selectedCell = runtime.page.locator('.cell--selected').filter({ hasText: stableFragments[0] }).first();
    const selectedWrapper = selectedCell.locator('xpath=..');
    const more = selectedWrapper.getByRole('button', { name: 'Еще', exact: true });
    if (await more.count()) {
      await more.click({ timeout: 8_000 });
      await runtime.page.waitForTimeout(900);
      secondLayer = await overlaySnapshot(runtime.page);
    }
  }
  await runtime.page.keyboard.press('Escape').catch(() => {});
  await runtime.page.keyboard.press('Escape').catch(() => {});

  console.log(`MAX_FORMAT_PROBE_DESTINATION=${resolved.title}`);
  console.log(`MAX_FORMAT_PROBE_CANDIDATES=${JSON.stringify(match.candidates.map((candidate) => ({
    index: candidate.index,
    fragments: `${candidate.fragmentMatches}/${candidate.fragmentTotal}`,
    depth: candidate.depth,
    box: candidate.box.map((value) => Math.round(value)),
  })))}`);
  console.log(`MAX_FORMAT_PROBE_STRUCTURE=${JSON.stringify(structure)}`);
  console.log(`MAX_FORMAT_PROBE_ACTION_LAYER1=${JSON.stringify(firstLayer)}`);
  console.log(`MAX_FORMAT_PROBE_ACTION_LAYER2=${JSON.stringify(secondLayer)}`);
} finally {
  if (runtime?.context) await runtime.context.close().catch(() => {});
  if (runtime?.browser) await runtime.browser.close().catch(() => {});
}
