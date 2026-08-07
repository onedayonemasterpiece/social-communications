import { loadMaxCommand } from './max-command-contract.mjs';

const command = await loadMaxCommand();
const waitUntil = command.verifyOnly
  && command.delivery.mode === 'send_now'
  && command.delivery.stageAt
  ? new Date(command.delivery.stageAt)
  : null;

if (!waitUntil || Number.isNaN(waitUntil.getTime())) {
  console.log('MAX_VERIFY_WAIT=not-required');
  process.exit(0);
}

const waitMs = waitUntil.getTime() - Date.now();
if (waitMs <= 0) {
  console.log(`MAX_VERIFY_WAIT=already-reached target=${waitUntil.toISOString()}`);
  process.exit(0);
}

if (waitMs > 15 * 60 * 1_000) {
  throw new Error(`MAX verify wait exceeds 15-minute safety limit: ${waitMs}ms`);
}

console.log(`MAX_VERIFY_WAIT=waiting target=${waitUntil.toISOString()} milliseconds=${waitMs}`);
await new Promise((resolve) => setTimeout(resolve, waitMs));
console.log(`MAX_VERIFY_WAIT=reached target=${waitUntil.toISOString()}`);
