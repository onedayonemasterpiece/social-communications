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
  attachment: null,
};

async function setSpinbutton(page, label, value) {
  const spin = page.getByRole('spinbutton', { name: label, exact: true });
  await spin.click();
  await spin.press('Control+A').catch(() => {});
  await spin.pressSequentially(value, { delay: 80 });
  await page.waitForTimeout(250);
  return spin.textContent();
}

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
    composerHtml: await composer.evaluate((element) => element.outerHTML.slice(0, 2_000)),
  };

  await typePlainText(composer, 'Черновик диагностики — не отправлять');
  await sendButton.click({ button: 'right' });
  await runtime.page.waitForTimeout(800);
  result.rightClick = { overlayText: await visibleOverlayText(runtime.page) };
  await captureEvidence(runtime.page, artifactDir, '02-send-context-menu');

  await runtime.page.getByRole('menuitem', { name: 'Отправить позже', exact: true }).click();
  await runtime.page.waitForTimeout(800);
  const targetDay = runtime.page.locator('button.day:not(.day--otherMonth):not(.day--disabled)').filter({ hasText: /^8$/ });
  if (await targetDay.count() !== 1) throw new Error(`Expected one selectable calendar day 8, found ${await targetDay.count()}.`);
  await targetDay.click();
  const hours = await setSpinbutton(runtime.page, 'Часы', '11');
  const minutes = await setSpinbutton(runtime.page, 'Минуты', '00');
  await runtime.page.waitForTimeout(400);
  const confirmation = await runtime.page.locator('button').filter({ hasText: /^Отправить / }).first().innerText();
  result.scheduleDialog = {
    selectedDay: '8',
    hours: String(hours || '').trim(),
    minutes: String(minutes || '').trim(),
    confirmation: String(confirmation || '').trim(),
  };
  await captureEvidence(runtime.page, artifactDir, '03-schedule-configured-dry-run');

  await runtime.page.keyboard.press('Escape').catch(() => {});
  await runtime.page.keyboard.press('Escape').catch(() => {});

  await attachmentButton.click();
  await runtime.page.waitForTimeout(400);
  result.attachment = {
    menuText: await visibleOverlayText(runtime.page),
  };
  const photoOption = runtime.page.getByText('Фото или видео', { exact: true });
  const chooserPromise = runtime.page.waitForEvent('filechooser', { timeout: 5_000 });
  await photoOption.click();
  const chooser = await chooserPromise;
  const chooserElement = chooser.element();
  result.attachment.multiple = chooser.isMultiple();
  result.attachment.accept = await chooserElement.getAttribute('accept');
  result.attachment.inputType = await chooserElement.getAttribute('type');

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
