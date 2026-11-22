import { DirectorActivity } from './director-activity.mjs';
import { deliverClaudeWakes, readRepositoryState } from './director-lifecycle.mjs';
import { ClaudeStore } from './claude.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * `conductor director-wait`: the Claude Code stand-in for Codex Desktop's native
 * queue. The bound director runs it as a background command. It blocks until
 * the service queues a wake for this director, prints that wake and exits;
 * Claude Code then re-invokes the director with the output.
 *
 * Only the bound director session may consume its wakes. A second waiter for
 * the same session would race for the same items, so it is refused.
 */
export async function waitForDirectorWake({ cwd = process.cwd(), env = process.env, timeoutMs = 0, pollMs = 1000, store = new ClaudeStore(), activityFactory = options => new DirectorActivity(options) } = {}) {
  const { state, dir } = await readRepositoryState(cwd);
  const director = state.director;
  const threadId = director?.threadId;
  if (director?.threadHostOwnership?.host !== 'claude-code' || !threadId) throw new Error('This repository has no Claude Code chat director. Bind one with `conductor enable --host desktop --thread current` from that session.');
  if (env.CLAUDE_CODE_SESSION_ID && env.CLAUDE_CODE_SESSION_ID !== threadId) throw new Error(`Only the bound director session ${threadId} may wait for its wakes; this is session ${env.CLAUDE_CODE_SESSION_ID}.`);
  const existing = store.waiter(threadId);
  if (existing && existing.pid !== process.pid) return { status: 'already-waiting', pid: existing.pid, threadId };

  store.setWaiter(threadId, process.pid);
  const started = Date.now();
  try {
    for (;;) {
      if (store.queue(threadId).length) {
        // Re-read state for each delivery: a pause or handoff may have begun
        // while this command was waiting.
        const current = await readRepositoryState(cwd);
        const activity = activityFactory({ dir });
        try {
          const delivered = await deliverClaudeWakes({ state: current.state, owner: current.owner, threadId, activity, store });
          if (delivered.length) return { status: 'woken', threadId, text: delivered.join('\n\n') };
        } finally { activity.close(); }
      }
      if (timeoutMs > 0 && Date.now() - started >= timeoutMs) return { status: 'timeout', threadId };
      await delay(pollMs);
    }
  } finally {
    store.clearWaiter(threadId, process.pid);
  }
}
