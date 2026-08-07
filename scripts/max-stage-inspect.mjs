import fs from 'node:fs/promises';
import path from 'node:path';
import { launchAuthenticatedMax } from './max-runtime.mjs';
import {
  captureEvidence,
  firstVisible,
  normalizeText,
  openChatByExactTitle,
  visibleOverlayText,
} from './max-ui.mjs';

const artifactDir = path.resolve(process.env.MAX_ARTIFACT_DIR || 'artifacts/max-stage-inspect');
const chatTitle = normalizeText(process.env.MAX_CHAT_TITLE || 'Тестовая группа');
const targetText = normalizeText(
  process.env.MAX_TARGET_TEXT
    || 'Тест отложенной отправки: это сообщение должно появиться 8 августа 2026 года в 11:00.',
);

const result = {
  status: 'started',
  startedAt: new Date().toISOString(),
  chatTitle,
  targetText,
  menu: null,
  target: null,
};

let runtime;
try {
  runtime = await launchAuthenticatedMax();
  result.chat = await openChatByExactTitle(runtime.page, chatTitle);

  const scheduledButton = await firstVisible(runtime.page.locator([
    'button[aria-label="Открыть отложенные сообщения"]',
    'button[aria-label*="отложенные сообщения" i]',
  ].join(',')));
  if (!scheduledButton) throw new Error('MAX scheduled-messages button was not found.');
  await scheduledButton.click();
  await runtime.page.waitForTimeout(1_200);

  const candidates = runtime.page.locator('[role="listitem"], [role="presentation"]').filter({ hasText: targetText });
  const visibleCandidates = [];
  const count = Math.min(await candidates.count(), 100);
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const bodyText = normalizeText(await candidate.innerText().catch(() => ''));
    if (!bodyText.includes(targetText)) continue;
    visibleCandidates.push(candidate);
  }
  if (visibleCandidates.length !== 1) {
    throw new Error(`Expected one visible scheduled message containing target text, found ${visibleCandidates.length}.`);
  }

  const target = visibleCandidates[0];
  result.target = {
    bodyText: normalizeText(await target.innerText()),
    box: await target.boundingBox(),
    role: await target.getAttribute('role'),
    tag: await target.evaluate((element) => element.tagName.toLowerCase()),
    outerHtml: await target.evaluate((element) => element.outerHTML.slice(0, 8_000)),
  };

  await target.click({ button: 'right' });
  await runtime.page.waitForTimeout(800);
  result.menu = {
    overlayText: await visibleOverlayText(runtime.page),
    menuItems: await runtime.page.evaluate(() => {
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
      return Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]'))
        .filter(visible)
        .map((element) => ({
          text: clean(element.innerText || element.textContent || ''),
          aria: element.getAttribute('aria-label') || '',
          title: element.getAttribute('title') || '',
        }));
    }),
  };

  await captureEvidence(runtime.page, artifactDir, '01-scheduled-message-menu');
  result.status = 'pass';
  result.completedAt = new Date().toISOString();
} catch (error) {
  result.status = 'fail';
  result.error = { name: error?.name || 'Error', message: String(error?.message || error) };
  result.completedAt = new Date().toISOString();
  if (runtime?.page) await captureEvidence(runtime.page, artifactDir, '99-failure').catch(() => {});
  process.exitCode = 1;
} finally {
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(path.join(artifactDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  if (runtime?.context) await runtime.context.close().catch(() => {});
  if (runtime?.browser) await runtime.browser.close().catch(() => {});
}
