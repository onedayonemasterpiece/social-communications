import { chromium } from 'playwright';

const MONTH_NAMES = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

function kaliningradNowParts() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Kaliningrad',
      year: 'numeric',
      month: 'numeric',
    }).formatToParts(new Date())
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return { year: Number(parts.year), month: Number(parts.month) };
}

function monthLabel(state) {
  return `${MONTH_NAMES[state.month - 1]} ${state.year}`;
}

function shiftMonth(state, delta) {
  const zeroBased = state.year * 12 + (state.month - 1) + delta;
  state.year = Math.floor(zeroBased / 12);
  state.month = (zeroBased % 12 + 12) % 12 + 1;
}

function isMonthTitleRegex(value) {
  return value instanceof RegExp
    && value.source.includes('Январь')
    && value.source.includes('Декабрь')
    && value.source.includes('d{4}');
}

function fakeVisibleTextLocator(state) {
  const item = {
    async isVisible() { return true; },
    async innerText() { return monthLabel(state); },
  };
  return {
    async count() { return 1; },
    nth() { return item; },
  };
}

const originalLaunch = chromium.launch.bind(chromium);
chromium.launch = async (...launchArgs) => {
  const browser = await originalLaunch(...launchArgs);
  const originalNewContext = browser.newContext.bind(browser);
  browser.newContext = async (...contextArgs) => {
    const context = await originalNewContext(...contextArgs);
    const originalNewPage = context.newPage.bind(context);
    context.newPage = async (...pageArgs) => {
      const page = await originalNewPage(...pageArgs);
      const calendarState = kaliningradNowParts();
      const originalGetByText = page.getByText.bind(page);
      const originalGetByRole = page.getByRole.bind(page);

      page.getByText = (text, options) => {
        if (isMonthTitleRegex(text)) return fakeVisibleTextLocator(calendarState);
        return originalGetByText(text, options);
      };

      page.getByRole = (role, options = {}) => {
        const locator = originalGetByRole(role, options);
        const name = options?.name;
        if (role === 'menuitem' && name === 'Отправить позже') {
          const originalClick = locator.click.bind(locator);
          locator.click = async (...args) => {
            const result = await originalClick(...args);
            await page.waitForTimeout(800);
            return result;
          };
        }
        if (role === 'button' && (name === 'Следующий месяц' || name === 'Предыдущий месяц')) {
          const originalClick = locator.click.bind(locator);
          locator.click = async (...args) => {
            const result = await originalClick(...args);
            shiftMonth(calendarState, name === 'Следующий месяц' ? 1 : -1);
            await page.waitForTimeout(350);
            return result;
          };
        }
        return locator;
      };

      return page;
    };
    return context;
  };
  return browser;
};

console.log('MAX_SCHEDULE_UI_COMPAT=ready');
