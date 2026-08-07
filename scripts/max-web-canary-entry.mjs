import { chromium } from 'playwright';
import { gunzipSync } from 'node:zlib';

const TARGET_ORIGIN = 'https://web.max.ru';
const rawSecret = String(process.env.MAX_SESSION || '').trim();
let sessionStorageEntries = [];
let genericIndexedDb = [];
let contract = 'unknown';

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

function stripAssignmentPrefix(value) {
  const prefixes = ['MAX_SESSION=', 'max_session=', 'SESSION=', 'session='];
  for (const prefix of prefixes) {
    if (value.startsWith(prefix)) return value.slice(prefix.length).trim();
  }
  return value;
}

function decodeV2Secret(value) {
  const gzipPrefix = 'MAX_SESSION_V2_GZIP_BASE64=';
  const jsonPrefix = 'MAX_SESSION_V2_JSON=';
  if (value.startsWith(gzipPrefix)) {
    const encoded = value.slice(gzipPrefix.length).replace(/\s+/g, '');
    if (!encoded) throw new Error('MAX_SESSION_V2_GZIP_BASE64 is empty.');
    return gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8');
  }
  if (value.startsWith(jsonPrefix)) return value.slice(jsonPrefix.length).trim();
  return stripAssignmentPrefix(value);
}

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

function parseJsonStrict(value) {
  try {
    return { parsed: JSON.parse(value), repaired: false };
  } catch (directError) {
    const repairedValue = appendMissingJsonClosers(value);
    if (repairedValue === value) throw directError;
    try {
      return { parsed: JSON.parse(repairedValue), repaired: true };
    } catch {
      throw directError;
    }
  }
}

function validatePlaywrightStorageState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Array.isArray(value.cookies) && Array.isArray(value.origins);
}

function countIndexedDbInStorageState(storageState) {
  return (storageState.origins || []).reduce(
    (sum, origin) => sum + (Array.isArray(origin.indexedDB) ? origin.indexedDB.length : 0),
    0,
  );
}

function adaptSession() {
  if (!rawSecret) throw new Error('GitHub Actions secret max_session is empty or unavailable.');

  const decoded = decodeV2Secret(rawSecret);
  const { parsed, repaired } = parseJsonStrict(decoded);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('max_session must decode to a JSON object.');
  }

  if (parsed.format === 'max-session-v2' && Number(parsed.version) === 2) {
    if (repaired) throw new Error('max-session-v2 JSON is truncated or malformed; refusing a repaired authentication state.');
    if (parsed.origin && parsed.origin !== TARGET_ORIGIN) {
      throw new Error(`max-session-v2 origin mismatch: expected ${TARGET_ORIGIN}.`);
    }

    sessionStorageEntries = toStorageEntries(parsed.session_storage ?? parsed.sessionStorage);

    if (validatePlaywrightStorageState(parsed.storage_state)) {
      const storageState = parsed.storage_state;
      process.env.MAX_SESSION = JSON.stringify(storageState);
      contract = 'v2-playwright-storage-state';
      console.log(
        `MAX_SESSION_CONTRACT=${contract} cookies=${storageState.cookies.length} origins=${storageState.origins.length} indexed_db=${countIndexedDbInStorageState(storageState)} session_storage=${sessionStorageEntries.length}`,
      );
      return;
    }

    const localStorage = toStorageEntries(parsed.local_storage ?? parsed.localStorage);
    const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];
    genericIndexedDb = Array.isArray(parsed.indexed_db ?? parsed.indexedDB)
      ? (parsed.indexed_db ?? parsed.indexedDB)
      : [];

    if (!cookies.length && !localStorage.length && !sessionStorageEntries.length && !genericIndexedDb.length) {
      throw new Error('max-session-v2 contains no browser state.');
    }

    process.env.MAX_SESSION = JSON.stringify({
      cookies,
      origins: localStorage.length ? [{ origin: TARGET_ORIGIN, localStorage }] : [],
    });
    contract = 'v2-browser-export';
    console.log(
      `MAX_SESSION_CONTRACT=${contract} cookies=${cookies.length} local_storage=${localStorage.length} session_storage=${sessionStorageEntries.length} indexed_db=${genericIndexedDb.length}`,
    );
    return;
  }

  if (validatePlaywrightStorageState(parsed)) {
    if (repaired) throw new Error('Playwright storageState JSON is truncated or malformed; refusing a repaired authentication state.');
    process.env.MAX_SESSION = JSON.stringify(parsed);
    contract = 'playwright-storage-state';
    console.log(
      `MAX_SESSION_CONTRACT=${contract} cookies=${parsed.cookies.length} origins=${parsed.origins.length} indexed_db=${countIndexedDbInStorageState(parsed)}`,
    );
    return;
  }

  const localStorage = toStorageEntries(parsed.local_storage ?? parsed.localStorage);
  sessionStorageEntries = toStorageEntries(parsed.session_storage ?? parsed.sessionStorage);
  const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];
  const indexedDb = Array.isArray(parsed.indexed_db ?? parsed.indexedDB)
    ? (parsed.indexed_db ?? parsed.indexedDB)
    : [];

  if (repaired || (!cookies.length && !indexedDb.length)) {
    throw new Error(
      'Legacy max_session is not a reproducible authenticated session: it is malformed or contains no cookies/IndexedDB. Export max-session-v2 from an authenticated MAX Web tab.',
    );
  }

  genericIndexedDb = indexedDb;
  process.env.MAX_SESSION = JSON.stringify({
    cookies,
    origins: localStorage.length ? [{ origin: TARGET_ORIGIN, localStorage }] : [],
  });
  contract = 'legacy-browser-export';
  console.log(
    `MAX_SESSION_CONTRACT=${contract} cookies=${cookies.length} local_storage=${localStorage.length} session_storage=${sessionStorageEntries.length} indexed_db=${genericIndexedDb.length}`,
  );
}

