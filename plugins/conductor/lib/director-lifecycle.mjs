import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DirectorActivity } from './director-activity.mjs';
import { inspectRepository } from './worktrees.mjs';

const DIRECTOR_CONTEXT = 'This conversation is the configured Conductor director. Follow $conductor:director for this user request, reconcile current repository and issue state, and preserve holds, pauses, and approval boundaries.';
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
  const pendingDestination = director?.handoff?.fromThreadId === director?.threadId && director.handoff.toThreadId === threadId && ownership?.host === 'codex-desktop' && (!ownership.threadId || ownership.threadId === director.threadId);
  if (config.version !== 2 || (!boundThread && !pendingDestination)) return { handled: false };

  let activity;
  try {
    activity = activityFactory({ dir: join(repo.commonDir, 'conductor') });
    const handoff = director.handoff;
    const oldThread = boundThread && handoff?.fromThreadId === threadId && ['waiting-turn', 'blocked', 'switching'].includes(handoff.status);
    const oldTurn = oldThread && handoff.turnId === turnId;
    const destination = boundThread && event === 'PostToolUse' ? ownership?.lifecycleBaseline : null;
    const activityInput = { threadId, turnId, event, wakeupMarker: event === 'UserPromptSubmit' ? wakeupMarker(payload.prompt) : null };
    if (destination) activityInput.enrollmentBaseline = destination;
    const status = await activity.record(activityInput);
    if (pendingDestination) return { handled: true, status, hookOutput: event === 'Stop' || event === 'Interrupt' ? {} : null };
    if (oldThread && (event === 'UserPromptSubmit' || (oldTurn && event === 'PostToolUse'))) {
      const handoffContext = `Conductor is handing this director to Desktop chat ${handoff.toThreadId}. Finish only the current operation, do not begin another issue or queue another wake, summarize the handoff, and end this turn. Do not wait for the replacement chat.`;
      const additionalContext = event === 'UserPromptSubmit' ? `${DIRECTOR_CONTEXT}\n\n${handoffContext}` : handoffContext;
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
