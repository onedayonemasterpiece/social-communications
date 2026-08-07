import { chromium } from 'playwright';
import { gunzipSync } from 'node:zlib';

export const TARGET_URL = process.env.MAX_WEB_URL?.trim() || 'https://web.max.ru/';
export const TARGET_ORIGIN = new URL(TARGET_URL).origin;

function stripKnownAssignment(value) {
  let current = String(value ?? '').trim();
  for (let depth = 0; depth < 3; depth += 1) {
    const match = current.match(/^(?:MAX_SESSION|MAX_SESSION_V2|max_session|session)\s*=\s*(.+)$/s);
    if (!match) break;
    current = match[1].trim();
  }
  return current;
}

function decodeEnvelope(rawValue) {
  const raw = stripKnownAssignment(rawValue);
  const gzipPrefix = 'MAX_SESSION_V2_GZIP_BASE64=';
  const jsonPrefix = 'MAX_SESSION_V2_JSON=';

  if (raw.startsWith(gzipPrefix)) {
    const encoded = raw.slice(gzipPrefix.length).replace(/\s+/g, '');
    if (!encoded) throw new Error('MAX_SESSION_V2_GZIP_BASE64 is empty.');
    return JSON.parse(gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8'));
  }
  if (raw.startsWith(jsonPrefix)) return JSON.parse(raw.slice(jsonPrefix.length));
  return JSON.parse(raw);
}

function toStorageEntries(value) {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => entry && typeof entry.name === 'string')
      .map((entry) => ({ name: entry.name, value: String(entry.value ?? '') }));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([name, entryValue]) => ({ name, value: String(entryValue ?? '') }));
  }
  return [];
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
  if (!name) return null;

  const normalized = {
    name,
    value: String(cookie.value ?? ''),
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
    normalized.path = String(cookie.path || '/');
  }

  return normalized;
}

export function loadSession(rawValue = process.env.MAX_SESSION) {
  if (!String(rawValue ?? '').trim()) throw new Error('Repository secret MAX_SESSION is empty.');
  const parsed = decodeEnvelope(rawValue);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MAX_SESSION must decode to a JSON object.');
  }

  let storageState;
  let sessionStorage;
  let contract;

  if (parsed.format === 'max-session-v2' && Number(parsed.version) === 2) {
    if (parsed.origin && parsed.origin !== TARGET_ORIGIN) {
      throw new Error(`MAX session origin mismatch: expected ${TARGET_ORIGIN}, received ${parsed.origin}.`);
    }
    sessionStorage = toStorageEntries(parsed.session_storage ?? parsed.sessionStorage);
    if (parsed.storage_state && Array.isArray(parsed.storage_state.cookies) && Array.isArray(parsed.storage_state.origins)) {
      storageState = parsed.storage_state;
      contract = 'max-session-v2/playwright-storage-state';
    } else {
      const cookies = (Array.isArray(parsed.cookies) ? parsed.cookies : []).map(normalizeCookie).filter(Boolean);
      const localStorage = toStorageEntries(parsed.local_storage ?? parsed.localStorage);
      storageState = {
        cookies,
        origins: localStorage.length ? [{ origin: TARGET_ORIGIN, localStorage }] : [],
      };
      contract = 'max-session-v2/browser-export';
    }
  } else if (Array.isArray(parsed.cookies) && Array.isArray(parsed.origins)) {
    storageState = {
      ...parsed,
      cookies: parsed.cookies.map(normalizeCookie).filter(Boolean),
    };
    sessionStorage = [];
    contract = 'playwright-storage-state';
  } else {
    throw new Error('Unsupported MAX_SESSION contract. Expected max-session-v2 or Playwright storageState.');
  }

  storageState = {
    ...storageState,
    cookies: (storageState.cookies || []).map(normalizeCookie).filter(Boolean),
  };

  return {
    contract,
    storageState,
    sessionStorage,
    counts: {
      cookies: storageState.cookies.length,
      origins: storageState.origins.length,
      localStorage: storageState.origins.reduce((sum, origin) => sum + (origin.localStorage?.length || 0), 0),
      sessionStorage: sessionStorage.length,
    },
  };
}

export async function launchAuthenticatedMax(options = {}) {
  const session = loadSession();
  const browser = await chromium.launch({
    headless: options.headless ?? true,
    args: ['--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    viewport: options.viewport || { width: 1440, height: 1000 },
    locale: options.locale || 'ru-RU',
    timezoneId: options.timezoneId || 'Europe/Kaliningrad',
    storageState: session.storageState,
    permissions: ['clipboard-read', 'clipboard-write'],
  });

  if (session.sessionStorage.length) {
    await context.addInitScript(({ origin, entries }) => {
      if (location.origin !== origin) return;
      for (const entry of entries) sessionStorage.setItem(entry.name, entry.value);
    }, { origin: TARGET_ORIGIN, entries: session.sessionStorage });
  }

  const page = await context.newPage();
  page.setDefaultTimeout(options.defaultTimeoutMs || 15_000);
  page.setDefaultNavigationTimeout(options.navigationTimeoutMs || 60_000);
  const response = await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

  await page.waitForFunction(() => {
    const loader = document.querySelector('#boot-loader');
    if (!loader) return true;
    const style = getComputedStyle(loader);
    const box = loader.getBoundingClientRect();
    return style.display === 'none' || style.visibility === 'hidden' || box.width === 0 || box.height === 0;
  }, null, { timeout: 30_000 }).catch(() => null);
  await page.waitForTimeout(2_000);

  const bodyText = await page.locator('body').innerText().catch(() => '');
  const phoneVisible = await page.locator('input[type="tel"]').first().isVisible().catch(() => false);
  if (phoneVisible || /Войдите в MAX|Войти по номеру телефона|Войти в профиль|Сканируйте QR/i.test(bodyText)) {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw new Error('MAX_SESSION did not restore an authenticated MAX Web session.');
  }

  return {
    browser,
    context,
    page,
    session,
    navigation: {
      url: page.url(),
      status: response?.status() ?? null,
      title: await page.title().catch(() => ''),
    },
  };
}
