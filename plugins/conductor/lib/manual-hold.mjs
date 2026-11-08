import { readFile } from 'node:fs/promises';
import * as repositorySetup from './repository-setup.mjs';
import { inspectRepository } from './worktrees.mjs';
import { Store } from './state.mjs';
import { GitHub } from './github.mjs';
import { checkoutActivity } from './checkout-guard.mjs';
import { DEFAULT_LABELS, workflowState } from './workflow.mjs';
import { validateSetupConfig } from './config.mjs';
import { createRemoteHoldReceipt, applyRemoteHold, inspectRemoteHold, releaseRemoteHold } from './remote-holds.mjs';

function assertManualState(state, owner = null) {
  const reasons = checkoutActivity(state, owner);
  for (const job of state.jobs) if (!['complete', 'cancelled'].includes(job.phase)) reasons.push(`original issue #${job.issue} still belongs to its runtime job`);
  if (reasons.length) throw new Error(`Use the owning director controls before a manual hold: ${[...new Set(reasons)].join('; ')}.`);
}

// The GitHub comment is the only durable hold record. The existing Store lock
// prevents a manual operation from racing local runtime ownership; no state is
// written, admitted, closed, resumed or disarmed here.
export async function runManualHold(cwd, request, dependencies = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !['op', 'repository', 'issue', 'holdId', 'reason'].includes(key)) ||
      !['create', 'reconcile', 'release'].includes(request.op) || !/^[\w.-]+\/[\w.-]+$/.test(request.repository ?? '') ||
      !Number.isSafeInteger(request.issue) || request.issue < 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.holdId ?? '') ||
      (request.reason !== undefined && (typeof request.reason !== 'string' || !request.reason.trim()))) {
    throw new Error('Manual hold requires op create|reconcile|release, repository owner/repo, positive issue, stable UUID holdId and optional nonempty reason.');
  }
  const scope = await (dependencies.checkWorkScope ?? repositorySetup.checkWorkScope)(cwd, 'issues');
  if (scope.repository !== request.repository) throw new Error('Manual hold repository does not exactly match the inspected GitHub origin.');
  const repo = await (dependencies.inspectRepository ?? inspectRepository)(scope.root);
  const config = scope.configured ? validateSetupConfig(JSON.parse(await readFile(scope.configPath, 'utf8'))) : null;
  if (config && config.repository.toLowerCase() !== request.repository.toLowerCase()) throw new Error('Repository configuration changed during manual hold inspection.');
  const labels = config?.labels ?? DEFAULT_LABELS;
  const store = dependencies.store ?? new Store(repo.commonDir);
  assertManualState(await store.read(), await store.owner());
  await store.acquire();
  try {
    const assertOwned = async () => {
      if ((await store.owner())?.token !== store.token) throw new Error('Manual hold no longer owns the repository lock; reconcile the remote result before retrying.');
      assertManualState(await store.read());
    };
    await assertOwned();
    const state = await store.read();
    if (request.op !== 'reconcile' && state.holds?.some(hold => hold.active && hold.id === request.holdId)) throw new Error('This hold belongs to the runtime snapshot; use the owning director controls.');
    const github = dependencies.github ?? new GitHub(request.repository, { cwd: repo.root });
    const target = { number: request.issue, holdId: request.holdId, labels };
    if (request.op === 'create') {
      const issue = await github.issue(request.issue);
      await createRemoteHoldReceipt(github, { ...target, reason: request.reason, previous: workflowState(issue, labels).state }, assertOwned);
      await applyRemoteHold(github, target, assertOwned);
    } else if (request.op === 'release') {
      const otherHold = state.holds?.some(hold => hold.active && hold.id !== request.holdId && (hold.all || hold.issues?.includes(request.issue))) ?? false;
      await releaseRemoteHold(github, { ...target, otherHold }, assertOwned);
    }
    const result = await inspectRemoteHold(github, target);
    if (request.op === 'create' && result.state !== 'held') throw new Error('Manual hold was not established; preserve its receipt and reconcile before closing or editing dependent work.');
    return { repository: request.repository, ...result };
  } finally { await store.release(); }
}
