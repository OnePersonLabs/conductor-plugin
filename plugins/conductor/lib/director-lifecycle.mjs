import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DirectorActivity } from './director-activity.mjs';
import { inspectRepository } from './worktrees.mjs';
import { isLiveOwner, runnerPause, RUNNER_PAUSED_MESSAGE } from './runner-state.mjs';

const DIRECTOR_CONTEXT = 'This conversation is the configured automated Conductor director. Follow $conductor:director in its already-bound automated mode for this user request. Do not ask again where to run or silently switch to synchronous mode. Reconcile current repository and issue state, and preserve holds, pauses, and approval boundaries. Use chat for human questions; do not start a human-collaboration inbox unless the user explicitly requests it.';
const WAKEUP_MARKER = /<!--\s*conductor:director-wakeup:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\s*-->/ig;

function wakeupMarker(prompt) {
  if (typeof prompt !== 'string') return null;
  const markers = [...prompt.matchAll(WAKEUP_MARKER)];
  return markers.length === 1 ? markers[0][1] : null;
}

export async function handleDirectorLifecycle(payload, { activityFactory = options => new DirectorActivity(options) } = {}) {
  const event = payload?.hook_event_name;
  if (!['UserPromptSubmit', 'PostToolUse', 'Stop', 'Interrupt'].includes(event)) return { handled: false };
  const threadId = payload.session_id;
  const turnId = payload.turn_id;
  if (typeof threadId !== 'string' || !threadId || typeof turnId !== 'string' || !turnId || typeof payload.cwd !== 'string' || !payload.cwd) return { handled: false };

  let repo, config, state;
  try {
    repo = await inspectRepository(payload.cwd);
    config = JSON.parse(await readFile(join(repo.root, 'conductor.json'), 'utf8'));
    state = JSON.parse(await readFile(join(repo.commonDir, 'conductor', 'state.json'), 'utf8'));
  } catch { return { handled: false }; }

  const director = state.director;
  const ownership = director?.threadHostOwnership;
  const boundThread = director?.threadId === threadId && ownership?.host === 'codex-desktop' && (!ownership.threadId || ownership.threadId === threadId);
  const pendingDestination = director?.handoff?.fromThreadId === director?.threadId && director?.handoff?.toThreadId === threadId && ownership?.host === 'codex-desktop' && (!ownership.threadId || ownership.threadId === director.threadId);
  if (config.version !== 2 || (!boundThread && !pendingDestination)) return { handled: false };

  let owner;
  try { owner = JSON.parse(await readFile(join(repo.commonDir, 'conductor', 'coordinator.lock'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; owner = null; }
  const pause = runnerPause(state, owner);

  // Reject a new submission during the final binding write. The old turn's
  // terminal receipts remain admissible; blocked handoffs still allow recovery.
  if (boundThread && director.handoff?.fromThreadId === threadId && director.handoff.status === 'switching' && event === 'UserPromptSubmit') {
    return { handled: true, error: `Conductor is switching to chat ${director.handoff.toThreadId}. This new turn was not started. Retry in that chat once the handoff completes.` };
  }

  let activity;
  try {
    activity = activityFactory({ dir: join(repo.commonDir, 'conductor') });
    const handoff = director.handoff;
    const oldThread = boundThread && handoff?.fromThreadId === threadId && ['waiting-turn', 'blocked', 'switching'].includes(handoff.status);
    const oldTurn = oldThread && handoff.turnId === turnId;
    const destination = boundThread && event === 'PostToolUse' ? ownership?.lifecycleBaseline : null;
    const marker = event === 'UserPromptSubmit' ? wakeupMarker(payload.prompt) : null;
    if (pause && marker) {
      const batch = director.batches?.find(item => item.id === marker && item.threadId === threadId);
      const authorized = batch?.observation === true && typeof state.runnerPause?.at === 'string' && batch.observationPauseAt === state.runnerPause.at && !director.handoff
        && state.serviceReady === true && isLiveOwner(owner) && state.ownerToken === owner.token
        && ['submitting', 'queued', 'uncertain'].includes(batch.status)
        && !batch.acknowledgedAt && !batch.queueCancellationConfirmed && !batch.nativeConsumed;
      if (!authorized) {
        if (batch) activity.blockWakeup({ threadId, turnId, batchId: marker });
        return { handled: true, error: `${RUNNER_PAUSED_MESSAGE}. This queued director wake was blocked before execution.` };
      }
    }
    const activityInput = { threadId, turnId, event, wakeupMarker: marker };
    if (destination) activityInput.enrollmentBaseline = destination;
    const status = await activity.record(activityInput);
    if (pendingDestination) return { handled: true, status, hookOutput: event === 'Stop' || event === 'Interrupt' ? {} : null };
    if (oldThread && (event === 'UserPromptSubmit' || (oldTurn && event === 'PostToolUse'))) {
      const handoffContext = `Conductor is handing this director to Desktop chat ${handoff.toThreadId}. Finish only the current operation, do not begin another issue or queue another wake, summarize the handoff, and end this turn. Do not wait for the replacement chat.`;
      const additionalContext = event === 'UserPromptSubmit' ? `${DIRECTOR_CONTEXT}\n\n${handoffContext}` : handoffContext;
      return { handled: true, status, hookOutput: { hookSpecificOutput: { hookEventName: event, additionalContext } } };
    }
    if (pause && ['UserPromptSubmit', 'PostToolUse'].includes(event)) {
      const additionalContext = `${DIRECTOR_CONTEXT}\n\n${RUNNER_PAUSED_MESSAGE}. Reason: ${pause.reason}. Report this state and the resume action clearly. This turn may inspect state and answer the user, but must not start workers, publish changes, or automatically resume execution. Internal events are not permission to resume. Only an explicit user resume request may run conductor resume. Finish any already-issued operation, preserve unresolved recovery, and end this turn.`;
      return { handled: true, status, hookOutput: { hookSpecificOutput: { hookEventName: event, additionalContext } } };
    }
    return event === 'UserPromptSubmit'
      ? { handled: true, status, hookOutput: { hookSpecificOutput: { hookEventName: event, additionalContext: DIRECTOR_CONTEXT } } }
      : { handled: true, status, hookOutput: event === 'Stop' || event === 'Interrupt' ? {} : null };
  } catch (error) {
    if (event === 'UserPromptSubmit') return { handled: true, error: `Conductor could not record this director turn, so it did not continue: ${error.message}` };
    return { handled: true, error: error.message, hookOutput: {} };
  } finally {
    activity?.close();
  }
}
