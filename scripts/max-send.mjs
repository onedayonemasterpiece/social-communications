import fs from 'node:fs/promises';
import path from 'node:path';
import { launchAuthenticatedMax } from './max-runtime.mjs';
import {
  captureEvidence,
  clearComposer,
  findAttachmentButton,
  findComposer,
  findSendButton,
  firstVisible,
  normalizeText,
  openChatByExactTitle,
  typePlainText,
} from './max-ui.mjs';

const artifactDir = path.resolve(process.env.MAX_ARTIFACT_DIR || 'artifacts/max-send');
const captureEnabled = process.env.MAX_CAPTURE_EVIDENCE === '1';
const commandFile = process.env.MAX_COMMAND_FILE?.trim() || '.github/max-live-command.json';

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function loadCommand() {
  const raw = process.env.MAX_COMMAND_JSON?.trim()
    || await fs.readFile(path.resolve(commandFile), 'utf8');
  const command = JSON.parse(raw);
  if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('MAX command must be a JSON object.');
  if (Number(command.version) !== 1) throw new Error('MAX command version must be 1.');
  if (!['text', 'schedule_text', 'rich_post'].includes(command.action)) throw new Error(`Unsupported MAX action: ${command.action}`);
  if (!command.chat || !normalizeText(command.chat.title)) throw new Error('MAX command requires chat.title.');
  if (!normalizeText(command.text)) throw new Error('MAX command requires non-empty text.');
  if (normalizeText(command.text).length > 4_000) throw new Error('MAX command text exceeds the 4000-character safety limit.');
  if (!normalizeText(command.requestId)) throw new Error('MAX command requires requestId.');
  if (command.action === 'schedule_text' && !command.scheduleAt) throw new Error('schedule_text requires scheduleAt.');
  if (command.action === 'rich_post') {
    if (!command.image?.path) throw new Error('rich_post requires image.path.');
    if (!Array.isArray(command.links) || command.links.length < 1) throw new Error('rich_post requires at least one formatted link.');
    if (command.links.length > 10) throw new Error('rich_post supports at most 10 formatted links.');
    for (const link of command.links) {
      if (!normalizeText(link.text)) throw new Error('Each formatted link requires text.');
      const url = new URL(link.url);
      if (url.protocol !== 'https:') throw new Error('Formatted links must use HTTPS.');
    }
  }
  return command;
}

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

const RUSSIAN_MONTHS = new Map([
  ['Январь', 1], ['Февраль', 2], ['Март', 3], ['Апрель', 4], ['Май', 5], ['Июнь', 6],
  ['Июль', 7], ['Август', 8], ['Сентябрь', 9], ['Октябрь', 10], ['Ноябрь', 11], ['Декабрь', 12],
]);

async function visibleExactTextCount(page, text) {
  const locator = page.getByText(text, { exact: true });
  const count = Math.min(await locator.count(), 200);
  let visible = 0;
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) visible += 1;
  }
  return visible;
}

async function composerText(composer) {
  return composer.evaluate((element) => (
    'value' in element ? String(element.value || '') : String(element.innerText || element.textContent || '')
  )).catch(() => '');
}

async function chooseCalendarMonth(page, target) {
  const monthPattern = /^(Январь|Февраль|Март|Апрель|Май|Июнь|Июль|Август|Сентябрь|Октябрь|Ноябрь|Декабрь)\s+(\d{4})$/;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const title = await firstVisible(page.getByText(monthPattern), 50);
    if (!title) throw new Error('MAX schedule month title was not found.');
    const text = normalizeText(await title.innerText());
    const match = text.match(monthPattern);
    if (!match) throw new Error(`Cannot parse MAX schedule month title: ${text}`);
    const current = { month: RUSSIAN_MONTHS.get(match[1]), year: Number(match[2]) };
    const currentIndex = current.year * 12 + current.month;
    const targetIndex = target.year * 12 + target.month;
    if (currentIndex === targetIndex) return text;
    const direction = targetIndex > currentIndex ? 'Следующий месяц' : 'Предыдущий месяц';
    await page.getByRole('button', { name: direction, exact: true }).click();
    await page.waitForTimeout(300);
  }
  throw new Error('MAX schedule month navigation exceeded 30 steps.');
}

async function setSpinbutton(page, label, value) {
  const expected = String(value).padStart(2, '0');
  const spin = page.getByRole('spinbutton', { name: label, exact: true });
  await spin.waitFor({ state: 'visible' });
  await spin.click();
  await spin.press('Control+A').catch(() => {});
  await spin.pressSequentially(expected, { delay: 90 });
  await page.waitForTimeout(300);
  const actual = normalizeText(await spin.textContent());
  if (actual !== expected) throw new Error(`MAX ${label} spinbutton expected ${expected}, received ${actual}.`);
}

