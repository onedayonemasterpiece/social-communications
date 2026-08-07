import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { gzipSync } from 'node:zlib';

const TARGET_URL = 'https://web.max.ru/';
const TARGET_ORIGIN = 'https://web.max.ru';
const PROFILE_DIR = path.resolve(process.env.MAX_PROFILE_DIR || '.private/max-playwright-profile');
const OUTPUT_DIR = path.resolve(process.env.MAX_SESSION_OUTPUT_DIR || '.private/max-session');
const AUTH_TIMEOUT_MS = Number(process.env.MAX_AUTH_TIMEOUT_MS || 15 * 60 * 1000);
const GITHUB_SECRET_LIMIT = 48_000;

function storageEntries(value) {
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

async function loginScreenEvidence(page) {
  const bodyText = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
  const hasPhoneInput = await page.locator('input[type="tel"]').first().isVisible().catch(() => false);
  const loginText = /Войдите в MAX|Войти по номеру телефона|Войти в профиль|QR-код/i.test(bodyText);
  return {
    loginScreen: Boolean(hasPhoneInput || loginText),
    title: await page.title().catch(() => ''),
    url: page.url(),
  };
}

async function waitForAuthenticated(page, timeoutMs) {
  const started = Date.now();
  let lastEvidence = null;
  while (Date.now() - started < timeoutMs) {
    lastEvidence = await loginScreenEvidence(page);
    if (!lastEvidence.loginScreen && page.url().startsWith(TARGET_ORIGIN)) return lastEvidence;
    await page.waitForTimeout(1_000);
  }
  throw new Error(`Authentication did not complete within ${Math.round(timeoutMs / 1_000)} seconds. Last URL: ${lastEvidence?.url || 'unknown'}`);
}

async function captureSessionStorage(page) {
  return page.evaluate(() => {
    const result = {};
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key !== null) result[key] = sessionStorage.getItem(key) ?? '';
    }
    return result;
  });
}

async function verifyIsolatedSession(storageState, sessionStorage) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      storageState,
      locale: 'ru-RU',
      viewport: { width: 1440, height: 1000 },
    });
    const entries = storageEntries(sessionStorage);
    if (entries.length) {
      await context.addInitScript((items) => {
        if (location.origin !== 'https://web.max.ru') return;
        for (const item of items) sessionStorage.setItem(item.name, item.value);
      }, entries);
    }

    const page = await context.newPage();
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(8_000);
    const evidence = await loginScreenEvidence(page);
    await context.close();
    if (evidence.loginScreen) {
      throw new Error('Isolated verification opened the MAX login screen. The captured state is not reproducible and was not promoted to max_session.');
    }
    return evidence;
  } finally {
    await browser.close().catch(() => {});
  }
}

await fs.mkdir(PROFILE_DIR, { recursive: true, mode: 0o700 });
await fs.mkdir(OUTPUT_DIR, { recursive: true, mode: 0o700 });

console.log(`MAX session capture profile: ${PROFILE_DIR}`);
console.log('A dedicated Chromium window will open. Use the existing authenticated state in this profile or authenticate once, then leave the window open.');

const persistentContext = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  locale: 'ru-RU',
  viewport: { width: 1440, height: 1000 },
  args: ['--disable-blink-features=AutomationControlled'],
});

try {
  const pages = persistentContext.pages();
  const page = pages[0] || await persistentContext.newPage();
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const initial = await loginScreenEvidence(page);
  if (initial.loginScreen) {
    console.log('MAX login is required in the opened window. Waiting for successful authentication...');
  } else {
    console.log('Authenticated MAX state detected in the dedicated profile.');
  }

  await waitForAuthenticated(page, AUTH_TIMEOUT_MS);
  await page.waitForTimeout(5_000);

  const storageState = await persistentContext.storageState({ indexedDB: true });
  const sessionStorage = await captureSessionStorage(page);
  const envelope = {
    format: 'max-session-v2',
    version: 2,
    origin: TARGET_ORIGIN,
    captured_at: new Date().toISOString(),
    source: 'playwright-persistent-profile',
    storage_state: storageState,
    session_storage: sessionStorage,
  };

  console.log('Captured cookies, localStorage and IndexedDB. Verifying the snapshot in a fresh isolated browser context...');
  const verification = await verifyIsolatedSession(storageState, sessionStorage);
  envelope.verification = {
    isolated_context_authenticated: true,
    verified_at: new Date().toISOString(),
    url: verification.url,
    title: verification.title,
  };

  const json = JSON.stringify(envelope);
  const secretValue = `MAX_SESSION_V2_GZIP_BASE64=${gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64')}`;
  if (secretValue.length > GITHUB_SECRET_LIMIT) {
    throw new Error(`Verified session is ${secretValue.length} characters after compression and exceeds GitHub's repository-secret limit. The value was not written as max_session.txt.`);
  }

  const jsonPath = path.join(OUTPUT_DIR, 'max_session.json');
  const secretPath = path.join(OUTPUT_DIR, 'max_session.txt');
  const receiptPath = path.join(OUTPUT_DIR, 'receipt.json');
  await fs.writeFile(jsonPath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
  await fs.writeFile(secretPath, secretValue, { mode: 0o600 });
  await fs.writeFile(receiptPath, `${JSON.stringify({
    format: envelope.format,
    version: envelope.version,
    capturedAt: envelope.captured_at,
    verified: true,
    cookies: storageState.cookies?.length || 0,
    origins: storageState.origins?.length || 0,
    indexedDbOrigins: (storageState.origins || []).filter((origin) => Array.isArray(origin.indexedDB) && origin.indexedDB.length > 0).length,
    sessionStorageEntries: Object.keys(sessionStorage).length,
    secretCharacters: secretValue.length,
    output: {
      secret: secretPath,
      backup: jsonPath,
    },
  }, null, 2)}\n`, { mode: 0o600 });

  console.log('MAX_SESSION_CAPTURE_RESULT=verified');
  console.log(`Secret value file: ${secretPath}`);
  console.log(`Backup state file: ${jsonPath}`);
  console.log('Replace the GitHub repository secret max_session with the complete contents of max_session.txt.');
} finally {
  await persistentContext.close().catch(() => {});
}
