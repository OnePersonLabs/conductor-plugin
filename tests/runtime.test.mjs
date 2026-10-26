import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { git } from '../plugins/symphony-lite/lib/process.mjs';
import { validateConfig, duration } from '../plugins/symphony-lite/lib/config.mjs';
import { admission, WakeLoop } from '../plugins/symphony-lite/lib/scheduler.mjs';
import { Store, atomicJSON } from '../plugins/symphony-lite/lib/state.mjs';
import { GitHub, checkState } from '../plugins/symphony-lite/lib/github.mjs';
import { Coordinator } from '../plugins/symphony-lite/lib/coordinator.mjs';
import { inspectRepository, createWorktree } from '../plugins/symphony-lite/lib/worktrees.mjs';
import { parseArgs } from '../plugins/symphony-lite/bin/symphony-lite.mjs';

const issue = (number, labels = ['symphony:ready']) => ({ number, title: `Task ${number}`, body: `Write task ${number}`, state: 'open', labels, created_at: '2026-01-01' });
const config = () => validateConfig({ repository: 'example/project', baseBranch: 'main', authorized: true, checks: [{ command: process.execPath, args: ['check.mjs'] }] });
async function until(predicate, message = 'condition', timeout = 15000) {
  const end = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() > end) throw new Error(`Timed out waiting for ${message}`); await delay(10); }
}

test('capacity includes waiting/blocked work; priorities and ties are deterministic', () => {
  const settings = { ...config(), agents: 3, priorityLabels: ['P0','P1'] };
  const candidates = [issue(4), issue(3, ['P1']), issue(2, ['P0']), issue(1, ['P0'])];
  assert.deepEqual(admission(candidates, [{ issue: 9, phase: 'waiting' }, { issue: 8, phase: 'blocked' }], settings).map(x => x.number), [1]);
  assert.deepEqual(admission(candidates, [{ issue: 1, phase: 'cancelled' }], settings).map(x => x.number), [2,3,4]);
  assert.equal(duration('5m'), 300000);
  assert.throws(() => validateConfig({ ...config(), authorized: false }), /authorized/);
  assert.throws(() => validateConfig({ ...config(), prepare: {} }), /array/);
  assert.equal(parseArgs(['--agents','2','--poll-interval','5m']).overrides.agents, 2);
  assert.throws(() => parseArgs(['cancel','x']), /positive/);
});

test('timer, signal and Enter share one coalescing wake operation', async () => {
  let scans = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  const loop = new WakeLoop(async () => { scans++; if (scans === 1) await held; });
  const first = loop.wake();
  await delay(1);
  const timer = setInterval(() => loop.wake(), 2);
  for (let i = 0; i < 20; i++) loop.wake();
  await delay(10); clearInterval(timer); release(); await first;
  assert.equal(scans, 2);
  await loop.close(); await loop.wake(); assert.equal(scans, 2);
});

test('physical repository lock and queued controls survive process restart without duplicate ownership', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'symphony-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = new Store(dir), b = new Store(dir);
  await a.acquire(); await assert.rejects(() => b.acquire(), /owns this repository/);
  await a.save({ version: 1, jobs: [{ issue: 1, threadId: 'original' }] });
  await b.send('signal'); await b.send('cancel', 1);
  assert.deepEqual((await a.drain()).map(x => x.command).sort(), ['cancel','signal']);
  assert.equal((await b.read()).jobs[0].threadId, 'original');
  await a.release(); await b.acquire(); await b.release();
  await atomicJSON(a.lockPath, { token: 'foreign', hostname: hostname(), platform: 'different', pid: 99999999 });
  await assert.rejects(() => b.acquire(), /owns this repository/);
});

test('feedback ignores stale heads and coordinator records; all failed checks block landing', async () => {
  const api = new GitHub('example/project');
  api.pages = async path => path.includes('/reviews?') ? [
    { id: 1, state: 'CHANGES_REQUESTED', commit_id: 'old', body: 'stale', user: {} },
    { id: 2, state: 'CHANGES_REQUESTED', commit_id: 'current', body: 'fix', user: {} },
  ] : path.includes('/pulls/') ? [{ id: 3, commit_id: 'old', body: 'old inline', user: {} }] : [
    { id: 4, body: '<!-- symphony-lite:1 -->\nwaiting', user: {} },
    { id: 5, body: 'New evidence', user: {}, updated_at: 'now' },
  ];
  const feedback = await api.feedback(7, 'current');
  assert.deepEqual(feedback.items.map(x => x.body).sort(), ['New evidence','fix']);
  assert.equal(checkState({ statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }] }).failed.length, 1);
  assert.equal(checkState({ statusCheckRollup: [{ __typename: 'StatusContext', state: 'PENDING' }] }).pending, true);
});

