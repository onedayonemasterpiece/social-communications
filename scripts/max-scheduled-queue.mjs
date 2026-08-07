import { launchAuthenticatedMax } from './max-runtime.mjs';
import { contentMatchesContainer } from './max-composer.mjs';
import { resolveDestination } from './max-destination.mjs';
import { findSendButton, firstVisible, normalizeText } from './max-ui.mjs';

const RUSSIAN_MONTHS = new Map([
  ['Январь', 1], ['Февраль', 2], ['Март', 3], ['Апрель', 4], ['Май', 5], ['Июнь', 6],
  ['Июль', 7], ['Август', 8], ['Сентябрь', 9], ['Октябрь', 10], ['Ноябрь', 11], ['Декабрь', 12],
]);

const SCHEDULED_VIEW_TITLES = [
  'Отложенные сообщения',
  'Запланированные посты',
  'Запланированные сообщения',
];

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

export function zonedTime(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

export function defaultParkingTimestamp() {
  const date = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

async function chooseCalendarMonth(page, target) {
  const monthPattern = /^(Январь|Февраль|Март|Апрель|Май|Июнь|Июль|Август|Сентябрь|Октябрь|Ноябрь|Декабрь)\s+(\d{4})$/;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const title = await firstVisible(page.getByText(monthPattern), 50);
    if (!title) throw new Error('MAX schedule month title was not found.');
    const text = normalizeText(await title.innerText());
    const match = text.match(monthPattern);
    if (!match) throw new Error(`Cannot parse MAX schedule month title: ${text}`);
    const current = { month: RUSSIAN_MONTHS.get(match[1]), year: Number(match[2]) };
    const currentIndex = current.year * 12 + current.month;
    const targetIndex = target.year * 12 + target.month;
    if (currentIndex === targetIndex) return text;
    const direction = targetIndex > currentIndex ? 'Следующий месяц' : 'Предыдущий месяц';
    await page.getByRole('button', { name: direction, exact: true }).click();
    await page.waitForTimeout(350);
  }
  throw new Error('MAX schedule month navigation exceeded 30 steps.');
}

async function setSpinbutton(page, label, value) {
  const expected = String(value).padStart(2, '0');
  const spin = page.getByRole('spinbutton', { name: label, exact: true });
  await spin.waitFor({ state: 'visible' });
  await spin.click();
  await spin.press('Control+A').catch(() => {});
  await spin.pressSequentially(expected, { delay: 80 });
  await page.waitForTimeout(300);
  const actual = normalizeText(await spin.textContent());
  if (actual !== expected) throw new Error(`MAX ${label} spinbutton expected ${expected}, received ${actual}.`);
}

async function findVisibleContextAction(page, labels) {
  for (const label of labels) {
    const locators = [
      page.getByRole('menuitem', { name: label, exact: true }),
      page.getByRole('button', { name: label, exact: true }),
      page.getByText(label, { exact: true }),
    ];
    for (const locator of locators) {
      const action = await firstVisible(locator, 100);
      if (action) return { action, label };
    }
  }
  return null;
}

async function contextDiagnostics(page, target) {
  const targetSummary = await target.evaluate((element) => ({
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role') || '',
    aria: element.getAttribute('aria-label') || '',
    title: element.getAttribute('title') || '',
    text: String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    className: String(element.className || '').slice(0, 240),
  })).catch(() => null);
  const overlays = await page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && box.width > 0 && box.height > 0;
    };
    const selector = '[role="menu"], [role="dialog"], [data-radix-popper-content-wrapper], [class*="popover" i], [class*="menu" i]';
    return Array.from(document.querySelectorAll(selector))
      .filter(visible)
      .map((element) => clean(element.innerText || element.textContent || ''))
      .filter(Boolean)
      .slice(0, 20);
  }).catch(() => []);
  return { target: targetSummary, overlays };
}

async function openContextAction(page, target, labels) {
  const gestures = [
    async () => target.click({ button: 'right' }),
    async () => {
      const box = await target.boundingBox();
      if (!box) throw new Error('MAX context target has no bounding box.');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    },
    async () => {
      await target.focus();
      await page.keyboard.press('Shift+F10');
    },
    async () => target.dispatchEvent('contextmenu', { bubbles: true, button: 2, buttons: 2 }),
  ];

  for (const gesture of gestures) {
    await page.keyboard.press('Escape').catch(() => {});
    await gesture().catch(() => {});
    await page.waitForTimeout(600);
    const found = await findVisibleContextAction(page, labels);
    if (found) return found;
  }

  const diagnostics = await contextDiagnostics(page, target);
  throw new Error(
    `MAX context action «${labels.join('»/«')}» was not found. `
      + `Target=${JSON.stringify(diagnostics.target)} overlays=${JSON.stringify(diagnostics.overlays)}`,
  );
}

