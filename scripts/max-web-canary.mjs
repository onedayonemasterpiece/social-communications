import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const TARGET_URL = process.env.MAX_WEB_URL?.trim() || 'https://web.max.ru/';
const MESSAGE = process.env.MAX_MESSAGE?.trim() || 'Привет мир';
const RUN_ID = process.env.GITHUB_RUN_ID?.trim() || `local-${Date.now()}`;
const ARTIFACT_DIR = path.resolve(process.env.MAX_ARTIFACT_DIR || 'artifacts/max-web');
const sessionSecret = process.env.MAX_SESSION?.trim() || '';

await fs.mkdir(ARTIFACT_DIR, { recursive: true });

const result = {
  runId: RUN_ID,
  targetUrl: TARGET_URL,
  message: MESSAGE,
  startedAt: new Date().toISOString(),
  status: 'started',
  session: null,
  navigation: null,
  savedChat: null,
  composer: null,
  verification: null,
};

function compactWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function redactDiagnosticText(value) {
  return compactWhitespace(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(?:\+?\d[\d\s()\-]{7,}\d)/g, '[phone-or-id]')
    .slice(0, 180);
}

function normalizeSameSite(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'strict') return 'Strict';
  if (normalized === 'none' || normalized === 'no_restriction') return 'None';
  return 'Lax';
}

function normalizeCookie(cookie) {
  if (!cookie || typeof cookie !== 'object') return null;
  const name = String(cookie.name ?? '').trim();
  const value = String(cookie.value ?? '');
  if (!name) return null;

  const normalized = {
    name,
    value,
    path: String(cookie.path || '/'),
    httpOnly: Boolean(cookie.httpOnly),
    secure: cookie.secure !== false,
    sameSite: normalizeSameSite(cookie.sameSite),
  };

  const expires = Number(cookie.expires ?? cookie.expirationDate);
  if (Number.isFinite(expires) && expires > 0) normalized.expires = expires;

  if (cookie.url) {
    normalized.url = String(cookie.url);
  } else {
    normalized.domain = String(cookie.domain || '.max.ru');
  }

  return normalized;
}

function parseCookieHeader(raw) {
  const cookies = [];
  for (const segment of raw.split(';')) {
    const index = segment.indexOf('=');
    if (index <= 0) continue;
    const name = segment.slice(0, index).trim();
    const value = segment.slice(index + 1).trim();
    if (!name || /^(path|domain|expires|max-age|secure|httponly|samesite)$/i.test(name)) continue;
    cookies.push({
      name,
      value,
      domain: '.max.ru',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'Lax',
    });
  }
  return cookies;
}

function parseNetscapeCookies(raw) {
  const cookies = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 7) continue;
    const [domain, , cookiePath, secure, expires, name, value] = parts;
    cookies.push({
      name,
      value,
      domain,
      path: cookiePath || '/',
      secure: secure === 'TRUE',
      httpOnly: false,
      sameSite: 'Lax',
      ...(Number(expires) > 0 ? { expires: Number(expires) } : {}),
    });
  }
  return cookies;
}

function maybeDecodeBase64(raw) {
  const compact = raw.replace(/\s+/g, '');
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/_=-]+$/.test(compact)) return null;
  try {
    const decoded = Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8').trim();
    return decoded && decoded !== raw ? decoded : null;
  } catch {
    return null;
  }
}

