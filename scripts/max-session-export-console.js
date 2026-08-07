/*
 * MAX Web authenticated-session exporter.
 * Run this file as a Chrome/Edge DevTools Snippet while the already-authenticated
 * https://web.max.ru/ tab is active. It exports localStorage, sessionStorage,
 * non-HttpOnly cookies and IndexedDB into a gzip+base64 secret value.
 */
(async () => {
  'use strict';

  const EXPECTED_ORIGIN = 'https://web.max.ru';
  const FORMAT = 'max-session-v2';
  const VERSION = 2;
  const MAX_RECORDS_PER_STORE = 50_000;
  const MAX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
  const GITHUB_SECRET_LIMIT = 48_000;
  const TYPE = '__maxSessionType';

  if (location.origin !== EXPECTED_ORIGIN) {
    throw new Error(`Open ${EXPECTED_ORIGIN}/ first. Current origin: ${location.origin}`);
  }

  const loginText = document.body?.innerText || '';
  if (/Войдите в MAX|Войти по номеру телефона|Войти в профиль/i.test(loginText)) {
    throw new Error('The current MAX Web tab is not authenticated. Authenticate in this tab before exporting.');
  }

  function bytesToBase64(bytes) {
    const chunkSize = 0x8000;
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
    }
    return btoa(binary);
  }

  async function encode(value, seen = new WeakSet()) {
    if (value === undefined) return { [TYPE]: 'Undefined' };
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'bigint') return { [TYPE]: 'BigInt', value: value.toString() };
    if (typeof value !== 'object') return { [TYPE]: 'Unsupported', valueType: typeof value };
    if (seen.has(value)) throw new Error('Cannot export a circular IndexedDB value.');
    seen.add(value);

    try {
      if (value instanceof Date) return { [TYPE]: 'Date', value: value.toISOString() };
      if (value instanceof RegExp) return { [TYPE]: 'RegExp', source: value.source, flags: value.flags };
      if (value instanceof ArrayBuffer) {
        return { [TYPE]: 'ArrayBuffer', base64: bytesToBase64(new Uint8Array(value)) };
      }
      if (ArrayBuffer.isView(value)) {
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        return {
          [TYPE]: 'TypedArray',
          constructor: value.constructor?.name || 'Uint8Array',
          base64: bytesToBase64(bytes),
        };
      }
      if (value instanceof Blob) {
        return {
          [TYPE]: 'Blob',
          mimeType: value.type,
          base64: bytesToBase64(new Uint8Array(await value.arrayBuffer())),
        };
      }
      if (value instanceof Map) {
        const entries = [];
        for (const [key, entryValue] of value.entries()) {
          entries.push([await encode(key, seen), await encode(entryValue, seen)]);
        }
        return { [TYPE]: 'Map', entries };
      }
      if (value instanceof Set) {
        const values = [];
        for (const entryValue of value.values()) values.push(await encode(entryValue, seen));
        return { [TYPE]: 'Set', values };
      }
      if (Array.isArray(value)) {
        const result = [];
        for (const item of value) result.push(await encode(item, seen));
        return result;
      }

      const result = {};
      for (const [key, entryValue] of Object.entries(value)) result[key] = await encode(entryValue, seen);
      return result;
    } finally {
      seen.delete(value);
    }
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
    });
  }

  async function openDatabase(name) {
    const request = indexedDB.open(name);
    return requestResult(request);
  }

  async function exportStore(database, storeName) {
    const transaction = database.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const metadata = {
      name: store.name,
      keyPath: store.keyPath,
      autoIncrement: store.autoIncrement,
      indexes: Array.from(store.indexNames).map((indexName) => {
        const index = store.index(indexName);
        return {
          name: index.name,
          keyPath: index.keyPath,
          unique: index.unique,
          multiEntry: index.multiEntry,
        };
      }),
      records: [],
    };

    await new Promise((resolve, reject) => {
      const request = store.openCursor();
      request.onerror = () => reject(request.error || new Error(`Cannot read IndexedDB store ${storeName}.`));
      request.onsuccess = async () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        if (metadata.records.length >= MAX_RECORDS_PER_STORE) {
          reject(new Error(`IndexedDB store ${storeName} exceeds ${MAX_RECORDS_PER_STORE} records; refusing a partial export.`));
          return;
        }
        try {
          metadata.records.push({
            key: await encode(cursor.key),
            primaryKey: await encode(cursor.primaryKey),
            value: await encode(cursor.value),
          });
          cursor.continue();
        } catch (error) {
          reject(error);
        }
      };
    });

    await transactionDone(transaction);
    return metadata;
  }

  async function exportIndexedDb() {
    if (typeof indexedDB.databases !== 'function') {
      throw new Error('This browser does not support indexedDB.databases(); use current Chrome or Edge.');
    }

    const descriptors = await indexedDB.databases();
    const databases = [];
    for (const descriptor of descriptors) {
      if (!descriptor?.name) continue;
      const database = await openDatabase(descriptor.name);
      try {
        const exported = {
          name: database.name,
          version: database.version,
          stores: [],
        };
        for (const storeName of Array.from(database.objectStoreNames)) {
          exported.stores.push(await exportStore(database, storeName));
        }
        databases.push(exported);
      } finally {
        database.close();
      }
    }
    return databases;
  }

  function storageToObject(storage) {
    const result = {};
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null) result[key] = storage.getItem(key) ?? '';
    }
    return result;
  }

  function documentCookies() {
    if (!document.cookie) return [];
    return document.cookie.split(/;\s*/).flatMap((pair) => {
      const separator = pair.indexOf('=');
      if (separator <= 0) return [];
      return [{
        name: pair.slice(0, separator),
        value: pair.slice(separator + 1),
        url: `${EXPECTED_ORIGIN}/`,
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'Lax',
      }];
    });
  }

  async function gzipBase64(text) {
    if (typeof CompressionStream !== 'function') {
      throw new Error('CompressionStream is unavailable; use current Chrome or Edge.');
    }
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    return bytesToBase64(compressed);
  }

  function downloadText(filename, text, type = 'text/plain;charset=utf-8') {
    const href = URL.createObjectURL(new Blob([text], { type }));
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 5_000);
  }

  console.log('[MAX session] Exporting IndexedDB. Keep this tab open.');
  const indexedDb = await exportIndexedDb();
  const payload = {
    format: FORMAT,
    version: VERSION,
    origin: EXPECTED_ORIGIN,
    captured_at: new Date().toISOString(),
    source: 'browser-console',
    cookies: documentCookies(),
    local_storage: storageToObject(localStorage),
    session_storage: storageToObject(sessionStorage),
    indexed_db: indexedDb,
  };

  const json = JSON.stringify(payload);
  if (json.length > MAX_UNCOMPRESSED_BYTES) {
    throw new Error(`Session export is unexpectedly large (${json.length} bytes); refusing to create an unreviewed secret.`);
  }

  const secret = `MAX_SESSION_V2_GZIP_BASE64=${await gzipBase64(json)}`;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  downloadText(`max_session-${timestamp}.txt`, secret);
  downloadText(`max_session-${timestamp}.json`, `${JSON.stringify(payload, null, 2)}\n`, 'application/json');

  let copied = false;
  try {
    await navigator.clipboard.writeText(secret);
    copied = true;
  } catch {
    // The downloaded .txt file remains the authoritative output.
  }

  const databaseCount = indexedDb.length;
  const storeCount = indexedDb.reduce((sum, database) => sum + database.stores.length, 0);
  const recordCount = indexedDb.reduce(
    (sum, database) => sum + database.stores.reduce((storeSum, store) => storeSum + store.records.length, 0),
    0,
  );
  const summary = {
    format: FORMAT,
    version: VERSION,
    origin: EXPECTED_ORIGIN,
    cookies: payload.cookies.length,
    localStorageEntries: Object.keys(payload.local_storage).length,
    sessionStorageEntries: Object.keys(payload.session_storage).length,
    indexedDbDatabases: databaseCount,
    indexedDbStores: storeCount,
    indexedDbRecords: recordCount,
    uncompressedBytes: json.length,
    secretCharacters: secret.length,
    fitsGitHubRepositorySecret: secret.length <= GITHUB_SECRET_LIMIT,
    copiedToClipboard: copied,
    downloadedFiles: 2,
  };

  console.table(summary);
  if (secret.length > GITHUB_SECRET_LIMIT) {
    console.error(`[MAX session] The compressed value is ${secret.length} characters and exceeds GitHub's repository-secret limit. Do not paste a truncated value.`);
  } else {
    console.log('[MAX session] Export complete. Replace the repository secret max_session with the full contents of the downloaded .txt file.');
  }

  return summary;
})();
