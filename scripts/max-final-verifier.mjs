import { launchAuthenticatedMax } from './max-runtime.mjs';
import { resolveDestination } from './max-destination.mjs';
import { normalizeText } from './max-ui.mjs';
import { verifyRichPostInOpenChat } from './max-rich-post-verifier.mjs';

export async function verifyTextInOpenChat(page, text) {
  const expected = normalizeText(text);
  return page.evaluate((expectedText) => {
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
    const matches = Array.from(document.querySelectorAll('[role="listitem"]'))
      .filter(visible)
      .map((element) => {
        const bodyText = clean(element.innerText || element.textContent || '');
        const box = element.getBoundingClientRect();
        return {
          bodyText,
          matched: bodyText.includes(expectedText),
          box: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
        };
      })
      .filter((candidate) => candidate.matched);
    return {
      found: matches.length > 0,
      count: matches.length,
      last: matches.at(-1) || null,
    };
  }, expected);
}

export async function waitForFinalContentInOpenChat(page, content, timeoutMs = 20_000) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = content.type === 'rich_post'
      ? await verifyRichPostInOpenChat(page, {
        text: content.text,
        links: content.links,
      })
      : await verifyTextInOpenChat(page, content.text);
    if (last.found) return last;
    await page.waitForTimeout(500);
  }
  return last || { found: false, count: 0, last: null };
}

export async function verifyFinalContentWithFreshSession(command, resolvedTitle, options = {}) {
  let runtime;
  try {
    runtime = await launchAuthenticatedMax({ timezoneId: command.delivery.timeZone });
    const destination = await resolveDestination(runtime.page, {
      exactTitle: resolvedTitle,
      kind: command.destination.kind,
    });
    const verification = await waitForFinalContentInOpenChat(
      runtime.page,
      command.content,
      options.timeoutMs || 20_000,
    );
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