function parseSessionObject(value, source = 'json') {
  if (typeof value === 'string') return parseSessionSecret(value, `${source}-string`);

  if (Array.isArray(value)) {
    const cookies = value.map(normalizeCookie).filter(Boolean);
    if (!cookies.length) throw new Error('Session JSON array did not contain recognizable cookies.');
    return {
      storageState: { cookies: [], origins: [] },
      extraCookies: cookies,
      description: `${source}:cookie-array`,
    };
  }

  if (!value || typeof value !== 'object') {
    throw new Error('Session secret is neither a JSON object, cookie array, nor cookie header.');
  }

  for (const key of ['storageState', 'state', 'session']) {
    if (value[key]) return parseSessionObject(value[key], `${source}.${key}`);
  }

  if (Array.isArray(value.cookies) || Array.isArray(value.origins)) {
    const normalizedCookies = (value.cookies || []).map(normalizeCookie).filter(Boolean);
    const stateCookies = normalizedCookies.filter((cookie) => cookie.domain && !cookie.url);
    const extraCookies = normalizedCookies.filter((cookie) => cookie.url);
    const origins = Array.isArray(value.origins) ? value.origins : [];
    return {
      storageState: { cookies: stateCookies, origins },
      extraCookies,
      description: `${source}:playwright-storage-state`,
    };
  }

  if (typeof value.cookies === 'string') {
    const cookies = parseCookieHeader(value.cookies).map(normalizeCookie).filter(Boolean);
    if (cookies.length) {
      return {
        storageState: { cookies, origins: [] },
        extraCookies: [],
        description: `${source}:cookie-header-field`,
      };
    }
  }

  if (value.localStorage && typeof value.localStorage === 'object') {
    const entries = Array.isArray(value.localStorage)
      ? value.localStorage
          .filter((entry) => entry && typeof entry.name === 'string')
          .map((entry) => ({ name: entry.name, value: String(entry.value ?? '') }))
      : Object.entries(value.localStorage).map(([name, entryValue]) => ({ name, value: String(entryValue ?? '') }));
    return {
      storageState: {
        cookies: [],
        origins: [{ origin: 'https://web.max.ru', localStorage: entries }],
      },
      extraCookies: [],
      description: `${source}:local-storage`,
    };
  }

  const entries = Object.entries(value).filter(([, entryValue]) => ['string', 'number', 'boolean'].includes(typeof entryValue));
  if (entries.length && entries.length === Object.keys(value).length) {
    return {
      storageState: {
        cookies: [],
        origins: [{
          origin: 'https://web.max.ru',
          localStorage: entries.map(([name, entryValue]) => ({ name, value: String(entryValue) })),
        }],
      },
      extraCookies: [],
      description: `${source}:plain-local-storage-map`,
    };
  }

  throw new Error(`Unsupported session JSON structure. Top-level keys: ${Object.keys(value).slice(0, 20).join(', ')}`);
}