async function fixture(t, { agents = 1, hold = false, maxTurns } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'symphony-runtime-'));
  const root = join(dir, 'source'), remote = join(dir, 'remote.git');
  await mkdir(root); await git(dir, 'init', '--bare', '--initial-branch=main', remote);
  await git(root, 'init', '--initial-branch=main');
  await git(root, 'config', 'user.name', 'Fixture'); await git(root, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(root, 'check.mjs'), "import {existsSync} from 'node:fs'; if(existsSync('fail-check')) process.exit(1);\n");
  await git(root, 'add', 'check.mjs'); await git(root, 'commit', '-m', 'Fixture');
  await git(root, 'remote', 'add', 'origin', remote); await git(root, 'push', '-u', 'origin', 'main');
  const repo = await inspectRepository(root);
  const world = { issues: [issue(1), issue(2), issue(3)], pulls: new Map(), threads: new Map(), starts: 0, resumes: [], turns: 0, closed: [], merges: [], hold, blockers: new Set(), clients: [], coordinators: [] };
  class Client extends EventEmitter {
    constructor({ cwd }) { super(); this.cwd = cwd; this.pid = undefined; world.clients.push(this); }
    async connect() {}
    async startThread() { this.threadId = `thread-${++world.starts}`; world.threads.set(this.threadId, { turns: [] }); return { id: this.threadId }; }
    async readThread({ threadId }) { return world.threads.get(threadId); }
    async resumeThread({ threadId }) { this.threadId = threadId; world.resumes.push(threadId); return { id: threadId }; }
    async startTurn() {
      const id = `turn-${++world.turns}`;
      world.threads.get(this.threadId).turns = [{ id, status: 'inProgress' }];
      if (world.hold === 'launch') return new Promise((resolve, reject) => { this.launchResolve = resolve; this.launchReject = reject; });
      if (!world.hold) this.completion = this.finish(id);
      return { id };
    }
    async finish(id) {
      await delay(1);
      if (this.closed) return;
      try {
        await writeFile(join(this.cwd, `${this.threadId}.txt`), `turn ${id}\n`);
        if (world.failFirstCheck && id === 'turn-1') await writeFile(join(this.cwd, 'fail-check'), 'reproduce');
        else if (world.failFirstCheck) await rm(join(this.cwd, 'fail-check'), { force: true });
        if (world.failFirstCheck) await git(this.cwd, 'add', '-A');
        await git(this.cwd, 'add', `${this.threadId}.txt`); await git(this.cwd, 'commit', '-m', `Implement ${id}`);
        world.threads.get(this.threadId).turns = [{ id, status: 'completed' }];
        this.emit('notification', { method: 'item/completed', params: { threadId: this.threadId, item: { type: 'agentMessage', text: JSON.stringify({ disposition: 'ready_for_review', summary: 'Acceptance demonstrated', acceptanceComplete: true }) } } });
        this.emit('notification', { method: 'turn/completed', params: { threadId: this.threadId, turn: { id, status: 'completed' } } });
      } catch (error) { this.emit('error', error); }
    }
    async interrupt() { this.interrupted = true; world.threads.get(this.threadId).turns.forEach(turn => { turn.status = 'interrupted'; }); }
    async close() { if (this.closed) return; this.closed = true; this.launchReject?.(new Error('Server closed during launch')); if (this.threadId) world.threads.get(this.threadId).turns.forEach(turn => { if (turn.status === 'inProgress') turn.status = 'interrupted'; }); this.emit('exit', { code: 0 }); }
    async respond(id, response) { this.response = { id, response }; }
  }
  const github = {
    ready: async () => world.issues.filter(x => x.state === 'open'),
    issue: async n => world.issues.find(x => x.number === n),
    blockers: async n => world.blockers.has(n) ? [{ state: 'open' }] : [],
    pullForBranch: async branch => [...world.pulls.values()].find(p => p.branch === branch),
    createPull: async job => { let p = [...world.pulls.values()].find(p => p.branch === job.branch); const head = await git(job.worktree, 'rev-parse', 'HEAD'); if (!p) { p = { number: job.issue + 10, branch: job.branch, baseRefName: 'main', state: 'OPEN', isDraft: false, feedback: [], statusCheckRollup: [{ __typename: 'StatusContext', state: 'PENDING' }] }; world.pulls.set(p.number, p); } p.headRefOid = head; return p; },
    pull: async n => { const p = world.pulls.get(n); p.headRefOid = await git(remote, 'rev-parse', `refs/heads/${p.branch}`); return { ...p }; },
    feedback: async n => ({ items: world.pulls.get(n).feedback, hash: JSON.stringify(world.pulls.get(n).feedback) }),
    progress: async () => {}, approvals: async () => ({ approved: 0, changesRequested: false }),
    merge: async n => { const p = world.pulls.get(n); world.merges.push(n); p.autoMergeRequest = {}; },
    disableAutoMerge: async n => { world.pulls.get(n).autoMergeRequest = null; },
    closeIssue: async n => { world.closed.push(n); world.issues.find(i => i.number === n).state = 'closed'; },
  };
  function coordinator() {
    const c = new Coordinator({ repo, config: { ...config(), agents, maxTurns }, store: new Store(repo.commonDir), github, Client });
    c.preflight = async () => {};
    c.on('notice', message => { world.notice = message; }); world.coordinators.push(c); return c;
  }
  t.after(async () => { for (const c of world.coordinators) if (c.state) await c.stop(); await rm(dir, { recursive: true, force: true }); });
  return { root, remote, repo, world, github, coordinator };
}