adaptSession();

async function restoreGenericIndexedDb(page, databases) {
  return page.evaluate(async ({ databases: payload, typeMarker }) => {
    const base64ToBytes = (base64) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes;
    };

    const decode = (value) => {
      if (Array.isArray(value)) return value.map(decode);
      if (!value || typeof value !== 'object') return value;
      const kind = value[typeMarker];
      if (!kind) return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [key, decode(entryValue)]));
      if (kind === 'Undefined') return undefined;
      if (kind === 'BigInt') return BigInt(value.value);
      if (kind === 'Date') return new Date(value.value);
      if (kind === 'RegExp') return new RegExp(value.source, value.flags || '');
      if (kind === 'ArrayBuffer') return base64ToBytes(value.base64).buffer;
      if (kind === 'TypedArray') {
        const bytes = base64ToBytes(value.base64);
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        if (value.constructor === 'DataView') return new DataView(buffer);
        const Constructor = globalThis[value.constructor] || Uint8Array;
        return new Constructor(buffer);
      }
      if (kind === 'Blob') return new Blob([base64ToBytes(value.base64)], { type: value.mimeType || '' });
      if (kind === 'Map') return new Map((value.entries || []).map(([key, entryValue]) => [decode(key), decode(entryValue)]));
      if (kind === 'Set') return new Set((value.values || []).map(decode));
      return value.value;
    };

    const requestResult = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
    });
    const transactionDone = (transaction) => new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
    });
    const deleteDatabase = (name) => new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error(`Cannot delete IndexedDB database ${name}.`));
      request.onblocked = () => reject(new Error(`IndexedDB database ${name} is blocked during restore.`));
    });

    let storeCount = 0;
    let recordCount = 0;
    for (const descriptor of payload) {
      if (!descriptor?.name || !Array.isArray(descriptor.stores)) continue;
      await deleteDatabase(descriptor.name).catch(() => {});
      const openRequest = indexedDB.open(descriptor.name, Math.max(1, Number(descriptor.version) || 1));
      openRequest.onupgradeneeded = () => {
        const database = openRequest.result;
        for (const storeDescriptor of descriptor.stores) {
          const options = { autoIncrement: Boolean(storeDescriptor.autoIncrement) };
          if (storeDescriptor.keyPath !== null && storeDescriptor.keyPath !== undefined) {
            options.keyPath = storeDescriptor.keyPath;
          }
          const store = database.createObjectStore(storeDescriptor.name, options);
          for (const indexDescriptor of storeDescriptor.indexes || []) {
            store.createIndex(indexDescriptor.name, indexDescriptor.keyPath, {
              unique: Boolean(indexDescriptor.unique),
              multiEntry: Boolean(indexDescriptor.multiEntry),
            });
          }
        }
      };
      const database = await requestResult(openRequest);
      try {
        for (const storeDescriptor of descriptor.stores) {
          const transaction = database.transaction(storeDescriptor.name, 'readwrite');
          const store = transaction.objectStore(storeDescriptor.name);
          for (const record of storeDescriptor.records || []) {
            const decodedValue = decode(record.value);
            if (store.keyPath === null) store.put(decodedValue, decode(record.key));
            else store.put(decodedValue);
            recordCount += 1;
          }
          await transactionDone(transaction);
          storeCount += 1;
        }
      } finally {
        database.close();
      }
    }
    return { databases: payload.length, stores: storeCount, records: recordCount };
  }, { databases, typeMarker: '__maxSessionType' });
}

