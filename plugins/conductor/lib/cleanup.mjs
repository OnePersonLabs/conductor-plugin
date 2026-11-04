import { processExists } from './process.mjs';
import { removeWorktree } from './worktrees.mjs';
import { activeHoldApplies } from './workflow.mjs';

function retentionReason(job, busy) {
  if (job.phase !== 'complete') return `Job phase is ${job.phase}`;
  if (job.deliveryReconciliationRequired) return 'Delivery still needs reconciliation';
  if (job.acceptanceComplete !== true || !job.mergedCommit || !job.deliveredHead || !job.branch) {
    return 'Job has incomplete delivery evidence';
  }
  if (job.intent || busy.has(job.issue) || processExists(job.childPid)) return 'Job still has local work in progress';
  return null;
}

async function resolveHold(holds, issue, resolveParents) {
  if (!holds.length) return { held: false };
  if (activeHoldApplies(holds, issue)) return { held: true };
  if (!resolveParents) return { reason: 'Cannot verify parent holds without repository configuration' };
  try {
    const parents = await resolveParents(issue);
    if (!Array.isArray(parents)) throw new Error('Parent lookup did not return an ancestry list');
    return { held: activeHoldApplies(holds, issue, parents) };
  } catch (error) {
    return { reason: `Could not verify parent holds: ${error.message}` };
  }
}

// The caller must own the Store before applying cleanup and must serialize
// cleanup with any operation that can take ownership of a completed worktree.
export async function cleanupWorktrees({ repoRoot, jobs, preview = false, busyIssues = [], holds = [], resolveParents, save, notice }) {
  if (!preview && typeof save !== 'function') throw new Error('Worktree cleanup requires an owned state writer');
  const outcomes = { removed: [], absent: [], retained: [], failed: [], candidates: [] };
  const busy = new Set(busyIssues);
  const activeHolds = holds.filter(hold => hold.active)
    .map(hold => ({ active: true, all: hold.all, issues: [...(hold.issues ?? [])] }));
  for (const job of jobs) {
    if (!job.worktree) continue;
    const item = { issue: job.issue, path: job.worktree };
    const ineligible = retentionReason(job, busy);
    if (ineligible) {
      outcomes.retained.push({ ...item, reason: ineligible });
      continue;
    }

    const hold = await resolveHold(activeHolds, job.issue, resolveParents);
    if (hold.held) {
      outcomes.retained.push({ ...item, reason: 'Job is held' });
      continue;
    }
    const previous = job.worktreeCleanup;
    let result;
    try {
      result = hold.reason ? { status: 'retained', reason: hold.reason } : await removeWorktree({
        repoRoot, worktreePath: job.worktree, branch: job.branch,
        head: job.deliveredHead, preview, previousGitDir: previous?.gitDir,
      });
    } catch (error) {
      result = { status: 'failed', reason: error.message };
    }
    const { status, reason, gitDir = ['failed', 'retained'].includes(status) ? previous?.gitDir : undefined } = result;
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
    notice?.(`Worktree cleanup ${status} for #${job.issue} at ${job.worktree}${reason ? `: ${reason}` : ''}`);
  }
  return outcomes;
}
