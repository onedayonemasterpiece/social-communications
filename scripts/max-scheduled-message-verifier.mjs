import { launchAuthenticatedMax } from './max-runtime.mjs';
import { firstVisible, normalizeText, openChatByExactTitle } from './max-ui.mjs';

function zonedTime(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('ru-RU', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

export async function verifyScheduledMessageInOpenChat(page, command) {
  const scheduledButton = await firstVisible(page.locator([
    'button[aria-label="Открыть отложенные сообщения"]',
    'button[aria-label*="отложенные сообщения" i]',
  ].join(',')));
  if (!scheduledButton) {
    return { found: false, reason: 'scheduled-messages-button-absent', count: 0, last: null };
  }

  await scheduledButton.click();
  await page.waitForTimeout(1_200);

  const expectedText = normalizeText(command.text);
  const expectedTime = zonedTime(
    new Date(command.scheduleAt),
    command.timeZone || 'Europe/Kaliningrad',
  );

  return page.evaluate(({ expectedText: text, expectedTime: time }) => {
    const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) > 0
        && box.width > 0
        && box.height > 0;
    };

    const matches = Array.from(document.querySelectorAll('[role="listitem"], [role="presentation"]'))
      .filter(visible)
      .map((element) => {
        const bodyText = clean(element.innerText || element.textContent || '');
        const box = element.getBoundingClientRect();
        return {
          bodyText,
          textMatched: bodyText.includes(text),
          timeMatched: bodyText.includes(time),
          box: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
        };
      })
      .filter((candidate) => candidate.textMatched && candidate.timeMatched);

    return {
      found: matches.length > 0,
      expectedTime: time,
      count: matches.length,
      last: matches.at(-1) || null,
      titleVisible: Array.from(document.querySelectorAll('*'))
        .filter(visible)
        .some((element) => clean(element.textContent || '') === 'Отложенные сообщения'),
    };
  }, { expectedText, expectedTime });
}

export async function verifyScheduledMessageWithFreshSession(command) {
  let runtime;
  try {
    runtime = await launchAuthenticatedMax({
      timezoneId: command.timeZone || 'Europe/Kaliningrad',
    });
    const chat = await openChatByExactTitle(runtime.page, command.chat.title);
    const verification = await verifyScheduledMessageInOpenChat(runtime.page, command);
    return {
      ...verification,
      chat,
      session: runtime.session.counts,
    };
  } finally {
    if (runtime?.context) await runtime.context.close().catch(() => {});
    if (runtime?.browser) await runtime.browser.close().catch(() => {});
  }
}