export async function schedulePreparedComposer(page, scheduleAt, timeZone = 'Europe/Kaliningrad') {
  const scheduleDate = scheduleAt instanceof Date ? scheduleAt : new Date(scheduleAt);
  if (Number.isNaN(scheduleDate.getTime())) throw new Error(`Invalid MAX schedule timestamp: ${scheduleAt}.`);
  if (scheduleDate.getTime() < Date.now() + 60_000) {
    throw new Error('MAX schedule timestamp must be at least one minute in the future.');
  }
  const target = zonedParts(scheduleDate, timeZone);
  const send = await findSendButton(page);
  const { action: menuItem } = await openContextAction(page, send, [
    'Запланировать пост',
    'Отправить позже',
    'Запланировать отправку',
    'Запланировать',
  ]);
  await menuItem.click();

  const monthTitle = await chooseCalendarMonth(page, target);
  const day = page
    .locator('button.day:not(.day--otherMonth):not(.day--disabled)')
    .filter({ hasText: new RegExp(`^${target.day}$`) });
  if (await day.count() !== 1) {
    throw new Error(`Expected exactly one selectable MAX calendar day ${target.day}, found ${await day.count()}.`);
  }
  await day.click();
  await setSpinbutton(page, 'Часы', target.hour);
  await setSpinbutton(page, 'Минуты', target.minute);

  const expectedTime = `${String(target.hour).padStart(2, '0')}:${String(target.minute).padStart(2, '0')}`;
  const confirm = page.getByRole('button', {
    name: new RegExp(`^Отправить .+ в ${escapeRegex(expectedTime)}$`),
  });
  await confirm.waitFor({ state: 'visible' });
  const confirmationText = normalizeText(await confirm.innerText());
  if (!confirmationText.includes(expectedTime)) {
    throw new Error(`MAX schedule confirmation does not contain ${expectedTime}: ${confirmationText}`);
  }
  await confirm.click();
  await confirm.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1_500);
  const legacyDialogVisible = await page.getByText('Отправить позже', { exact: true }).isVisible().catch(() => false);
  const postDialogVisible = await page.getByText('Запланировать пост', { exact: true }).isVisible().catch(() => false);
  if (legacyDialogVisible || postDialogVisible) throw new Error('MAX schedule dialog remained visible after confirmation.');

  return {
    scheduleAt: scheduleDate.toISOString(),
    timeZone,
    target,
    expectedTime,
    monthTitle,
    confirmationText,
  };
}

async function findScheduledViewTitle(page) {
  for (const title of SCHEDULED_VIEW_TITLES) {
    const visible = await firstVisible(page.getByText(title, { exact: true }), 100);
    if (visible) return { locator: visible, title };
  }
  return null;
}

async function scheduledControlDiagnostics(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) > 0
        && box.width > 0
        && box.height > 0
        && box.x > 470;
    };
    return Array.from(document.querySelectorAll('button, [role="button"], [aria-label], [title]'))
      .filter(visible)
      .map((element) => ({
        aria: clean(element.getAttribute('aria-label') || ''),
        title: clean(element.getAttribute('title') || ''),
        text: clean(element.innerText || element.textContent || ''),
      }))
      .filter((item) => /отлож|заплан|распис|пост/i.test(`${item.aria} ${item.title} ${item.text}`))
      .slice(0, 30);
  }).catch(() => []);
}

export async function openScheduledMessages(page, options = {}) {
  const existing = await findScheduledViewTitle(page);
  if (existing) return { alreadyOpen: true, absent: false, title: existing.title, diagnostics: [] };

  let scheduledButton = await firstVisible(page.locator([
    'button[aria-label="Открыть отложенные сообщения"]',
    'button[aria-label*="отлож" i]',
    'button[title*="отлож" i]',
    'button[aria-label*="заплан" i]',
    'button[title*="заплан" i]',
    '[role="button"][aria-label*="отлож" i]',
    '[role="button"][aria-label*="заплан" i]',
  ].join(',')), 100);

  if (!scheduledButton) {
    for (const label of SCHEDULED_VIEW_TITLES) {
      scheduledButton = await firstVisible(page.getByRole('button', { name: label, exact: true }), 50)
        || await firstVisible(page.getByText(label, { exact: true }), 100);
      if (scheduledButton) break;
    }
  }

  if (!scheduledButton) {
    const diagnostics = await scheduledControlDiagnostics(page);
    if (options.allowMissing) {
      return { alreadyOpen: false, absent: true, title: null, diagnostics };
    }
    throw new Error(`MAX scheduled-messages control was not found. candidates=${JSON.stringify(diagnostics)}`);
  }

  await scheduledButton.click();
  await page.waitForTimeout(1_200);
  const opened = await findScheduledViewTitle(page);
  if (!opened) {
    const diagnostics = await scheduledControlDiagnostics(page);
    throw new Error(`MAX scheduled-messages view did not open. candidates=${JSON.stringify(diagnostics)}`);
  }
  return { alreadyOpen: false, absent: false, title: opened.title, diagnostics: [] };
}

