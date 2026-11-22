import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DirectorActivity } from './director-activity.mjs';
import { inspectRepository } from './worktrees.mjs';
import { isLiveOwner, runnerPause, RUNNER_PAUSED_MESSAGE } from './runner-state.mjs';
import { isChatHost } from './runtime.mjs';
import { ClaudeStore } from './claude.mjs';

const DIRECTOR_CONTEXT = 'This conversation is the configured automated Conductor director. Follow $conductor:direct-workflow (in Claude Code, the conductor:direct-workflow skill) in its already-bound automated mode for this user request. Do not ask again where to run or silently switch to synchronous mode. Reconcile current repository and issue state, and preserve holds, pauses, and approval boundaries. Use chat for human questions; do not start a human-collaboration inbox unless the user explicitly requests it.';
const WAKEUP_MARKER = /<!--\s*conductor:director-wakeup:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\s*-->/ig;
export const ARM_WAITER = 'Before ending this turn, arm the Conductor wake listener: run `conductor director-wait` as a background command (Bash with run_in_background). Claude Code re-invokes you when it prints a queued wake. Do not wait for it in the foreground.';

export function wakeupMarker(prompt) {
  if (typeof prompt !== 'string') return null;
  const markers = [...prompt.matchAll(WAKEUP_MARKER)];
  return markers.length === 1 ? markers[0][1] : null;
}

/**
 * Whether a queued wake may start a director turn. While the runner is paused,
 * only the observation batch the paused service itself authorized may run.
 */
export function wakeAuthorized({ state, owner, threadId, marker }) {
  const pause = runnerPause(state, owner);
  if (!pause || !marker) return { allowed: true, pause };
  const director = state.director;
  const batch = director.batches?.find(item => item.id === marker && item.threadId === threadId);
  const allowed = batch?.observation === true && typeof state.runnerPause?.at === 'string' && batch.observationPauseAt === state.runnerPause.at && !director.handoff
    && state.serviceReady === true && isLiveOwner(owner) && state.ownerToken === owner.token
    && ['submitting', 'queued', 'uncertain'].includes(batch.status)
    && !batch.acknowledgedAt && !batch.queueCancellationConfirmed && !batch.nativeConsumed;
  return { allowed, pause, batch };
}

/**
 * Claude Code hook payloads carry no turn id. A prompt starts a new turn; later
 * events in the same session belong to the active turn the activity store saw.
 */
async function hookTurnId(payload, activity, threadId) {
  if (typeof payload.turn_id === 'string' && payload.turn_id) return payload.turn_id;
  if (payload.hook_event_name === 'UserPromptSubmit') return randomUUID();
  const current = await activity.read(threadId);
  return current.state === 'active' && current.turnId ? current.turnId : randomUUID();
}

