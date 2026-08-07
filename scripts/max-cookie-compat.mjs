import { chromium } from 'playwright';

function normalizeCookie(cookie) {
  if (!cookie || typeof cookie !== 'object') return cookie;

  const normalized = { ...cookie };
  if (normalized.url) {
    delete normalized.domain;
    delete normalized.path;
  } else {
    normalized.domain = String(normalized.domain || '.max.ru');
    normalized.path = String(normalized.path || '/');
  }
  return normalized;
}

const originalLaunch = chromium.launch.bind(chromium);
chromium.launch = async (...launchArgs) => {
  const browser = await originalLaunch(...launchArgs);
  const originalNewContext = browser.newContext.bind(browser);

  browser.newContext = async (...contextArgs) => {
    const context = await originalNewContext(...contextArgs);
    const originalAddCookies = context.addCookies.bind(context);

    context.addCookies = async (cookies) => {
      const normalized = Array.isArray(cookies) ? cookies.map(normalizeCookie) : cookies;
      return originalAddCookies(normalized);
    };

    return context;
  };

  return browser;
};