async function scheduleText(page, command, result) {
  const timeZone = command.timeZone || 'Europe/Kaliningrad';
  const scheduleDate = new Date(command.scheduleAt);
  if (Number.isNaN(scheduleDate.getTime())) throw new Error(`Invalid scheduleAt: ${command.scheduleAt}`);
  if (scheduleDate.getTime() < Date.now() + 60_000) throw new Error('scheduleAt must be at least one minute in the future.');
  const target = zonedParts(scheduleDate, timeZone);

  const composer = await findComposer(page);
  const send = await findSendButton(page);
  const exactBefore = await visibleExactTextCount(page, command.text);
  if (exactBefore > 0) {
    result.outcome = 'already_present';
    result.verification = { exactBefore, skippedToAvoidDuplicate: true };
    return;
  }

  await typePlainText(composer, command.text);
  await send.click({ button: 'right' });
  const menuItem = page.getByRole('menuitem', { name: 'Отправить позже', exact: true });
  await menuItem.waitFor({ state: 'visible' });
  await menuItem.click();

  const monthTitle = await chooseCalendarMonth(page, target);
  const day = page
    .locator('button.day:not(.day--otherMonth):not(.day--disabled)')
    .filter({ hasText: new RegExp(`^${target.day}$`) });
  if (await day.count() !== 1) throw new Error(`Expected exactly one selectable day ${target.day}, found ${await day.count()}.`);
  await day.click();
  await setSpinbutton(page, 'Часы', target.hour);
  await setSpinbutton(page, 'Минуты', target.minute);

  const targetTime = `${String(target.hour).padStart(2, '0')}:${String(target.minute).padStart(2, '0')}`;
  const confirm = page.getByRole('button', {
    name: new RegExp(`^Отправить .+ в ${escapeRegex(targetTime)}$`),
  });
  await confirm.waitFor({ state: 'visible' });
  const confirmationText = normalizeText(await confirm.innerText());
  if (!confirmationText.includes(targetTime)) {
    throw new Error(`MAX schedule confirmation does not contain ${targetTime}: ${confirmationText}`);
  }
  result.schedule = { ...target, timeZone, monthTitle, confirmationText };
  if (captureEnabled) await captureEvidence(page, artifactDir, '02-schedule-ready');

  await confirm.click();
  await confirm.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(2_000);

  const remaining = normalizeText(await composerText(composer));
  const dialogStillVisible = await page.getByText('Отправить позже', { exact: true }).isVisible().catch(() => false);
  if (remaining.includes(command.text)) throw new Error('Scheduled message confirmation did not clear the composer.');
  if (dialogStillVisible) throw new Error('MAX schedule dialog remained visible after the confirmation click.');

  const exactAfter = await visibleExactTextCount(page, command.text);
  const scheduleMarkers = await page.evaluate(() => {
    const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    };
    return Array.from(document.querySelectorAll('button, [role], [aria-label], [title], [class*="toast" i]'))
      .filter(visible)
      .map((element) => clean(`${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''} ${element.innerText || element.textContent || ''}`))
      .filter((text) => /заплан|отправ.*позже|scheduled/i.test(text))
      .slice(0, 30);
  });

  result.outcome = 'scheduled';
  result.verification = {
    exactBefore,
    exactAfter,
    composerCleared: true,
    scheduleDialogClosed: true,
    scheduleMarkers,
  };
  if (captureEnabled) await captureEvidence(page, artifactDir, '03-scheduled');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function canonicalUrl(value) {
  return new URL(value).href;
}

