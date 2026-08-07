import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const MESSAGE = process.env.MAX_MESSAGE?.trim() || 'Привет мир';
const TARGET_URL = process.env.MAX_WEB_URL?.trim() || 'https://web.max.ru/';
const ARTIFACT_DIR = path.resolve(process.env.MAX_QR_ARTIFACT_DIR || 'artifacts/max-qr');
const MAX_WAIT_MS = Number(process.env.MAX_QR_WAIT_MS || 9 * 60 * 1000);
const rawSession = String(process.env.MAX_SESSION || '').trim();

await fs.mkdir(ARTIFACT_DIR, { recursive: true });

function appendMissingJsonClosers(value) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{' || character === '[') stack.push(character);
    else if (character === '}' || character === ']') {
      const expected = character === '}' ? '{' : '[';
      if (stack.at(-1) === expected) stack.pop();
    }
  }
  if (inString || stack.length === 0 || stack.length > 8) return value;
  return `${value}${stack.reverse().map((opening) => (opening === '{' ? '}' : ']')).join('')}`;
}

function parseSession(value) {
  if (!value) return { cookies: [], localStorage: [], sessionStorage: [] };
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = JSON.parse(appendMissingJsonClosers(value));
  }
  const entries = (candidate) => {
    if (Array.isArray(candidate)) {
      return candidate
        .filter((entry) => entry && typeof entry.name === 'string')
        .map((entry) => ({ name: entry.name, value: String(entry.value ?? '') }));
    }
    if (candidate && typeof candidate === 'object') {
      return Object.entries(candidate).map(([name, entryValue]) => ({ name, value: String(entryValue ?? '') }));
    }
    return [];
  };
  return {
    cookies: Array.isArray(parsed?.cookies) ? parsed.cookies : [],
    localStorage: entries(parsed?.local_storage ?? parsed?.localStorage),
    sessionStorage: entries(parsed?.session_storage ?? parsed?.sessionStorage),
  };
}

async function firstVisible(locator, limit = 50) {
  const count = Math.min(await locator.count(), limit);
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return null;
}

async function clickBest(locator) {
  const count = Math.min(await locator.count(), 50);
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const box = await item.boundingBox().catch(() => null);
    if (box) candidates.push({ item, box, area: box.width * box.height });
  }
  candidates.sort((a, b) => a.area - b.area || a.box.y - b.box.y);
  for (const candidate of candidates) {
    try {
      await candidate.item.click({ timeout: 5000 });
      return true;
    } catch {}
  }
  return false;
}

async function openSavedChat(page) {
  for (const label of ['Избранное', 'Сохранённые сообщения', 'Saved Messages', 'Favorites']) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const exact = new RegExp(`^\\s*${escaped}\\s*$`, 'i');
    const locators = [
      page.getByRole('link', { name: exact }),
      page.getByRole('button', { name: exact }),
      page.locator(`[aria-label*="${label}" i]`),
      page.locator(`[title*="${label}" i]`),
      page.getByText(label, { exact: true }),
    ];
    for (const locator of locators) {
      if (await clickBest(locator)) {
        await page.waitForTimeout(1500);
        return true;
      }
    }
  }

  const search = await firstVisible(page.locator([
    'input[placeholder*="Поиск" i]',
    'input[aria-label*="Поиск" i]',
    '[role="searchbox"]',
    'input[type="search"]',
  ].join(',')));
  if (search) {
    await search.fill('Избранное');
    await page.waitForTimeout(1800);
    if (await clickBest(page.getByText('Избранное', { exact: true }))) {
      await page.waitForTimeout(1500);
      return true;
    }
  }
  return false;
}

async function findComposer(page) {
  const locator = page.locator('textarea, [contenteditable="true"], input[type="text"], input:not([type]), [role="textbox"]');
  const count = Math.min(await locator.count(), 100);
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const box = await item.boundingBox().catch(() => null);
    if (!box) continue;
    const attrs = await item.evaluate((element) => ({
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') || '',
      placeholder: element.getAttribute('placeholder') || '',
      aria: element.getAttribute('aria-label') || '',
      contenteditable: element.getAttribute('contenteditable') || '',
    })).catch(() => ({}));
    const hint = `${attrs.placeholder || ''} ${attrs.aria || ''} ${attrs.role || ''}`;
    if (/поиск|search|find/i.test(hint)) continue;
    let score = box.y;
    if (/сообщ|message|напиш|текст/i.test(hint)) score += 2000;
    if (attrs.tag === 'textarea') score += 1000;
    if (attrs.contenteditable === 'true') score += 800;
    candidates.push({ item, attrs, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

async function visibleExactCount(page, text) {
  const locator = page.getByText(text, { exact: true });
  const count = Math.min(await locator.count(), 100);
  let visible = 0;
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) visible += 1;
  }
  return visible;
}

async function writeSafeDom(page, name) {
  const data = await page.evaluate(() => {
    const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('button,a,input,textarea,[role],[contenteditable="true"],[aria-label],[title]'))
      .filter((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      })
      .slice(0, 1500)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') || '',
        aria: clean(element.getAttribute('aria-label') || '').slice(0, 120),
        title: clean(element.getAttribute('title') || '').slice(0, 120),
        placeholder: clean(element.getAttribute('placeholder') || '').slice(0, 120),
        text: clean(element.innerText || element.textContent || '').slice(0, 160),
      }));
  });
  await fs.writeFile(path.join(ARTIFACT_DIR, name), `${JSON.stringify(data, null, 2)}\n`);
}

