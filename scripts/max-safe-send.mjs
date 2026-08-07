import fs from 'node:fs/promises';
import path from 'node:path';
import { loadMaxCommand, commandReceipt } from './max-command-contract.mjs';
import { launchAuthenticatedMax } from './max-runtime.mjs';
import { resolveDestination } from './max-destination.mjs';
import {
  discardComposerDraft,
  prevalidateContent,
  prepareContentInComposer,
} from './max-composer.mjs';
import {
  defaultParkingTimestamp,
  deleteScheduledMessage,
  findScheduledContent,
  schedulePreparedComposer,
  sendScheduledNow,
  verifyScheduledWithFreshSession,
} from './max-scheduled-queue.mjs';
import {
  verifyFinalContentWithFreshSession,
  verifyTextInOpenChat,
} from './max-final-verifier.mjs';
import { verifyRichPostInOpenChat } from './max-rich-post-verifier.mjs';
import { captureEvidence } from './max-ui.mjs';

const artifactDir = path.resolve(process.env.MAX_ARTIFACT_DIR || 'artifacts/max-send');
const captureEnabled = process.env.MAX_CAPTURE_EVIDENCE === '1';
const resultPath = path.join(artifactDir, 'result.json');

function summarizeScheduled(verification) {
  if (!verification) return null;
  return {
    found: verification.found,
    ambiguous: verification.ambiguous,
    count: verification.count,
    expectedTime: verification.expectedTime,
    match: verification.match ? {
      bodyText: verification.match.bodyText,
      structure: verification.match.structure,
      box: verification.match.box,
    } : null,
    matches: verification.matches,
  };
}

async function finalInOpenChat(page, content) {
  return content.type === 'rich_post'
    ? verifyRichPostInOpenChat(page, { text: content.text, links: content.links })
    : verifyTextInOpenChat(page, content.text);
}

async function writeResult(result) {
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
}

function errorCode(error) {
  return String(error?.code || error?.name || 'Error').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
}

const result = {
  status: 'started',
  startedAt: new Date().toISOString(),
  command: null,
  preflight: null,
  session: null,
  destination: null,
  staging: null,
  outcome: null,
  verification: null,
  cleanup: null,
  commitPointPassed: false,
};

let runtime;
let command;
let resolvedTitle = null;
let stageAt = null;
let stageCreated = false;
let stagedVerification = null;
let activeComposer = null;

