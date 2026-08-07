import { chromium } from 'playwright';

const raw = String(process.env.MAX_SESSION || '').trim();
let sessionStorageEntries = [];

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
      sessionStorageEntries = toStorageEntries(sessionStorageSource);
      const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];

      if (localStorage.length || sessionStorageEntries.length || Object.hasOwn(parsed, 'cookies')) {
        process.env.MAX_SESSION = JSON.stringify({
          cookies,
          origins: localStorage.length
            ? [{ origin: 'https://web.max.ru', localStorage }]
            : [],
        });
        console.log(
          `MAX_SESSION_ADAPTED=1 local_storage=${localStorage.length} session_storage=${sessionStorageEntries.length} cookies=${cookies.length}`,
        );
      }
    }
  } catch (error) {
    console.log(`MAX_SESSION_ADAPTED=0 reason=${error?.name || 'Error'}`);
  }
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

        page.goto = async (...gotoArgs) => {
          const response = await originalGoto(...gotoArgs);
          await page.waitForFunction(() => {
            const loader = document.querySelector('#boot-loader');
            if (!loader) return true;
            const style = getComputedStyle(loader);
            const box = loader.getBoundingClientRect();
            return style.display === 'none' || style.visibility === 'hidden' || box.width === 0 || box.height === 0;
          }, null, { timeout: 30000 }).catch(() => null);
          await page.waitForTimeout(1500);
          return response;
        };

        return page;
      };

      return context;
    };

    return browser;
  };
  console.log(`MAX_BROWSER_ADAPTER_READY=1 session_storage=${sessionStorageEntries.length}`);
} catch (error) {
  console.log(`MAX_BROWSER_ADAPTER_READY=0 reason=${error?.name || 'Error'}`);
}

await import('./max-web-canary.mjs');
