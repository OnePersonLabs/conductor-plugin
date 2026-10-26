import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Coordinator } from '../plugins/symphony-lite/lib/coordinator.mjs';
import { validateConfig } from '../plugins/symphony-lite/lib/config.mjs';
import { Store } from '../plugins/symphony-lite/lib/state.mjs';
import { git } from '../plugins/symphony-lite/lib/process.mjs';
import { inspectRepository } from '../plugins/symphony-lite/lib/worktrees.mjs';

const issue = number => ({ number, title: `Task ${number}`, body: 'Finish the accepted task.', state: 'open', labels: ['symphony:ready'] });
const config = () => validateConfig({
  repository: 'example/project', baseBranch: 'main', authorized: true,
  checks: [{ command: process.execPath, args: ['check.mjs'] }],
});

async function repository(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'symphony-recovery-'));
  const root = path.join(temp, 'source repo');
  const remote = path.join(temp, 'remote.git');
  await mkdir(root);
  await git(temp, 'init', '--bare', '--initial-branch=main', remote);
  await git(root, 'init', '--initial-branch=main');
  await git(root, 'config', 'user.name', 'Fixture');
  await git(root, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(root, 'check.mjs'), '');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'fixture');
  await git(root, 'remote', 'add', 'origin', remote);
  await git(root, 'push', '-u', 'origin', 'main');
  const repo = await inspectRepository(root);
  t.after(() => rm(temp, { recursive: true, force: true }));
  return { temp, root, remote, repo };
}

function coordinator({ repo, store = { save: async () => {} }, github, Client = class extends EventEmitter {} }) {
  const instance = new Coordinator({ repo, config: config(), store, github, Client });
  instance.preflight = async () => {};
  instance.base = async () => 'fixture-base';
  return instance;
}

test('failed repair launch retains exact pending PR feedback through explicit resume', async t => {
  const { repo } = await repository(t);
  const store = new Store(repo.commonDir);
  await store.initialize();
  const seenPrompts = [], resumedThreads = [];
  class Client extends EventEmitter {
    constructor({ cwd }) { super(); this.cwd = cwd; this.pid = undefined; }
    async connect() {}
    async readThread() { return { turns: [] }; }
    async resumeThread({ threadId }) { resumedThreads.push(threadId); return { id: threadId }; }
    async startTurn({ prompt }) { seenPrompts.push(prompt); throw new Error('injected startTurn failure'); }
    async close() { this.emit('exit', { code: 0 }); }
  }
  const original = issue(7);
  const feedback = [{ kind: 'conversation', id: 91, body: 'Keep the export error visible to callers.', updated: '2026-10-26T00:00:00Z' }];
  const github = {
    issue: async () => original,
    pull: async () => ({ number: 17, state: 'OPEN', baseRefName: 'main', headRefOid: 'same-head', isDraft: false, reviewDecision: null, statusCheckRollup: [] }),
    feedback: async () => ({ items: feedback, hash: 'feedback-hash' }),
    ready: async () => [], blockers: async () => [], progress: async () => {},
  };
  const c = coordinator({ repo, store, github, Client });
  c.state = { version: 1, repository: 'example/project', jobs: [] };
  c.wake = async () => {};
  const job = {
    issue: 7, branch: 'symphony/issue-7', worktree: repo.root, phase: 'waiting',
    threadId: 'original-thread', prepared: true, pr: 17, acceptanceComplete: true,
    checkBase: 'fixture-base', checkHead: 'same-head', feedbackSeen: [], pendingFeedback: [],
  };
  c.state.jobs.push(job);

  await c.reconcilePull(job, 'fixture-base');
  await c.tasks.get(7);
  assert.equal(job.phase, 'uncertain');
  assert.deepEqual(job.pendingFeedback, feedback);
  assert.deepEqual((await store.read()).jobs[0].pendingFeedback, feedback);

  await c.resume(7);
  assert.equal(job.phase, 'stopped');
  await c.scan();
  await c.tasks.get(7);
  assert.equal(seenPrompts.length, 2);
  assert.ok(seenPrompts.every(prompt => prompt.includes(feedback[0].body)));
  assert.deepEqual(resumedThreads, ['original-thread', 'original-thread']);
});

test('cancel intent wins over an in-flight PR reconciliation before auto-merge can arm', async t => {
  const { repo } = await repository(t);
  let pullCalls = 0, releaseFresh;
  let freshPullStarted;
  const freshStarted = new Promise(resolve => { freshPullStarted = resolve; });
  const freshGate = new Promise(resolve => { releaseFresh = resolve; });
  let merges = 0;
  const pull = { number: 18, state: 'OPEN', baseRefName: 'main', headRefOid: await git(repo.root, 'rev-parse', 'HEAD'), isDraft: false, reviewDecision: null, statusCheckRollup: [], autoMergeRequest: null };
  const github = {
    pull: async () => {
      pullCalls++;
      if (pullCalls === 2) { freshPullStarted(); await freshGate; }
      return { ...pull };
    },
    feedback: async () => ({ items: [], hash: 'empty' }),
    approvals: async () => ({ approved: 0, changesRequested: false }),
    merge: async () => { merges++; pull.autoMergeRequest = {}; },
    disableAutoMerge: async () => { pull.autoMergeRequest = null; },
    progress: async () => {}, issue: async () => issue(8),
  };
  const c = coordinator({ repo, github });
  c.state = { version: 1, repository: 'example/project', jobs: [] };
  c.wake = async () => {};
  const job = {
    issue: 8, branch: 'symphony/issue-8', worktree: repo.root, phase: 'waiting',
    threadId: 'thread-8', prepared: true, pr: 18, acceptanceComplete: true,
    checkBase: 'fixture-base', checkHead: pull.headRefOid, feedbackSeen: [],
  };
  c.state.jobs.push(job);

  const reconcile = c.deliveryAction(() => c.reconcilePull(job, 'fixture-base'));
  await freshStarted;
  const cancellation = c.cancel(8);
  assert.equal(job.intent, 'cancel');
  assert.equal(job.phase, 'cancelling');
  releaseFresh();
  await Promise.all([reconcile, cancellation]);
  assert.equal(merges, 0);
  assert.equal(job.phase, 'cancelled');
  assert.equal(job.mergeArmed, false);
});