async function visibleListItems(page) {
  const locator = page.locator('[role="listitem"], [role="presentation"]');
  const count = Math.min(await locator.count(), 800);
  const items = [];
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const box = await item.boundingBox().catch(() => null);
    if (!box || box.x < 470 || box.width < 80 || box.height < 30) continue;
    items.push(item);
  }
  return items;
}

function emptyScheduledVerification(expectedTime, queue = null) {
  return {
    found: false,
    ambiguous: false,
    count: 0,
    expectedTime,
    match: null,
    matches: [],
    queue,
  };
}

export async function findScheduledContent(page, content, options = {}) {
  const expectedTime = options.scheduleAt
    ? zonedTime(new Date(options.scheduleAt), options.timeZone || 'Europe/Kaliningrad')
    : null;
  const opened = await openScheduledMessages(page, { allowMissing: true });
  if (opened.absent) return emptyScheduledVerification(expectedTime, opened);

  const matches = [];
  const exactText = normalizeText(content.text);
  for (const item of await visibleListItems(page)) {
    const bodyText = normalizeText(await item.innerText().catch(() => ''));
    if (!bodyText.includes(exactText)) continue;
    if (expectedTime && !bodyText.includes(expectedTime)) continue;
    const structure = await contentMatchesContainer(item, content);
    if (!structure.matched) continue;
    matches.push({ item, bodyText, structure, box: await item.boundingBox() });
  }
  return {
    found: matches.length === 1,
    ambiguous: matches.length > 1,
    count: matches.length,
    expectedTime,
    match: matches.length === 1 ? matches[0] : null,
    matches: matches.map((candidate) => ({
      bodyText: candidate.bodyText.slice(0, 1_000),
      structure: candidate.structure,
      box: candidate.box,
    })),
    queue: opened,
  };
}

export async function sendScheduledNow(page, scheduledMatch) {
  const item = scheduledMatch?.item;
  if (!item) throw new Error('MAX sendScheduledNow requires a unique scheduled message locator.');
  const { action: menuItem } = await openContextAction(page, item, ['Отправить сейчас']);
  await menuItem.click();
  await page.waitForTimeout(2_000);
  if (await item.isVisible().catch(() => false)) {
    throw new Error('MAX scheduled message remained visible after «Отправить сейчас».');
  }
  return { sentNow: true };
}

export async function deleteScheduledMessage(page, scheduledMatch) {
  const item = scheduledMatch?.item;
  if (!item) return { deleted: false, reason: 'scheduled-item-absent' };
  try {
    const { action: deleteItem } = await openContextAction(page, item, ['Удалить']);
    await deleteItem.click();
    await page.waitForTimeout(500);
    const confirm = await firstVisible(page.getByRole('button', { name: 'Удалить', exact: true }), 20);
    if (confirm) await confirm.click();
    await page.waitForTimeout(1_000);
    return {
      deleted: !(await item.isVisible().catch(() => false)),
      reason: 'delete-menu-completed',
    };
  } catch (error) {
    return { deleted: false, reason: String(error?.message || error) };
  }
}

export async function verifyScheduledWithFreshSession(command, resolvedTitle, scheduleAt) {
  let runtime;
  try {
    runtime = await launchAuthenticatedMax({ timezoneId: command.delivery.timeZone });
    const destination = await resolveDestination(runtime.page, {
      exactTitle: resolvedTitle,
      kind: command.destination.kind,
    });
    const verification = await findScheduledContent(runtime.page, command.content, {
      scheduleAt,
      timeZone: command.delivery.timeZone,
    });
    return {
      ...verification,
      destination,
      session: runtime.session.counts,
    };
  } finally {
    if (runtime?.context) await runtime.context.close().catch(() => {});
    if (runtime?.browser) await runtime.browser.close().catch(() => {});
  }
}
