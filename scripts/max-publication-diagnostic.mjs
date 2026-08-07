import { loadMaxCommand } from './max-command-contract.mjs';
import { launchAuthenticatedMax } from './max-runtime.mjs';
import { resolveDestination } from './max-destination.mjs';
import { findScheduledContent } from './max-scheduled-queue.mjs';
import { normalizeText } from './max-ui.mjs';

const command = await loadMaxCommand();
let runtime;

try {
  runtime = await launchAuthenticatedMax({ timezoneId: command.delivery.timeZone });
  const destination = await resolveDestination(runtime.page, command.destination);
  await runtime.page.waitForTimeout(1_500);

  const expectedText = normalizeText(command.content.text);
  const primaryFragment = expectedText.slice(0, 96);
  const linkTexts = (command.content.links || []).map((link) => normalizeText(link.text));
  const expectedUrls = (command.content.links || []).map((link) => new URL(link.url).href);

  const final = await runtime.page.evaluate(({ primaryFragment: fragment, linkTexts: labels, expectedUrls: urls }) => {
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
    const canonical = (value) => {
      try { return new URL(value, location.href).href; } catch { return ''; }
    };
    const nodes = Array.from(document.querySelectorAll('[role="listitem"], [role="presentation"]'))
      .filter(visible);
    const matches = [];
    for (const element of nodes) {
      const bodyText = clean(element.innerText || element.textContent || '');
      const anchors = Array.from(element.querySelectorAll('a')).map((anchor) => ({
        text: clean(anchor.innerText || anchor.textContent || ''),
        href: canonical(anchor.getAttribute('href') || anchor.href || ''),
      }));
      const fragmentMatched = bodyText.includes(fragment);
      const labelMatched = labels.some((label) => label && bodyText.includes(label));
      const urlMatched = urls.some((url) => anchors.some((anchor) => anchor.href === url));
      if (!fragmentMatched && !labelMatched && !urlMatched) continue;
      const media = Boolean(element.querySelector(
        'img, video, canvas, [aria-label="Прикрепленные фото"], [aria-label*="Прикреплен" i]',
      ));
      const box = element.getBoundingClientRect();
      matches.push({
        fragmentMatched,
        labelMatched,
        urlMatched,
        media,
        bodyLength: bodyText.length,
        bodyPrefix: bodyText.slice(0, 240),
        anchors: anchors.slice(0, 10),
        box: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
      });
    }
    return {
      inspectedVisibleContainers: nodes.length,
      matches,
    };
  }, { primaryFragment, linkTexts, expectedUrls });

  const scheduledAt = process.env.MAX_DIAGNOSTIC_SCHEDULE_AT || null;
  const scheduled = scheduledAt
    ? await findScheduledContent(runtime.page, command.content, {
      scheduleAt: scheduledAt,
      timeZone: command.delivery.timeZone,
    })
    : null;

  const safeScheduled = scheduled ? {
    found: scheduled.found,
    ambiguous: scheduled.ambiguous,
    count: scheduled.count,
    expectedTime: scheduled.expectedTime,
    queue: scheduled.queue || null,
    diagnostics: scheduled.diagnostics || null,
    matches: (scheduled.matches || []).map((match) => ({
      box: match.box || null,
      bodyLength: String(match.bodyText || '').length,
      structure: match.structure || null,
    })),
  } : null;

  console.log(`MAX_PUBLICATION_DIAGNOSTIC destination=${destination.title}`);
  console.log(`MAX_FINAL_CANDIDATES=${JSON.stringify(final)}`);
  console.log(`MAX_SCHEDULED_CANDIDATES=${JSON.stringify(safeScheduled)}`);
} finally {
  if (runtime?.context) await runtime.context.close().catch(() => {});
  if (runtime?.browser) await runtime.browser.close().catch(() => {});
}