function parseSessionSecret(raw, source = 'raw') {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('GitHub Actions secret max_session is empty or unavailable.');

  const unwrapped = trimmed.startsWith('MAX_SESSION=') ? trimmed.slice('MAX_SESSION='.length).trim() : trimmed;

  try {
    return parseSessionObject(JSON.parse(unwrapped), `${source}:json`);
  } catch (error) {
    if (!String(error?.message || '').includes('Unexpected token') && !String(error?.message || '').includes('JSON')) {
      if (/^[\[{\"]/.test(unwrapped)) throw error;
    }
  }

  const decoded = maybeDecodeBase64(unwrapped);
  if (decoded) {
    try {
      return parseSessionObject(JSON.parse(decoded), `${source}:base64-json`);
    } catch (error) {
      if (/^[\[{\"]/.test(decoded)) throw error;
    }
  }

  const netscapeCookies = parseNetscapeCookies(unwrapped).map(normalizeCookie).filter(Boolean);
  if (netscapeCookies.length) {
    return {
      storageState: { cookies: netscapeCookies, origins: [] },
      extraCookies: [],
      description: `${source}:netscape-cookie-file`,
    };
  }

  const headerCookies = parseCookieHeader(unwrapped).map(normalizeCookie).filter(Boolean);
  if (headerCookies.length) {
    return {
      storageState: { cookies: headerCookies, origins: [] },
      extraCookies: [],
      description: `${source}:cookie-header`,
    };
  }

  throw new Error('Unsupported max_session format. Expected Playwright storageState JSON, cookie JSON, base64 JSON, Netscape cookies, or a Cookie header.');
}

async function screenshot(page, fileName, options = {}) {
  try {
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, fileName),
      fullPage: options.fullPage ?? false,
      animations: 'disabled',
    });
  } catch (error) {
    await fs.appendFile(path.join(ARTIFACT_DIR, 'capture-errors.log'), `screenshot ${fileName}: ${error.message}\n`);
  }
}

async function writeDomSummary(page, fileName) {
  try {
    const summary = await page.evaluate(() => {
      const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
      };
      const pathFor = (element) => {
        const pieces = [];
        let current = element;
        for (let depth = 0; current && current !== document.body && depth < 6; depth += 1) {
          let piece = current.tagName.toLowerCase();
          if (current.id) piece += `#${current.id}`;
          const role = current.getAttribute('role');
          if (role) piece += `[role=${role}]`;
          const aria = current.getAttribute('aria-label');
          if (aria) piece += `[aria-label=${clean(aria).slice(0, 60)}]`;
          pieces.unshift(piece);
          current = current.parentElement;
        }
        return pieces.join(' > ');
      };

      const interactiveSelector = [
        'a', 'button', 'input', 'textarea', '[role]', '[contenteditable="true"]',
        '[aria-label]', '[title]', '[data-testid]', '[tabindex]'
      ].join(',');
      const rows = [];
      const elements = Array.from(document.querySelectorAll(interactiveSelector));
      for (const element of elements) {
        if (!visible(element)) continue;
        const rect = element.getBoundingClientRect();
        const text = clean(element.innerText || element.textContent || '');
        rows.push({
          path: pathFor(element),
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role') || '',
          aria: element.getAttribute('aria-label') || '',
          title: element.getAttribute('title') || '',
          placeholder: element.getAttribute('placeholder') || '',
          testid: element.getAttribute('data-testid') || '',
          text: text.slice(0, 180),
          box: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
        });
        if (rows.length >= 2500) break;
      }
      return {
        url: location.href,
        title: document.title,
        viewport: { width: innerWidth, height: innerHeight },
        rows,
      };
    });

    const lines = [
      `URL: ${summary.url}`,
      `TITLE: ${summary.title}`,
      `VIEWPORT: ${summary.viewport.width}x${summary.viewport.height}`,
      `VISIBLE INTERACTIVE NODES: ${summary.rows.length}`,
      '',
    ];
    for (const row of summary.rows) {
      const metadata = [
        row.role && `role=${row.role}`,
        row.aria && `aria=${redactDiagnosticText(row.aria)}`,
        row.title && `title=${redactDiagnosticText(row.title)}`,
        row.placeholder && `placeholder=${redactDiagnosticText(row.placeholder)}`,
        row.testid && `testid=${redactDiagnosticText(row.testid)}`,
        row.text && `text=${redactDiagnosticText(row.text)}`,
      ].filter(Boolean).join(' | ');
      lines.push(`${JSON.stringify(row.box)} ${row.path}${metadata ? ` :: ${metadata}` : ''}`);
    }
    await fs.writeFile(path.join(ARTIFACT_DIR, fileName), lines.join('\n'));
  } catch (error) {
    await fs.appendFile(path.join(ARTIFACT_DIR, 'capture-errors.log'), `DOM ${fileName}: ${error.message}\n`);
  }
}

async function firstVisible(locator, limit = 30) {
  const count = Math.min(await locator.count(), limit);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

async function visibleExactTextCount(page, text) {
  const locator = page.getByText(text, { exact: true });
  const count = Math.min(await locator.count(), 100);
  let visibleCount = 0;
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) visibleCount += 1;
  }
  return visibleCount;
}

async function hasRecentExactMessage(page, text) {
  const locator = page.getByText(text, { exact: true });
  const count = Math.min(await locator.count(), 100);
  const viewport = page.viewportSize() || { width: 1440, height: 1000 };
  for (let index = count - 1; index >= 0; index -= 1) {
    const item = locator.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const box = await item.boundingBox().catch(() => null);
    if (box && box.y > viewport.height * 0.55) return true;
  }
  return false;
}

async function clickBestCandidate(locator, description) {
  const count = Math.min(await locator.count(), 50);
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const box = await item.boundingBox().catch(() => null);
    if (!box) continue;
    candidates.push({ item, box, index, area: box.width * box.height });
  }
  candidates.sort((a, b) => a.area - b.area || a.box.x - b.box.x || a.box.y - b.box.y);
  for (const candidate of candidates) {
    try {
      await candidate.item.scrollIntoViewIfNeeded().catch(() => {});
      await candidate.item.click({ timeout: 5000 });
      return { description, index: candidate.index, box: candidate.box };
    } catch {
      // Try the next matching node; text is often duplicated in nested wrappers.
    }
  }
  return null;
}

async function openSavedChat(page) {
  const labels = ['Избранное', 'Сохранённые сообщения', 'Saved Messages', 'Favorites'];
  for (const label of labels) {
    const regexp = new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
    const strategies = [
      [`role-link:${label}`, page.getByRole('link', { name: regexp })],
      [`role-button:${label}`, page.getByRole('button', { name: regexp })],
      [`aria:${label}`, page.locator(`[aria-label*="${label}" i]`)],
      [`title:${label}`, page.locator(`[title*="${label}" i]`)],
      [`exact-text:${label}`, page.getByText(label, { exact: true })],
    ];
    for (const [description, locator] of strategies) {
      const clicked = await clickBestCandidate(locator, description);
      if (clicked) {
        await page.waitForTimeout(1800);
        return clicked;
      }
    }
  }

  const searchCandidates = page.locator([
    'input[placeholder*="Поиск" i]',
    'input[aria-label*="Поиск" i]',
    '[role="searchbox"]',
    'input[type="search"]',
  ].join(','));
  const search = await firstVisible(searchCandidates);
  if (search) {
    await search.fill('Избранное');
    await page.waitForTimeout(1800);
    const clicked = await clickBestCandidate(page.getByText('Избранное', { exact: true }), 'search-result:Избранное');
    if (clicked) {
      await page.waitForTimeout(1800);
      return clicked;
    }
  }

  return null;
}

async function findComposer(page) {
  const locator = page.locator('textarea, [contenteditable="true"], input[type="text"], input:not([type]), [role="textbox"]');
  const count = Math.min(await locator.count(), 100);
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    if (!(await item.isEnabled().catch(() => true))) continue;
    const box = await item.boundingBox().catch(() => null);
    if (!box) continue;
    const attributes = await item.evaluate((element) => ({
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') || '',
      placeholder: element.getAttribute('placeholder') || '',
      aria: element.getAttribute('aria-label') || '',
      contenteditable: element.getAttribute('contenteditable') || '',
      type: element.getAttribute('type') || '',
    })).catch(() => ({}));
    const hint = compactWhitespace(`${attributes.placeholder || ''} ${attributes.aria || ''} ${attributes.role || ''}`);
    if (/поиск|search|find/i.test(hint)) continue;
    let score = box.y;
    if (/сообщ|message|напиш|текст/i.test(hint)) score += 2000;
    if (attributes.tag === 'textarea') score += 1000;
    if (attributes.contenteditable === 'true') score += 800;
    if (attributes.role === 'textbox') score += 500;
    candidates.push({ item, index, box, attributes, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

async function typeMessage(composer, message) {
  const { item, attributes } = composer;
  await item.scrollIntoViewIfNeeded().catch(() => {});
  await item.click({ timeout: 5000 });
  if (attributes.tag === 'textarea' || attributes.tag === 'input') {
    await item.fill(message);
  } else {
    await item.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    await item.press('Backspace').catch(() => {});
    await item.type(message, { delay: 25 });
  }
}

async function composerText(composer) {
  return composer.item.evaluate((element) => {
    if ('value' in element) return String(element.value || '');
    return String(element.innerText || element.textContent || '');
  }).catch(() => '');
}

async function clickSendButton(page) {
  const strategies = [
    page.getByRole('button', { name: /отправ|send/i }),
    page.locator('button[aria-label*="Отправ" i], button[title*="Отправ" i], [role="button"][aria-label*="Отправ" i]'),
  ];
  for (const locator of strategies) {
    const button = await firstVisible(locator);
    if (!button) continue;
    try {
      await button.click({ timeout: 5000 });
      return true;
    } catch {
      // Try another selector.
    }
  }
  return false;
}

let browser;
let context;
let page;
let traceStarted = false;

try {
  const parsedSession = parseSessionSecret(sessionSecret);
  result.session = {
    format: parsedSession.description,
    cookieCount: parsedSession.storageState.cookies.length + parsedSession.extraCookies.length,
    originCount: parsedSession.storageState.origins.length,
  };

  browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'ru-RU',
    timezoneId: 'Europe/Kaliningrad',
    storageState: parsedSession.storageState,
  });
  if (parsedSession.extraCookies.length) await context.addCookies(parsedSession.extraCookies);

  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  traceStarted = true;

  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(60000);

  const response = await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  result.navigation = {
    finalUrl: page.url(),
    httpStatus: response?.status() ?? null,
    title: await page.title(),
  };

  await screenshot(page, '01-loaded.png');
  await writeDomSummary(page, '01-dom-summary.txt');

  const authMarkers = [
    page.getByText(/войти|авторизац|номер телефона|qr-код|сканируйте/i),
    page.locator('input[type="tel"]'),
  ];
  let unauthenticated = false;
  for (const marker of authMarkers) {
    if (await firstVisible(marker, 10)) {
      unauthenticated = true;
      break;
    }
  }
  if (unauthenticated) {
    throw new Error('MAX Web opened an authentication screen; max_session did not restore an authenticated session.');
  }

  const savedChat = await openSavedChat(page);
  if (!savedChat) {
    throw new Error('Could not find or open the «Избранное» chat using visible roles, labels, text, or search.');
  }
  result.savedChat = savedChat;
  await screenshot(page, '02-saved-chat-open.png');
  await writeDomSummary(page, '02-dom-summary-saved-chat.txt');

  const composer = await findComposer(page);
  if (!composer) {
    throw new Error('«Избранное» opened, but no visible message composer was found.');
  }
  result.composer = {
    index: composer.index,
    box: composer.box,
    tag: composer.attributes.tag,
    role: composer.attributes.role,
    placeholder: redactDiagnosticText(composer.attributes.placeholder),
    aria: redactDiagnosticText(composer.attributes.aria),
  };

  const visibleBefore = await visibleExactTextCount(page, MESSAGE);
  if (await hasRecentExactMessage(page, MESSAGE)) {
    result.status = 'already_present';
    result.verification = {
      exactVisibleBefore: visibleBefore,
      exactVisibleAfter: visibleBefore,
      skippedToAvoidDuplicate: true,
    };
  } else {
    await typeMessage(composer, MESSAGE);
    await screenshot(page, '03-message-composed.png');

    await composer.item.press('Enter');
    await page.waitForTimeout(2500);

    let visibleAfter = await visibleExactTextCount(page, MESSAGE);
    let remainingComposerText = compactWhitespace(await composerText(composer));
    if (visibleAfter <= visibleBefore && remainingComposerText.includes(MESSAGE)) {
      const clicked = await clickSendButton(page);
      if (clicked) await page.waitForTimeout(2500);
      visibleAfter = await visibleExactTextCount(page, MESSAGE);
      remainingComposerText = compactWhitespace(await composerText(composer));
    }

    const sent = visibleAfter > visibleBefore || (visibleAfter > 0 && !remainingComposerText.includes(MESSAGE));
    result.verification = {
      exactVisibleBefore: visibleBefore,
      exactVisibleAfter: visibleAfter,
      composerCleared: !remainingComposerText.includes(MESSAGE),
      skippedToAvoidDuplicate: false,
    };
    if (!sent) throw new Error('The message was composed, but the UI did not provide evidence that it was sent.');
    result.status = 'sent';
  }

  await screenshot(page, '04-final.png');
  await writeDomSummary(page, '04-dom-summary-final.txt');
  result.completedAt = new Date().toISOString();
  await fs.writeFile(path.join(ARTIFACT_DIR, 'result.json'), JSON.stringify(result, null, 2));
  console.log(`MAX_CANARY_RESULT=${result.status}`);
} catch (error) {
  result.status = 'failed';
  result.completedAt = new Date().toISOString();
  result.error = {
    name: error?.name || 'Error',
    message: String(error?.message || error),
  };
  if (page) {
    await screenshot(page, '99-failure.png');
    await writeDomSummary(page, '99-dom-summary-failure.txt');
  }
  await fs.writeFile(path.join(ARTIFACT_DIR, 'result.json'), JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(ARTIFACT_DIR, 'failure.txt'), `${result.error.name}: ${result.error.message}\n`);
  console.error(`MAX_CANARY_FAILED: ${result.error.message}`);
  process.exitCode = 1;
} finally {
  if (context && traceStarted) {
    await context.tracing.stop({ path: path.join(ARTIFACT_DIR, 'trace.zip') }).catch(async (error) => {
      await fs.appendFile(path.join(ARTIFACT_DIR, 'capture-errors.log'), `trace: ${error.message}\n`);
    });
  }
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
}
