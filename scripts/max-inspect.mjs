import fs from 'node:fs/promises';
import path from 'node:path';
import { launchAuthenticatedMax } from './max-runtime.mjs';
import {
  captureEvidence,
  clearComposer,
  findAttachmentButton,
  findComposer,
  findSendButton,
  openChatByExactTitle,
  typePlainText,
  visibleOverlayText,
} from './max-ui.mjs';

const artifactDir = path.resolve(process.env.MAX_ARTIFACT_DIR || 'artifacts/max-inspect');
const chatTitle = process.env.MAX_CHAT_TITLE?.trim() || 'Тестовая группа';
const result = {
  status: 'started',
  chatTitle,
  startedAt: new Date().toISOString(),
  session: null,
  chat: null,
  controls: null,
  rightClick: null,
  scheduleDialog: null,
};

let runtime;
try {
  runtime = await launchAuthenticatedMax();
  result.session = runtime.session.counts;
  result.chat = await openChatByExactTitle(runtime.page, chatTitle);
  await captureEvidence(runtime.page, artifactDir, '01-chat-open');

  const composer = await findComposer(runtime.page);
  const sendButton = await findSendButton(runtime.page);
  const attachmentButton = await findAttachmentButton(runtime.page);
  result.controls = {
    composerBox: await composer.boundingBox(),
    sendBox: await sendButton.boundingBox(),
    attachmentBox: await attachmentButton.boundingBox(),
  };

  await typePlainText(composer, 'Черновик диагностики — не отправлять');
  await sendButton.click({ button: 'right' });
  await runtime.page.waitForTimeout(800);
  result.rightClick = {
    overlayText: await visibleOverlayText(runtime.page),
  };
  await captureEvidence(runtime.page, artifactDir, '02-send-context-menu');

  await runtime.page.getByRole('menuitem', { name: 'Отправить позже', exact: true }).click();
  await runtime.page.waitForTimeout(800);
  result.scheduleDialog = {
    overlayText: await visibleOverlayText(runtime.page),
    fields: await runtime.page.evaluate(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
      };
      return Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"], [role="spinbutton"]'))
        .filter(visible)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          type: element.getAttribute('type') || '',
          role: element.getAttribute('role') || '',
          aria: element.getAttribute('aria-label') || '',
          placeholder: element.getAttribute('placeholder') || '',
          value: 'value' in element ? String(element.value || '') : String(element.textContent || ''),
        }));
    }),
  };
  await captureEvidence(runtime.page, artifactDir, '03-schedule-dialog');

  await runtime.page.keyboard.press('Escape').catch(() => {});
  await runtime.page.keyboard.press('Escape').catch(() => {});
  await clearComposer(composer);
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
  await fs.writeFile(path.join(artifactDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (runtime?.context) await runtime.context.close().catch(() => {});
  if (runtime?.browser) await runtime.browser.close().catch(() => {});
}