try {
  command = await loadMaxCommand();
  result.command = commandReceipt(command);
  result.preflight = await prevalidateContent(command.content);

  runtime = await launchAuthenticatedMax({ timezoneId: command.delivery.timeZone });
  result.session = runtime.session.counts;
  result.destination = await resolveDestination(runtime.page, command.destination);
  resolvedTitle = result.destination.title;

  if (command.verifyOnly) {
    if (command.delivery.mode === 'schedule_at') {
      const verification = await findScheduledContent(runtime.page, command.content, {
        scheduleAt: command.delivery.scheduleAt,
        timeZone: command.delivery.timeZone,
      });
      result.verification = { scheduled: summarizeScheduled(verification) };
      if (!verification.found) throw Object.assign(new Error('Expected scheduled MAX content was not found.'), { code: 'verify-scheduled-not-found' });
      result.outcome = 'verified_existing';
    } else {
      const verification = await finalInOpenChat(runtime.page, command.content);
      result.verification = { final: verification };
      if (!verification.found) throw Object.assign(new Error('Expected final MAX content was not found.'), { code: 'verify-final-not-found' });
      result.outcome = 'verified_existing';
    }
    result.status = 'pass';
    result.completedAt = new Date().toISOString();
    console.log(`MAX_SAFE_SEND_RESULT=${result.outcome} mode=${command.delivery.mode} request_id=${command.requestId}`);
  } else if (command.delivery.mode === 'send_now') {
    const existingFinal = await finalInOpenChat(runtime.page, command.content);
    if (existingFinal.found) {
      result.outcome = 'already_present';
      result.verification = { final: existingFinal, skippedToAvoidDuplicate: true };
      result.status = 'pass';
      result.completedAt = new Date().toISOString();
      console.log(`MAX_SAFE_SEND_RESULT=already_present mode=send_now request_id=${command.requestId}`);
    } else {
      stageAt = command.delivery.stageAt || defaultParkingTimestamp();
      if (command.delivery.reuseExistingStage) {
        const byExpectedTime = command.delivery.stageAt
          ? await findScheduledContent(runtime.page, command.content, {
            scheduleAt: stageAt,
            timeZone: command.delivery.timeZone,
          })
          : await findScheduledContent(runtime.page, command.content, {
            timeZone: command.delivery.timeZone,
          });
        if (byExpectedTime.ambiguous) {
          throw Object.assign(new Error('Multiple matching staged MAX messages were found.'), { code: 'staged-content-ambiguous' });
        }
        stagedVerification = byExpectedTime;
      }

      if (!stagedVerification?.found) {
        await resolveDestination(runtime.page, { exactTitle: resolvedTitle, kind: command.destination.kind });
        const prepared = await prepareContentInComposer(runtime.page, command.content);
        activeComposer = prepared.composer;
        result.staging = {
          stageAt,
          prepared: {
            atomicPaste: true,
            image: prepared.image || null,
            caption: prepared.caption || prepared.text || null,
          },
        };
        const scheduleReceipt = await schedulePreparedComposer(runtime.page, stageAt, command.delivery.timeZone);
        stageCreated = true;
        activeComposer = null;
        stagedVerification = await findScheduledContent(runtime.page, command.content, {
          scheduleAt: stageAt,
          timeZone: command.delivery.timeZone,
        });
        result.staging.schedule = scheduleReceipt;
        result.staging.verification = summarizeScheduled(stagedVerification);
        if (!stagedVerification.found) {
          throw Object.assign(new Error('Newly staged MAX content could not be verified in scheduled messages.'), { code: 'stage-verification-failed' });
        }
      } else {
        result.staging = {
          stageAt: command.delivery.stageAt || null,
          reusedExisting: true,
          verification: summarizeScheduled(stagedVerification),
        };
      }

      if (captureEnabled) await captureEvidence(runtime.page, artifactDir, '01-staged-before-send-now');
      result.commitPointPassed = true;
      await sendScheduledNow(runtime.page, stagedVerification.match);
      const finalVerification = await verifyFinalContentWithFreshSession(command, resolvedTitle, { timeoutMs: 25_000 });
      result.verification = { final: finalVerification };
      if (!finalVerification.found) {
        throw Object.assign(new Error('MAX staged message was promoted with «Отправить сейчас», but final content was not independently verified.'), {
          code: 'post-commit-final-verification-failed',
        });
      }
      result.outcome = 'sent_via_staging';
      result.status = 'pass';
      result.completedAt = new Date().toISOString();
      if (captureEnabled) {
        await resolveDestination(runtime.page, { exactTitle: resolvedTitle, kind: command.destination.kind });
        await captureEvidence(runtime.page, artifactDir, '02-final-after-send-now');
      }
      console.log(`MAX_SAFE_SEND_RESULT=sent_via_staging mode=send_now request_id=${command.requestId}`);
    }
  } else {
    stageAt = command.delivery.mode === 'schedule_at'
      ? command.delivery.scheduleAt
      : command.delivery.stageAt || defaultParkingTimestamp();

    stagedVerification = await findScheduledContent(runtime.page, command.content, {
      scheduleAt: stageAt,
      timeZone: command.delivery.timeZone,
    });
    if (stagedVerification.ambiguous) {
      throw Object.assign(new Error('Multiple matching scheduled MAX messages were found.'), { code: 'scheduled-content-ambiguous' });
    }

    if (!stagedVerification.found) {
      await resolveDestination(runtime.page, { exactTitle: resolvedTitle, kind: command.destination.kind });
      const prepared = await prepareContentInComposer(runtime.page, command.content);
      activeComposer = prepared.composer;
      const scheduleReceipt = await schedulePreparedComposer(runtime.page, stageAt, command.delivery.timeZone);
      stageCreated = true;
      activeComposer = null;
      stagedVerification = await findScheduledContent(runtime.page, command.content, {
        scheduleAt: stageAt,
        timeZone: command.delivery.timeZone,
      });
      result.staging = {
        stageAt,
        schedule: scheduleReceipt,
        verification: summarizeScheduled(stagedVerification),
        prepared: {
          atomicPaste: true,
          image: prepared.image || null,
          caption: prepared.caption || prepared.text || null,
        },
      };
      if (!stagedVerification.found) {
        throw Object.assign(new Error('Scheduled MAX content could not be verified after creation.'), { code: 'scheduled-verification-failed' });
      }
    } else {
      result.staging = {
        stageAt,
        reusedExisting: true,
        verification: summarizeScheduled(stagedVerification),
      };
    }

    const strictVerification = await verifyScheduledWithFreshSession(command, resolvedTitle, stageAt);
    result.verification = { scheduled: summarizeScheduled(strictVerification) };
    if (!strictVerification.found) {
      throw Object.assign(new Error('Scheduled MAX content failed independent fresh-session verification.'), { code: 'scheduled-fresh-verification-failed' });
    }
    result.outcome = command.delivery.mode === 'schedule_at' ? 'scheduled' : 'staged';
    result.status = 'pass';
    result.completedAt = new Date().toISOString();
    if (captureEnabled) await captureEvidence(runtime.page, artifactDir, '01-scheduled-verified');
    console.log(`MAX_SAFE_SEND_RESULT=${result.outcome} mode=${command.delivery.mode} request_id=${command.requestId}`);
  }
} catch (error) {
  result.status = 'fail';
  result.error = {
    name: error?.name || 'Error',
    code: errorCode(error),
    message: String(error?.message || error),
    candidates: Array.isArray(error?.candidates) ? error.candidates.slice(0, 8) : undefined,
  };
  if (result.error.candidates === undefined) delete result.error.candidates;
  result.completedAt = new Date().toISOString();

  if (runtime?.page && activeComposer && !result.commitPointPassed) {
    await discardComposerDraft(runtime.page, activeComposer).catch(() => {});
  }

  if (runtime?.page && stageCreated && !result.commitPointPassed && command && stageAt) {
    try {
      const cleanupCandidate = stagedVerification?.found
        ? stagedVerification
        : await findScheduledContent(runtime.page, command.content, {
          scheduleAt: stageAt,
          timeZone: command.delivery.timeZone,
        });
      result.cleanup = cleanupCandidate?.found
        ? await deleteScheduledMessage(runtime.page, cleanupCandidate.match)
        : { deleted: false, reason: 'created-stage-not-found-for-cleanup' };
    } catch (cleanupError) {
      result.cleanup = { deleted: false, reason: String(cleanupError?.message || cleanupError) };
    }
  }

  if (runtime?.page && captureEnabled) {
    await captureEvidence(runtime.page, artifactDir, '99-failure').catch(() => {});
  }
  console.error(`MAX_SAFE_SEND_FAILED code=${result.error.code} request_id=${command?.requestId || 'unknown'} commit_point=${result.commitPointPassed ? 'passed' : 'not-passed'}`);
  process.exitCode = 1;
} finally {
  await writeResult(result);
  if (runtime?.context) await runtime.context.close().catch(() => {});
  if (runtime?.browser) await runtime.browser.close().catch(() => {});
}