async function composerAnchorMatches(composer, link) {
  return composer.evaluate((element, expected) => {
    const expectedUrl = new URL(expected.url, location.href).href;
    return Array.from(element.querySelectorAll('a')).some((anchor) => {
      const text = String(anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim();
      let href = '';
      try { href = new URL(anchor.getAttribute('href') || anchor.href, location.href).href; } catch {}
      return text === expected.text && href === expectedUrl;
    });
  }, { text: normalizeText(link.text), url: link.url });
}

async function pasteRichCaption(page, composer, command) {
  const htmlParts = [escapeHtml(command.text).replace(/\n/g, '<br>')];
  const plainParts = [command.text];
  for (const link of command.links) {
    htmlParts.push(`<a href="${escapeHtml(canonicalUrl(link.url))}">${escapeHtml(link.text)}</a>`);
    plainParts.push(link.text);
  }
  const html = `<p>${htmlParts.join('<br>')}</p>`;
  const plainText = plainParts.join('\n');

  await page.evaluate(async ({ htmlValue, plainValue }) => {
    if (typeof ClipboardItem !== 'function') throw new Error('ClipboardItem is unavailable in this browser.');
    const item = new ClipboardItem({
      'text/html': new Blob([htmlValue], { type: 'text/html' }),
      'text/plain': new Blob([plainValue], { type: 'text/plain' }),
    });
    await navigator.clipboard.write([item]);
  }, { htmlValue: html, plainValue: plainText });

  await composer.click();
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(900);

  for (const link of command.links) {
    if (!(await composerAnchorMatches(composer, link))) {
      const composerHtml = await composer.evaluate((element) => element.innerHTML);
      throw new Error(`MAX composer did not preserve formatted link «${link.text}». Composer HTML: ${composerHtml.slice(0, 1_200)}`);
    }
  }
  return {
    composerHtml: await composer.evaluate((element) => element.innerHTML),
    plainText,
  };
}

async function visibleLowerPaneMediaCount(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) > 0
        && box.width > 30
        && box.height > 30
        && box.x > 470
        && box.y > innerHeight * 0.55;
    };
    return Array.from(document.querySelectorAll('img, video, canvas, [aria-label*="Прикреп" i]')).filter(visible).length;
  });
}

async function discardDraft(page, composer) {
  if (composer) await clearComposer(composer).catch(() => {});
  const removeCandidates = page.locator([
    'button[aria-label*="Удалить" i]',
    'button[title*="Удалить" i]',
    'button[aria-label*="Убрать" i]',
    'button[title*="Убрать" i]',
  ].join(','));
  const count = Math.min(await removeCandidates.count(), 20);
  for (let index = 0; index < count; index += 1) {
    const button = removeCandidates.nth(index);
    if (!(await button.isVisible().catch(() => false))) continue;
    const box = await button.boundingBox().catch(() => null);
    if (!box || box.x < 470 || box.y < 600) continue;
    await button.click().catch(() => {});
  }
}

async function uploadPhoto(page, imagePath) {
  const absolutePath = path.resolve(imagePath);
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) throw new Error(`Image path is not a file: ${absolutePath}`);
  if (stat.size > 20 * 1024 * 1024) throw new Error(`Image exceeds 20 MiB: ${stat.size}`);

  const baseline = await visibleLowerPaneMediaCount(page);
  const attachment = await findAttachmentButton(page);
  await attachment.click();
  const photoOption = page.getByText('Фото или видео', { exact: true });
  await photoOption.waitFor({ state: 'visible' });
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 5_000 });
  await photoOption.click();
  const chooser = await chooserPromise;
  await chooser.setFiles(absolutePath);

  let after = baseline;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.waitForTimeout(250);
    after = await visibleLowerPaneMediaCount(page);
    if (after > baseline) break;
  }
  if (after <= baseline) {
    const fileNameVisible = await page.getByText(path.basename(absolutePath), { exact: false }).count();
    if (!fileNameVisible) throw new Error('MAX did not expose an image preview after file selection.');
  }

  const send = await findSendButton(page);
  if (!(await send.isEnabled().catch(() => true))) throw new Error('MAX send button remained disabled after image upload.');
  return { absolutePath, bytes: stat.size, previewBaseline: baseline, previewAfter: after };
}