export async function readOwner(repo) {
  try { return JSON.parse(await readFile(join(repo.commonDir, 'conductor', 'coordinator.lock'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

export async function readRepositoryState(cwd) {
  const repo = await inspectRepository(cwd);
  const config = JSON.parse(await readFile(join(repo.root, 'conductor.json'), 'utf8'));
  const state = JSON.parse(await readFile(join(repo.commonDir, 'conductor', 'state.json'), 'utf8'));
  return { repo, config, state, owner: await readOwner(repo), dir: join(repo.commonDir, 'conductor') };
}

/**
 * Deliver queued Claude Code director wakes. Each delivered wake records the
 * same activity receipt a Codex Desktop queued user turn produces, so the
 * coordinator settles the batch exactly as it does on Codex.
 */
export async function deliverClaudeWakes({ state, owner, threadId, activity, store = new ClaudeStore() }) {
  const items = store.drain(threadId);
  const delivered = [];
  for (const item of items) {
    const marker = wakeupMarker(item.text);
    const authorization = wakeAuthorized({ state, owner, threadId, marker });
    const turnId = randomUUID();
    if (!authorization.allowed) {
      if (authorization.batch) activity.blockWakeup({ threadId, turnId, batchId: marker });
      continue;
    }
    await activity.record({ threadId, turnId, event: 'UserPromptSubmit', wakeupMarker: marker });
    delivered.push(item.text);
  }
  return delivered;
}

export async function handleDirectorLifecycle(payload, { activityFactory = options => new DirectorActivity(options), claudeStore } = {}) {
  const event = payload?.hook_event_name;
  if (!['UserPromptSubmit', 'PostToolUse', 'Stop', 'Interrupt'].includes(event)) return { handled: false };
  const threadId = payload.session_id;
  const claudeHook = payload.turn_id === undefined && typeof payload.transcript_path === 'string';
  if (typeof threadId !== 'string' || !threadId || typeof payload.cwd !== 'string' || !payload.cwd) return { handled: false };
  if (!claudeHook && (typeof payload.turn_id !== 'string' || !payload.turn_id)) return { handled: false };

  let repo, config, state;
  try {
    repo = await inspectRepository(payload.cwd);
    config = JSON.parse(await readFile(join(repo.root, 'conductor.json'), 'utf8'));
    state = JSON.parse(await readFile(join(repo.commonDir, 'conductor', 'state.json'), 'utf8'));
  } catch { return { handled: false }; }

  const director = state.director;
  const ownership = director?.threadHostOwnership;
  const chatHost = isChatHost(ownership?.host);
  const boundThread = director?.threadId === threadId && chatHost && (!ownership.threadId || ownership.threadId === threadId);
  const pendingDestination = director?.handoff?.fromThreadId === director?.threadId && director?.handoff?.toThreadId === threadId && chatHost && (!ownership.threadId || ownership.threadId === director.threadId);
  if (config.version !== 2 || (!boundThread && !pendingDestination)) return { handled: false };

  // Only the bound director reads ownership; its corruption must surface there.
  const owner = await readOwner(repo);
  const pause = runnerPause(state, owner);

  // Reject a new submission during the final binding write. The old turn's
  // terminal receipts remain admissible; blocked handoffs still allow recovery.
  if (boundThread && director.handoff?.fromThreadId === threadId && director.handoff.status === 'switching' && event === 'UserPromptSubmit') {
    return { handled: true, error: `Conductor is switching to chat ${director.handoff.toThreadId}. This new turn was not started. Retry in that chat once the handoff completes.` };
  }

  let activity;
  try {
    activity = activityFactory({ dir: join(repo.commonDir, 'conductor') });
    const turnId = await hookTurnId(payload, activity, threadId);
    const handoff = director.handoff;
    const oldThread = boundThread && handoff?.fromThreadId === threadId && ['waiting-turn', 'blocked', 'switching'].includes(handoff.status);
    const oldTurn = oldThread && handoff.turnId === turnId;
    const destination = boundThread && event === 'PostToolUse' ? ownership?.lifecycleBaseline : null;
    const marker = event === 'UserPromptSubmit' ? wakeupMarker(payload.prompt) : null;
    if (pause && marker) {
      const authorization = wakeAuthorized({ state, owner, threadId, marker });
      if (!authorization.allowed) {
        if (authorization.batch) activity.blockWakeup({ threadId, turnId, batchId: marker });
        return { handled: true, error: `${RUNNER_PAUSED_MESSAGE}. This queued director wake was blocked before execution.` };
      }
    }
    const activityInput = { threadId, turnId, event, wakeupMarker: marker };
    if (destination) activityInput.enrollmentBaseline = destination;
    const status = await activity.record(activityInput);
    if (pendingDestination) return { handled: true, status, hookOutput: event === 'Stop' || event === 'Interrupt' ? {} : null };
    if (oldThread && (event === 'UserPromptSubmit' || (oldTurn && event === 'PostToolUse'))) {
      const handoffContext = `Conductor is handing this director to chat ${handoff.toThreadId}. Finish only the current operation, do not begin another issue or queue another wake, summarize the handoff, and end this turn. Do not wait for the replacement chat.`;
      const additionalContext = event === 'UserPromptSubmit' ? `${DIRECTOR_CONTEXT}\n\n${handoffContext}` : handoffContext;
      return { handled: true, status, hookOutput: { hookSpecificOutput: { hookEventName: event, additionalContext } } };
    }
    if (pause && ['UserPromptSubmit', 'PostToolUse'].includes(event)) {
      const additionalContext = `${DIRECTOR_CONTEXT}\n\n${RUNNER_PAUSED_MESSAGE}. Reason: ${pause.reason}. Report this state and the resume action clearly. This turn may inspect state and answer the user, but must not start workers, publish changes, or automatically resume execution. Internal events are not permission to resume. Only an explicit user resume request may run conductor resume. Finish any already-issued operation, preserve unresolved recovery, and end this turn.`;
      return { handled: true, status, hookOutput: { hookSpecificOutput: { hookEventName: event, additionalContext } } };
    }
    // Claude Code has no queue into a live chat. At the end of a director turn,
    // continue with any wake that is already queued; otherwise make sure a
    // background `conductor director-wait` will deliver the next one.
    if (event === 'Stop' && claudeHook && ownership.host === 'claude-code' && !oldThread) {
      const store = claudeStore ?? new ClaudeStore();
      const delivered = await deliverClaudeWakes({ state, owner, threadId, activity, store });
      if (delivered.length) return { handled: true, status: await activity.read(threadId), hookOutput: { decision: 'block', reason: delivered.join('\n\n') } };
      if (!store.waiter(threadId) && !payload.stop_hook_active && !pause) return { handled: true, status, hookOutput: { decision: 'block', reason: ARM_WAITER } };
    }
    if (event === 'UserPromptSubmit') {
      const context = claudeHook && ownership.host === 'claude-code' ? `${DIRECTOR_CONTEXT}\n\n${ARM_WAITER}` : DIRECTOR_CONTEXT;
      return { handled: true, status, hookOutput: { hookSpecificOutput: { hookEventName: event, additionalContext: context } } };
    }
    return { handled: true, status, hookOutput: event === 'Stop' || event === 'Interrupt' ? {} : null };
  } catch (error) {
    if (event === 'UserPromptSubmit') return { handled: true, error: `Conductor could not record this director turn, so it did not continue: ${error.message}` };
    return { handled: true, error: error.message, hookOutput: {} };
  } finally {
    activity?.close();
  }
}