test('parallel owners retain slots while idle; dependencies skip; serialized landing refreshes accepted base', async t => {
  const { world, remote, coordinator } = await fixture(t, { agents: 2 });
  world.blockers.add(1);
  const c = coordinator(); await c.start();
  await until(() => c.state.jobs.length === 2 && c.state.jobs.every(j => j.phase === 'waiting'), 'two waiting PRs');
  assert.deepEqual(c.state.jobs.map(j => j.issue), [2,3]);
  assert.notEqual(c.state.jobs[0].threadId, c.state.jobs[1].threadId);
  assert.notEqual(c.state.jobs[0].worktree, c.state.jobs[1].worktree);
  const count = world.turns; await Promise.all(Array.from({ length: 10 }, () => c.wake()));
  assert.equal(world.turns, count);
  for (const p of world.pulls.values()) p.statusCheckRollup = [];
  await c.wake(); assert.equal(world.merges.length, 1);
  const first = world.pulls.get(world.merges[0]);
  await git(remote, 'update-ref', 'refs/heads/main', first.headRefOid);
  first.state = 'MERGED'; first.mergeCommit = { oid: first.headRefOid };
  await c.wake(); await c.wake();
  assert.deepEqual(world.closed, [2]);
  assert.equal(world.merges.length, 2);
  const second = c.state.jobs.find(j => j.issue === 3);
  assert.equal(second.checkBase, first.headRefOid);
  assert.equal(world.turns, count);
});

test('review repairs reuse original thread; duplicate feedback is idle; closed unmerged PR never closes issue', async t => {
  const { world, coordinator } = await fixture(t);
  const c = coordinator(); await c.start(); await until(() => c.state.jobs[0]?.phase === 'waiting');
  const job = c.state.jobs[0], original = job.threadId, p = world.pulls.get(job.pr);
  p.feedback = [{ kind: 'conversation', id: 4, body: 'Repair acceptance', updated: 'now' }];
  await c.wake(); await until(() => world.turns === 2 && job.phase === 'waiting');
  assert.deepEqual(world.resumes, [original]);
  await c.wake(); assert.equal(world.turns, 2);
  p.state = 'CLOSED'; await c.wake(); assert.equal(job.phase, 'blocked'); assert.deepEqual(world.closed, []);
});

test('stop during launch and restart recover original thread; Enter cannot approve a server request', async t => {
  const { world, coordinator } = await fixture(t, { hold: 'launch' });
  const c = coordinator(); await c.start(); await until(() => c.state.jobs[0]?.phase === 'launching' && world.clients[0].launchReject);
  const job = c.state.jobs[0]; const original = job.threadId;
  world.clients[0].emit('request', { id: 99, method: 'item/commandExecution/requestApproval', params: { command: 'example' } });
  await c.wake(); assert.equal(world.clients[0].response, undefined);
  await assert.rejects(() => c.answer('1:99', ''), /explicitly/);
  await c.answer('1:99', 'decline'); assert.deepEqual(world.clients[0].response.response, { decision: 'decline' });
  await c.stop(); assert.equal(job.phase, 'stopped');
  world.hold = false;
  const resumed = coordinator(); await resumed.start(); await until(() => resumed.state.jobs[0]?.phase === 'waiting');
  assert.equal(resumed.state.jobs[0].threadId, original); assert.equal(world.starts, 1);
});