async function sentRichContainerEvidence(page, command) {
  const textNode = await firstVisible(page.getByText(command.text, { exact: true }), 200);
  if (!textNode) return { found: false, links: [], media: false, text: '' };
  return textNode.evaluate((element, expectedLinks) => {
    let current = element;
    for (let depth = 0; current && depth < 14; depth += 1, current = current.parentElement) {
      const text = String(current.innerText || current.textContent || '').replace(/\s+/g, ' ').trim();
      const links = expectedLinks.map((expected) => {
        const expectedHref = new URL(expected.url, location.href).href;
        return Array.from(current.querySelectorAll('a')).some((anchor) => {
          const anchorText = String(anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim();
          let href = '';
          try { href = new URL(anchor.getAttribute('href') || anchor.href, location.href).href; } catch {}
          return anchorText === expected.text && href === expectedHref;
        });
      });
      const media = Boolean(current.querySelector('img, video, canvas, [aria-label*="Прикреп" i]'));
      if (links.every(Boolean) && media) return { found: true, links, media, text: text.slice(0, 700) };
    }
    return { found: true, links: expectedLinks.map(() => false), media: false, text: '' };
  }, command.links.map((link) => ({ text: normalizeText(link.text), url: link.url })));
}

async function sendRichPost(page, command, result) {
  const exactBefore = await visibleExactTextCount(page, command.text);
  if (exactBefore > 0) {
    result.outcome = 'already_present';
    result.verification = { exactBefore, skippedToAvoidDuplicate: true };
    return;
  }

  let composer;
  try {
    const image = await uploadPhoto(page, command.image.path);
    composer = await findComposer(page);
    const rich = await pasteRichCaption(page, composer, command);
    result.preflight = {
      image: { bytes: image.bytes, previewBaseline: image.previewBaseline, previewAfter: image.previewAfter },
      richText: { composerHtml: rich.composerHtml.slice(0, 2_000) },
    };
    if (captureEnabled) await captureEvidence(page, artifactDir, '02-rich-post-ready');

    const send = await findSendButton(page);
    await send.click();
    await page.waitForTimeout(3_000);

    const remaining = normalizeText(await composerText(composer));
    const exactAfter = await visibleExactTextCount(page, command.text);
    if (remaining.includes(command.text)) throw new Error('Rich post send did not clear the composer.');
    if (exactAfter < 1) throw new Error('Rich post text is not visible after send.');

    const container = await sentRichContainerEvidence(page, command);
    if (!container.found || !container.media || !container.links.every(Boolean)) {
      throw new Error(`Sent post verification failed: media=${container.media}, links=${JSON.stringify(container.links)}.`);
    }

    result.outcome = 'sent';
    result.verification = {
      exactBefore,
      exactAfter,
      composerCleared: true,
      formattedLinks: command.links.map((link, index) => ({
        text: link.text,
        url: canonicalUrl(link.url),
        visibleInSentPost: Boolean(container.links[index]),
      })),
      mediaVisibleInSamePost: container.media,
      sentContainerText: container.text,
    };
    if (captureEnabled) await captureEvidence(page, artifactDir, '03-rich-post-sent');
  } catch (error) {
    await discardDraft(page, composer).catch(() => {});
    throw error;
  }
}

async function sendText(page, command, result) {
  const exactBefore = await visibleExactTextCount(page, command.text);
  if (exactBefore > 0) {
    result.outcome = 'already_present';
    result.verification = { exactBefore, skippedToAvoidDuplicate: true };
    return;
  }
  const composer = await findComposer(page);
  await typePlainText(composer, command.text);
  await (await findSendButton(page)).click();
  await page.waitForTimeout(2_000);
  const exactAfter = await visibleExactTextCount(page, command.text);
  if (exactAfter < 1) throw new Error('Sent text is not visible after send.');
  result.outcome = 'sent';
  result.verification = { exactBefore, exactAfter };
}

const result = {
  status: 'started',
  startedAt: new Date().toISOString(),
  command: null,
  session: null,
  chat: null,
  outcome: null,
  verification: null,
};

let runtime;
try {
  const command = await loadCommand();
  result.command = {
    version: command.version,
    requestId: command.requestId,
    action: command.action,
    chatTitle: command.chat.title,
    scheduleAt: command.scheduleAt || null,
  };
  runtime = await launchAuthenticatedMax({ timezoneId: command.timeZone || 'Europe/Kaliningrad' });
  result.session = runtime.session.counts;
  result.chat = await openChatByExactTitle(runtime.page, command.chat.title);
  if (captureEnabled) await captureEvidence(runtime.page, artifactDir, '01-chat-open');

  if (command.action === 'schedule_text') await scheduleText(runtime.page, command, result);
  else if (command.action === 'rich_post') await sendRichPost(runtime.page, command, result);
  else await sendText(runtime.page, command, result);

  result.status = 'pass';
  result.completedAt = new Date().toISOString();
  console.log(`MAX_SEND_RESULT=${result.outcome} action=${command.action} request_id=${command.requestId}`);
} catch (error) {
  result.status = 'fail';
  result.error = { name: error?.name || 'Error', message: String(error?.message || error) };
  result.completedAt = new Date().toISOString();
  if (runtime?.page && captureEnabled) await captureEvidence(runtime.page, artifactDir, '99-failure').catch(() => {});
  console.error(`MAX_SEND_FAILED=${result.error.message}`);
  process.exitCode = 1;
} finally {
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(path.join(artifactDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  if (runtime?.context) await runtime.context.close().catch(() => {});
  if (runtime?.browser) await runtime.browser.close().catch(() => {});
}
