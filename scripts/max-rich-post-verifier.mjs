import { launchAuthenticatedMax } from './max-runtime.mjs';
import { normalizeText, openChatByExactTitle } from './max-ui.mjs';

function canonicalUrl(value) {
  return new URL(value).href;
}

export async function verifyRichPostInOpenChat(page, command) {
  const expectedText = normalizeText(command.text);
  const expectedLinks = (command.links || []).map((link) => ({
    text: normalizeText(link.text),
    url: canonicalUrl(link.url),
  }));

  return page.evaluate(({ expectedText: text, expectedLinks: links }) => {
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

    const candidates = Array.from(document.querySelectorAll('[role="listitem"]'))
      .filter(visible)
      .map((element) => {
        const bodyText = clean(element.innerText || element.textContent || '');
        const anchorEvidence = links.map((expected) => Array.from(element.querySelectorAll('a')).some((anchor) => {
          const anchorText = clean(anchor.innerText || anchor.textContent || '');
          let href = '';
          try { href = new URL(anchor.getAttribute('href') || anchor.href, location.href).href; } catch {}
          return anchorText === expected.text && href === expected.url;
        }));
        const media = Boolean(element.querySelector(
          'img, video, canvas, [aria-label="Прикрепленные фото"], [aria-label*="Прикреплен" i]',
        ));
        const box = element.getBoundingClientRect();
        return {
          bodyText,
          textMatched: bodyText.includes(text),
          links: anchorEvidence,
          media,
          box: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
        };
      })
      .filter((candidate) => candidate.textMatched && candidate.links.every(Boolean) && candidate.media);

    return {
      found: candidates.length > 0,
      count: candidates.length,
      last: candidates.at(-1) || null,
    };
  }, { expectedText, expectedLinks });
}

export async function waitForRichPostInOpenChat(page, command, timeoutMs = 20_000) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = await verifyRichPostInOpenChat(page, command);
    if (last.found) return last;
    await page.waitForTimeout(500);
  }
  return last || { found: false, count: 0, last: null };
}

export async function verifyRichPostWithFreshSession(command, options = {}) {
  let runtime;
  try {
    runtime = await launchAuthenticatedMax({
      timezoneId: command.timeZone || 'Europe/Kaliningrad',
    });
    const chat = await openChatByExactTitle(runtime.page, command.chat.title);
    const verification = await waitForRichPostInOpenChat(
      runtime.page,
      command,
      options.timeoutMs || 20_000,
    );
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
