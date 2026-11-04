import { processExists } from './state.mjs';
import { removeWorktree } from './worktrees.mjs';

function retentionReason(job, busy, held) {
  if (job.phase !== 'complete') return `Job phase is ${job.phase}`;
  if (job.deliveryReconciliationRequired) return 'Delivery still needs reconciliation';
  if (job.acceptanceComplete !== true || !job.mergedCommit || !job.deliveredHead || !job.branch) {
    return 'Job has incomplete delivery evidence';
  }
  if (job.intent || busy.has(job.issue) || processExists(job.childPid)) return 'Job still has local work in progress';
  if (held.has(job.issue)) return 'Job is held';
  return null;
}

// The caller must own the Store before applying cleanup and must serialize
// cleanup with any operation that can take ownership of a completed worktree.
export async function cleanupWorktrees({ repoRoot, jobs, preview = false, busyIssues = [], heldIssues = [], save, notice }) {
  if (!preview && typeof save !== 'function') throw new Error('Worktree cleanup requires an owned state writer');
  const outcomes = { removed: [], absent: [], retained: [], failed: [], candidates: [] };
  const busy = new Set(busyIssues);
  const held = new Set(heldIssues);
  for (const job of jobs) {
    if (!job.worktree) continue;
    const item = { issue: job.issue, path: job.worktree };
    const ineligible = retentionReason(job, busy, held);
    if (ineligible) {
      outcomes.retained.push({ ...item, reason: ineligible });
      continue;
    }

    const previous = job.worktreeCleanup;
    let result;
    try {
      result = await removeWorktree({
        repoRoot, worktreePath: job.worktree, branch: job.branch,
        head: job.deliveredHead, preview, previousGitDir: previous?.gitDir,
      });
    } catch (error) {
      result = { status: 'failed', reason: error.message };
    }
    const { status, reason, gitDir = status === 'failed' ? previous?.gitDir : undefined } = result;
    const bucket = status === 'candidate' ? 'candidates' : status;
    outcomes[bucket].push(reason ? { ...item, reason } : item);
    if (preview || (status === 'absent' && previous?.status === 'removed') ||
        (status === previous?.status && reason === previous?.reason && gitDir === previous?.gitDir)) continue;
    job.worktreeCleanup = { status, ...(reason && { reason }), ...(gitDir && { gitDir }) };
    try { await save(); }
    catch (error) {
      if (previous) job.worktreeCleanup = previous;
      else delete job.worktreeCleanup;
      throw error;
    }
    if (reason) notice?.(`Worktree cleanup ${status} for #${job.issue} at ${job.worktree}: ${reason}`);
  }
  return outcomes;
}
