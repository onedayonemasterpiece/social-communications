import fs from 'node:fs/promises';
import path from 'node:path';
import { verifyRichPostWithFreshSession } from './max-rich-post-verifier.mjs';
import { verifyScheduledMessageWithFreshSession } from './max-scheduled-message-verifier.mjs';

const artifactDir = path.resolve(process.env.MAX_ARTIFACT_DIR || 'artifacts/max-send');
const resultPath = path.join(artifactDir, 'result.json');
const commandFile = path.resolve(process.env.MAX_COMMAND_FILE?.trim() || '.github/max-live-command.json');

async function loadCommand() {
  const raw = process.env.MAX_COMMAND_JSON?.trim() || await fs.readFile(commandFile, 'utf8');
  return JSON.parse(raw);
}

async function writeResult(result) {
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
}

function commandReceipt(command) {
  return {
    version: command.version,
    requestId: command.requestId,
    action: command.action,
    chatTitle: command.chat?.title,
    scheduleAt: command.scheduleAt || null,
  };
}

async function completeAlreadyPresent(command, verificationField, verification) {
  const result = {
    status: 'pass',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    command: commandReceipt(command),
    outcome: 'already_present',
    verification: {
      skippedToAvoidDuplicate: true,
      [verificationField]: verification,
    },
  };
  await writeResult(result);
  console.log(`MAX_SEND_RESULT=already_present action=${command.action} request_id=${command.requestId}`);
  process.exit(0);
}

const command = await loadCommand();
process.env.MAX_COMMAND_JSON = JSON.stringify(command);

if (command.action === 'rich_post') {
  const existing = await verifyRichPostWithFreshSession(command, { timeoutMs: 5_000 });
  if (existing.found) await completeAlreadyPresent(command, 'strictRichPostMatch', existing);
}

if (command.action === 'schedule_text') {
  const existing = await verifyScheduledMessageWithFreshSession(command);
  if (existing.found) await completeAlreadyPresent(command, 'strictScheduledMessageMatch', existing);
}

await import('./max-send.mjs');

let senderResult = null;
try {
  senderResult = JSON.parse(await fs.readFile(resultPath, 'utf8'));
} catch {
  // Preserve the sender exit code when it failed before writing its receipt.
}

if (command.action === 'rich_post' && senderResult?.status !== 'pass') {
  const recovered = await verifyRichPostWithFreshSession(command, { timeoutMs: 20_000 });
  if (recovered.found) {
    const corrected = {
      ...senderResult,
      status: 'pass',
      outcome: 'sent',
      completedAt: new Date().toISOString(),
      recoveredFromVerificationFailure: true,
      originalError: senderResult?.error || null,
      verification: {
        ...(senderResult?.verification || {}),
        strictRichPostMatch: recovered,
      },
    };
    delete corrected.error;
    await writeResult(corrected);
    process.exitCode = 0;
    console.log(`MAX_SEND_RESULT=sent_verified action=rich_post request_id=${command.requestId}`);
  }
}

if (command.action === 'schedule_text') {
  const strictVerification = await verifyScheduledMessageWithFreshSession(command);
  if (strictVerification.found) {
    const corrected = {
      ...(senderResult || {}),
      status: 'pass',
      outcome: senderResult?.outcome === 'already_present' ? 'already_present' : 'scheduled',
      completedAt: new Date().toISOString(),
      recoveredFromVerificationFailure: senderResult?.status !== 'pass',
      originalError: senderResult?.status !== 'pass' ? senderResult?.error || null : undefined,
      verification: {
        ...(senderResult?.verification || {}),
        strictScheduledMessageMatch: strictVerification,
      },
    };
    delete corrected.error;
    if (corrected.originalError === undefined) delete corrected.originalError;
    await writeResult(corrected);
    process.exitCode = 0;
    console.log(`MAX_SEND_RESULT=scheduled_verified action=schedule_text request_id=${command.requestId}`);
  } else if (senderResult?.status === 'pass') {
    const failed = {
      ...senderResult,
      status: 'fail',
      completedAt: new Date().toISOString(),
      error: {
        name: 'StrictVerificationError',
        message: 'MAX sender reported success, but the scheduled-message list did not contain the expected text and time.',
      },
      verification: {
        ...(senderResult?.verification || {}),
        strictScheduledMessageMatch: strictVerification,
      },
    };
    await writeResult(failed);
    process.exitCode = 1;
    console.error(`MAX_SEND_FAILED=strict scheduled-message verification failed request_id=${command.requestId}`);
  }
}