test('PR merged during disarm returns to delivery reconciliation instead of remaining cancelling', async t => {
  const { repo } = await repository(t);
  const head = await git(repo.root, 'rev-parse', 'HEAD');
  const pull = { number: 19, state: 'OPEN', baseRefName: 'main', headRefOid: head, mergeCommit: { oid: head }, isDraft: false, reviewDecision: null, statusCheckRollup: [], autoMergeRequest: {} };
  const github = {
    pull: async () => ({ ...pull }),
    disableAutoMerge: async () => { pull.state = 'MERGED'; pull.autoMergeRequest = null; },
    feedback: async () => ({ items: [], hash: 'empty' }),
    approvals: async () => ({ approved: 0, changesRequested: false }),
    merge: async () => assert.fail('A landed PR must not be armed again.'),
    closeIssue: async () => { github.closed = true; },
    progress: async () => {}, issue: async () => issue(9),
  };
  const c = coordinator({ repo, github });
  c.base = async () => head;
  c.state = { version: 1, repository: 'example/project', jobs: [] };
  c.wake = async () => {};
  const job = {
    issue: 9, branch: 'symphony/issue-9', worktree: repo.root, phase: 'waiting',
    threadId: 'thread-9', prepared: true, pr: 19, acceptanceComplete: true,
    checkBase: head, checkHead: head, mergeArmed: true, feedbackSeen: [],
  };
  c.state.jobs.push(job);

  await assert.rejects(c.cancel(9), /cannot be cancelled because PR #19 already landed/);
  assert.equal(job.phase, 'waiting');
  assert.equal(job.intent, null);
  await c.reconcilePull(job, head);
  assert.equal(job.phase, 'complete');
  assert.equal(job.mergedCommit, head);
  assert.equal(github.closed, true);
});

test('queued control survives a crash and remains pending when acknowledgement loses ownership', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-controls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prior = new Store(dir), recovered = new Store(dir);
  await prior.acquire();
  const request = await recovered.send('cancel', 12);
  assert.equal((await prior.drain())[0].id, request.id);
  await prior.release(); // Simulate a crash after reading but before acknowledging.

  await recovered.acquire();
  const pending = await recovered.drain();
  assert.equal(pending[0].id, request.id);
  await recovered.release(); // Simulate ownership expiring before command acknowledgement.
  await assert.rejects(recovered.acknowledge(request), /ownership ended/);
  await recovered.acquire();
  assert.equal((await recovered.drain())[0].id, request.id);
  await recovered.acknowledge(request);
  assert.deepEqual(await recovered.drain(), []);
  assert.equal((await recovered.results())[0].id, request.id);
  await recovered.release();
});

test('stop in the startup hook releases ownership before the first admission scan', async t => {
  const { repo } = await repository(t);
  const store = new Store(repo.commonDir);
  let readyCalls = 0;
  const github = { ready: async () => { readyCalls++; return [issue(1)]; } };
  const c = coordinator({ repo, store, github });
  await c.start({ beforeScan: async () => c.stop() });
  assert.equal(readyCalls, 0);
  assert.deepEqual(c.state.jobs, []);
  assert.equal(c.state.running, false);
  assert.equal(await store.owner(), null);
});

test('uncertain thread recovery is scoped to the exact worktree and requires explicit choice when ambiguous', async t => {
  const { repo } = await repository(t);
  const requested = [];
  class Client extends EventEmitter {
    constructor({ cwd }) { super(); this.cwd = cwd; }
    async connect() {}
    async listThreads({ cwd }) { requested.push(cwd); return [{ id: 'thread-a' }, { id: 'thread-b' }]; }
    async readThread({ threadId }) { return { id: threadId, turns: [] }; }
    async close() {}
  }
  const github = { issue: async () => issue(22) };
  const c = coordinator({ repo, github, Client });
  c.state = { version: 1, repository: 'example/project', jobs: [] };
  c.wake = async () => {};
  const job = { issue: 22, branch: 'symphony/issue-22', worktree: repo.root, phase: 'uncertain', prepared: true, threadId: null };
  c.state.jobs.push(job);

  await assert.rejects(c.resume(22), /ownership is uncertain/);
  assert.equal(job.threadId, null);
  await assert.rejects(c.resume(22, 'thread-outside-worktree'), /does not belong/);
  await c.resume(22, 'thread-b');
  assert.equal(job.threadId, 'thread-b');
  assert.ok(requested.every(cwd => cwd === repo.root));
});
