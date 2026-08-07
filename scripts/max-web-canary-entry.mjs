const raw = String(process.env.MAX_SESSION || '').trim();

function appendMissingJsonClosers(value) {
  const stack = [];
  let inString = false;
  let escaped = false;

  for (const character of value) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === '{' || character === '[') {
      stack.push(character);
    } else if (character === '}' || character === ']') {
      const expected = character === '}' ? '{' : '[';
      if (stack.at(-1) === expected) stack.pop();
    }
  }

  if (inString || stack.length === 0 || stack.length > 8) return value;
  return `${value}${stack.reverse().map((opening) => (opening === '{' ? '}' : ']')).join('')}`;
}

function parseMaybeTruncatedJson(value) {
  try {
    return JSON.parse(value);
  } catch (directError) {
    const repaired = appendMissingJsonClosers(value);
    if (repaired === value) throw directError;
    return JSON.parse(repaired);
  }
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

if (raw.startsWith('{') || raw.startsWith('[')) {
  try {
    const parsed = parseMaybeTruncatedJson(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const localStorageSource = parsed.local_storage ?? parsed.localStorage;
      const sessionStorageSource = parsed.session_storage ?? parsed.sessionStorage;
      const localStorage = toStorageEntries(localStorageSource);
      const sessionStorage = toStorageEntries(sessionStorageSource);
      const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];

      if (localStorage.length || sessionStorage.length || Object.hasOwn(parsed, 'cookies')) {
        process.env.MAX_SESSION = JSON.stringify({
          cookies,
          origins: localStorage.length
            ? [{ origin: 'https://web.max.ru', localStorage }]
            : [],
        });
        process.env.MAX_SESSION_STORAGE = JSON.stringify(sessionStorage);
        console.log(
          `MAX_SESSION_ADAPTED=1 local_storage=${localStorage.length} session_storage=${sessionStorage.length} cookies=${cookies.length}`,
        );
      }
    }
  } catch (error) {
    console.log(`MAX_SESSION_ADAPTED=0 reason=${error?.name || 'Error'}`);
  }
}

await import('./max-web-canary.mjs');