const state = parseSession(rawSession);
const storageState = {
  cookies: state.cookies,
  origins: state.localStorage.length
    ? [{ origin: 'https://web.max.ru', localStorage: state.localStorage }]
    : [],
};

let browser;
let context;
const result = { status: 'starting', message: MESSAGE, startedAt: new Date().toISOString() };

try {
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU', storageState });
  if (state.sessionStorage.length) {
    await context.addInitScript((entries) => {
      if (location.origin !== 'https://web.max.ru') return;
      for (const entry of entries) sessionStorage.setItem(entry.name, entry.value);
    }, state.sessionStorage);
  }
  const page = await context.newPage();
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('#boot-loader'), null, { timeout: 45000 }).catch(() => null);
  await page.waitForTimeout(1200);

  const authText = page.getByText(/Войдите в MAX по QR-коду|Войти по номеру телефона/i);
  if (await firstVisible(authText, 10)) {
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'qr-login.png'), fullPage: false, animations: 'disabled' });
    await writeSafeDom(page, 'qr-dom.json');
    await fs.writeFile(path.join(ARTIFACT_DIR, 'qr-ready'), `${new Date().toISOString()}\n`);
    console.log('MAX_QR_READY=1');

    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      const stillAuth = Boolean(await firstVisible(authText, 10));
      if (!stillAuth) break;
      await page.waitForTimeout(1000);
      if ((deadline - Date.now()) % 15000 < 1200) {
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'qr-login.png'), fullPage: false, animations: 'disabled' }).catch(() => {});
      }
    }
    if (await firstVisible(authText, 10)) throw new Error('Timed out waiting for QR authentication.');
    await page.waitForTimeout(3500);
  }

  result.authenticatedAt = new Date().toISOString();
  await page.screenshot({ path: path.join(ARTIFACT_DIR, '01-authenticated.png'), fullPage: false, animations: 'disabled' });
  await writeSafeDom(page, '01-authenticated-dom.json');

  const opened = await openSavedChat(page);
  if (!opened) throw new Error('Authenticated, but could not open «Избранное».');
  await page.screenshot({ path: path.join(ARTIFACT_DIR, '02-saved-chat.png'), fullPage: false, animations: 'disabled' });

  const composer = await findComposer(page);
  if (!composer) throw new Error('«Избранное» opened, but message composer was not found.');
  const before = await visibleExactCount(page, MESSAGE);
  await composer.item.click();
  if (composer.attrs.tag === 'textarea' || composer.attrs.tag === 'input') await composer.item.fill(MESSAGE);
  else await composer.item.type(MESSAGE, { delay: 20 });
  await page.screenshot({ path: path.join(ARTIFACT_DIR, '03-composed.png'), fullPage: false, animations: 'disabled' });
  await composer.item.press('Enter');
  await page.waitForTimeout(2500);
  const after = await visibleExactCount(page, MESSAGE);
  if (after <= before) {
    const send = await firstVisible(page.getByRole('button', { name: /отправ|send/i }));
    if (send) {
      await send.click();
      await page.waitForTimeout(2500);
    }
  }
  const finalCount = await visibleExactCount(page, MESSAGE);
  if (finalCount <= before) throw new Error('Message was composed, but send confirmation was not visible.');

  result.status = 'sent';
  result.visibleBefore = before;
  result.visibleAfter = finalCount;
  result.completedAt = new Date().toISOString();
  await page.screenshot({ path: path.join(ARTIFACT_DIR, '04-sent.png'), fullPage: false, animations: 'disabled' });
  await writeSafeDom(page, '04-sent-dom.json');
  await fs.writeFile(path.join(ARTIFACT_DIR, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log('MAX_QR_CANARY_RESULT=sent');
} catch (error) {
  result.status = 'failed';
  result.completedAt = new Date().toISOString();
  result.error = { name: error?.name || 'Error', message: String(error?.message || error) };
  await fs.writeFile(path.join(ARTIFACT_DIR, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.error(`MAX_QR_CANARY_FAILED: ${result.error.message}`);
  process.exitCode = 1;
} finally {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  await fs.writeFile(path.join(ARTIFACT_DIR, 'bootstrap-exit-code'), `${process.exitCode || 0}\n`);
}