test('cancel interrupts a pending launch, preserves source, and suppresses redispatch', async t => {
  const { world, coordinator } = await fixture(t, { hold: 'launch' });
  const c = coordinator(); await c.start(); await until(() => world.clients[0]?.launchReject);
  const job = c.state.jobs[0]; await c.cancel(1);
  assert.equal(job.phase, 'cancelled'); assert.equal(await git(job.worktree, 'branch', '--show-current'), 'symphony/issue-1');
  world.issues = [issue(1)]; await c.wake(); assert.equal(world.starts, 1);
});

test('cancelling native auto-merge disarms it before freeing serialized landing', async t => {
  const { world, coordinator } = await fixture(t, { agents: 2 });
  world.issues = world.issues.slice(0, 2);
  const c = coordinator(); await c.start(); await until(() => c.state.jobs.length === 2 && c.state.jobs.every(j => j.phase === 'waiting'));
  for (const p of world.pulls.values()) p.statusCheckRollup = [];
  await c.wake(); assert.equal(world.merges.length, 1);
  const first = c.state.jobs.find(j => j.mergeArmed);
  await c.cancel(first.issue); await c.wake();
  assert.equal(world.pulls.get(first.pr).autoMergeRequest, null);
  assert.equal(world.merges.length, 2);
});

test('a failed local check goes back to the same builder and invalidates its check receipt', async t => {
  const { world, coordinator } = await fixture(t);
  world.failFirstCheck = true;
  const c = coordinator(); await c.start();
  await until(() => c.state.jobs[0]?.phase === 'waiting', 'repaired local check');
  const job = c.state.jobs[0];
  assert.equal(world.turns, 2); assert.equal(world.starts, 1);
  assert.equal(world.resumes[0], job.threadId);
  assert.equal(job.checkHead, await git(job.worktree, 'rev-parse', 'HEAD'));
});

test('a configured total turn cap blocks a repair without launching another model turn', async t => {
  const { world, coordinator } = await fixture(t, { maxTurns: 1 });
  const c = coordinator(); await c.start(); await until(() => c.state.jobs[0]?.phase === 'waiting');
  const job = c.state.jobs[0];
  world.pulls.get(job.pr).feedback = [{ id: 1, body: 'Repair this' }];
  await c.wake(); await until(() => job.phase === 'blocked');
  assert.equal(world.turns, 1); assert.match(job.lastError, /budget exhausted/);
});

test('interrupted preparation adopts the already-owned worktree only on explicit resume', async t => {
  const { root, repo, world, coordinator } = await fixture(t);
  world.issues = [issue(1)];
  const worktree = join(root, '..', 'interrupted-worktree');
  await createWorktree({ repoRoot: root, path: worktree, branch: 'symphony/issue-1', baseRef: 'HEAD' });
  const store = new Store(repo.commonDir); await store.initialize();
  await store.save({ version: 1, jobs: [{ issue: 1, branch: 'symphony/issue-1', baseBranch: 'main', worktree, phase: 'preparing', threadId: null }] });
  const c = coordinator(); await c.start();
  assert.equal(c.state.jobs[0].phase, 'uncertain'); assert.equal(world.turns, 0);
  await c.resume(1); await until(() => c.state.jobs[0].phase === 'waiting');
  assert.equal(c.state.jobs[0].worktree, worktree); assert.equal(world.starts, 1);
});

test('an armed PR that becomes CLEAN is reconciled to actual delivery without another builder turn', async t => {
  const { world, github, remote, coordinator } = await fixture(t);
  world.issues = [issue(1)];
  const c = coordinator(); await c.start(); await until(() => c.state.jobs[0]?.phase === 'waiting');
  const job = c.state.jobs[0], pull = world.pulls.get(job.pr);
  pull.statusCheckRollup = []; await c.wake(); assert.equal(job.mergeArmed, true);
  github.merge = async () => {
    await git(remote, 'update-ref', 'refs/heads/main', pull.headRefOid);
    pull.state = 'MERGED'; pull.mergeCommit = { oid: pull.headRefOid };
  };
  pull.mergeStateStatus = 'CLEAN'; await c.wake(); await c.wake();
  assert.equal(job.phase, 'complete'); assert.deepEqual(world.closed, [1]); assert.equal(world.turns, 1);
});
