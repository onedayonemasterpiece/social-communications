import fs from 'node:fs/promises';
import path from 'node:path';
import { verifyRichPostWithFreshSession } from './max-rich-post-verifier.mjs';

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

const command = await loadCommand();

if (command.action === 'rich_post') {
  const existing = await verifyRichPostWithFreshSession(command, { timeoutMs: 5_000 });
  if (existing.found) {
    const result = {
      status: 'pass',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      command: {
        version: command.version,
        requestId: command.requestId,
        action: command.action,
        chatTitle: command.chat?.title,
      },
      outcome: 'already_present',
      verification: {
        skippedToAvoidDuplicate: true,
        strictRichPostMatch: existing,
      },
    };
    await writeResult(result);
    console.log(`MAX_SEND_RESULT=already_present action=rich_post request_id=${command.requestId}`);
    process.exit(0);
  }
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
      error: undefined,
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