try {
  const originalLaunch = chromium.launch.bind(chromium);
  chromium.launch = async (...launchArgs) => {
    const browser = await originalLaunch(...launchArgs);
    const originalNewContext = browser.newContext.bind(browser);

    browser.newContext = async (...contextArgs) => {
      const context = await originalNewContext(...contextArgs);

      if (sessionStorageEntries.length) {
        await context.addInitScript((entries) => {
          if (location.origin !== 'https://web.max.ru') return;
          for (const entry of entries) sessionStorage.setItem(entry.name, entry.value);
        }, sessionStorageEntries);
      }

      const originalNewPage = context.newPage.bind(context);
      context.newPage = async (...pageArgs) => {
        const page = await originalNewPage(...pageArgs);
        const originalGoto = page.goto.bind(page);
        let indexedDbRestored = false;

        page.goto = async (...gotoArgs) => {
          const destination = String(gotoArgs[0] || '');
          if (!indexedDbRestored && genericIndexedDb.length && destination.startsWith(TARGET_ORIGIN)) {
            const bootstrapUrl = `${TARGET_ORIGIN}/__max_session_bootstrap__`;
            const handler = async (route) => route.fulfill({
              status: 200,
              contentType: 'text/html; charset=utf-8',
              body: '<!doctype html><meta charset="utf-8"><title>MAX session bootstrap</title>',
            });
            await page.route(bootstrapUrl, handler);
            try {
              await originalGoto(bootstrapUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
              const restored = await restoreGenericIndexedDb(page, genericIndexedDb);
              console.log(
                `MAX_INDEXED_DB_RESTORED=1 databases=${restored.databases} stores=${restored.stores} records=${restored.records}`,
              );
              indexedDbRestored = true;
            } finally {
              await page.unroute(bootstrapUrl, handler).catch(() => {});
            }
          }

          const response = await originalGoto(...gotoArgs);
          await page.waitForFunction(() => {
            const loader = document.querySelector('#boot-loader');
            if (!loader) return true;
            const style = getComputedStyle(loader);
            const box = loader.getBoundingClientRect();
            return style.display === 'none' || style.visibility === 'hidden' || box.width === 0 || box.height === 0;
          }, null, { timeout: 30_000 }).catch(() => null);
          await page.waitForTimeout(1_500);
          return response;
        };

        return page;
      };

      return context;
    };

    return browser;
  };
  console.log(
    `MAX_BROWSER_ADAPTER_READY=1 contract=${contract} session_storage=${sessionStorageEntries.length} generic_indexed_db=${genericIndexedDb.length}`,
  );
} catch (error) {
  console.log(`MAX_BROWSER_ADAPTER_READY=0 reason=${error?.name || 'Error'}`);
}

await import('./max-web-canary.mjs');
