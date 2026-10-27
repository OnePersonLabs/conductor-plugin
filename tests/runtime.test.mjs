import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { git, run } from '../plugins/symphony-lite/lib/process.mjs';
import { validateConfig, duration } from '../plugins/symphony-lite/lib/config.mjs';
import { admission, WakeLoop } from '../plugins/symphony-lite/lib/scheduler.mjs';
import { Store, atomicJSON } from '../plugins/symphony-lite/lib/state.mjs';
import { GitHub, checkState } from '../plugins/symphony-lite/lib/github.mjs';
import { Coordinator, reviewerIsolationConfig } from '../plugins/symphony-lite/lib/coordinator.mjs';
import { createRequestRevision, parseReviewResult } from '../plugins/symphony-lite/lib/prompts.mjs';
import { inspectRepository, createWorktree } from '../plugins/symphony-lite/lib/worktrees.mjs';
import { parseArgs } from '../plugins/symphony-lite/bin/symphony-lite.mjs';

const issue = (number, labels = ['symphony:ready']) => ({ number, title: `Task ${number}`, body: `Write task ${number}`, state: 'open', labels, created_at: '2026-01-01' });
const config = () => validateConfig({ repository: 'example/project', baseBranch: 'main', authorized: true, reviewEnabled: false, checks: [{ command: process.execPath, args: ['check.mjs'] }] });

test('npm-style linked CLI executes its entry point through spaces and Unicode', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'symphony-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const alias = join(dir, 'linked package café');
  await symlink(fileURLToPath(new URL('../plugins/symphony-lite', import.meta.url)), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await run(process.execPath, [join(alias, 'bin/symphony-lite.mjs'), '--version'], { cwd: dir });
  assert.equal(result.stdout.trim(), '0.1.0');
});
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
  assert.throws(() => validateConfig({ repository: 'example/project', baseBranch: 'main', authorized: true, checks: [{}] }), /checks entries need command/);
  assert.equal(validateConfig({ repository: 'example/project', baseBranch: 'main', authorized: true, checks: [{ command: 'node', args: [] }] }).reviewEnabled, true);
  assert.throws(() => validateConfig({ ...config(), reviewInstructions: false }), /reviewInstructions must be a string/);
  assert.throws(() => validateConfig({ ...config(), reviewEnabled: 'yes' }), /reviewEnabled must be a boolean/);
  assert.equal(parseArgs(['--agents','2','--poll-interval','5m']).overrides.agents, 2);
  assert.deepEqual(parseArgs(['resume','3','--role','reviewer','--thread','review-3']), { command: 'resume', overrides: {}, issue: 3, role: 'reviewer', threadId: 'review-3' });
  assert.throws(() => parseArgs(['cancel','x']), /positive/);
});

test('reviewer isolation disables configured MCP servers, Apps and plugins without reading credentials', () => {
  assert.deepEqual(reviewerIsolationConfig({ config: { additional: {
    mcp_servers: { github: { command: 'hidden' }, linear: {} },
    apps: { github: { enabled: true } },
    plugins: { 'review-tools@local': { enabled: true } },
  } } }), {
    'apps._default.enabled': false,
    'plugins._default.enabled': false,
    'mcp_servers.github': { enabled: false },
    'mcp_servers.linear': { enabled: false },
    'apps.github.enabled': false,
    'plugins.review-tools@local.enabled': false,
  });
  assert.throws(() => reviewerIsolationConfig(null), /read-only reviewer/);
});

test('request revision ignores labels but changes with request content; review results fail closed', () => {
  const request = issue(9);
  assert.equal(createRequestRevision(request), createRequestRevision({ ...request, labels: ['different', 'labels'] }));
  assert.notEqual(createRequestRevision(request), createRequestRevision({ ...request, body: `${request.body}\nMore acceptance.` }));
  assert.throws(() => parseReviewResult('not JSON'), /valid structured result/);
  assert.throws(() => parseReviewResult('{"status":"clear"}'), /lacks status, summary, or findings/);
  assert.equal(parseReviewResult(JSON.stringify({ status: 'blocked', summary: 'Cannot establish a meaningful location.', findings: [] })).status, 'blocked');
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
    { id: 6, state: 'CHANGES_REQUESTED', commit_id: 'current', body: 'bot finding', user: { type: 'Bot' } },
    { id: 8, state: 'COMMENTED', commit_id: 'current', body: 'Bot summary feedback', user: { type: 'Bot' } },
    { id: 9, state: 'COMMENTED', commit_id: 'current', body: '  ', user: { type: 'Bot' } },
  ] : path.includes('/pulls/') ? [{ id: 3, commit_id: 'old', body: 'old inline', user: {} }] : [
    { id: 4, body: '<!-- symphony-lite:1 -->\nwaiting', user: {} },
    { id: 7, body: '<!-- symphony-lite:review:7:1:current -->\nalready processed', user: { type: 'Bot' } },
    { id: 5, body: 'New evidence', user: {}, updated_at: 'now' },
  ];
  const feedback = await api.feedback(7, 'current');
  assert.deepEqual(feedback.items.map(x => x.body).sort(), ['Bot summary feedback','New evidence','bot finding','fix']);
  assert.equal(checkState({ statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }] }).failed.length, 1);
  assert.equal(checkState({ statusCheckRollup: [{ __typename: 'StatusContext', state: 'PENDING' }] }).pending, true);
});

test('PR review publication sends GitHub comments as a JSON array and reconciles retries by marker', async () => {
  const calls = [];
  let receipt = null;
  const diff = 'diff --git a/src/example.mjs b/src/example.mjs\n--- a/src/example.mjs\n+++ b/src/example.mjs\n@@ -1 +1 @@\n-old\n+new\n';
  const api = new GitHub('example/project', { execute: async (command, args, options) => {
    calls.push({ command, args, input: options.input });
    if (args[0] === 'pr' && args[1] === 'diff') return { stdout: diff };
    if (args[0] === 'api' && args[1].includes('/reviews?')) return { stdout: JSON.stringify([receipt ? [receipt] : []]) };
    if (args[0] === 'api' && args.includes('--input')) {
      const payload = JSON.parse(options.input);
      receipt = { id: 81, commit_id: payload.commit_id, body: payload.body };
      return { stdout: JSON.stringify(receipt) };
    }
    if (args[0] === 'api' && args[1].includes('/comments?')) return { stdout: JSON.stringify([[]]) };
    assert.fail(`Unexpected gh call: ${args.join(' ')}`);
  } });
  const result = { status: 'findings', summary: 'One fix is needed.', findings: [{ title: 'Handle the error', body: 'Preserve the original failure.', priority: 'P1', location: { path: 'src/example.mjs', startLine: 1, endLine: 1 } }] };
  await api.submitReview(11, { attempt: 1, head: 'abc123', result });
  const post = calls.find(call => call.args.includes('--input'));
  const payload = JSON.parse(post.input);
  assert.equal(post.args.at(-1), '-');
  assert.equal(payload.commit_id, 'abc123');
  assert.equal(payload.event, 'COMMENT');
  assert.ok(Array.isArray(payload.comments));
  assert.deepEqual(payload.comments.map(({ path, line, side }) => ({ path, line, side })), [{ path: 'src/example.mjs', line: 1, side: 'RIGHT' }]);
  const postCount = calls.filter(call => call.args.includes('--input')).length;
  await api.submitReview(11, { attempt: 1, head: 'abc123', result });
  assert.equal(calls.filter(call => call.args.includes('--input')).length, postCount);
});

test('saved review result is superseded when mutable request revision advanced ahead of its captured revision', async t => {
  const { world, coordinator } = await fixture(t);
  const c = coordinator();
  world.issues[0].body = 'Revised request after interrupted publication.';
  const oldRevision = createRequestRevision(issue(1));
  const job = {
    issue: 1, pr: 11, phase: 'blocked', requestRevision: createRequestRevision(world.issues[0]), reviewResultRevision: oldRevision, reviewPublicationStatus: 'pending',
    reviewAttempt: 2, reviewHead: 'saved-head', reviewResult: { status: 'findings', summary: 'Old request result.', findings: [] },
    worktree: world.root, branch: 'symphony/issue-1',
  };
  c.state = { version: 1, repository: 'example/project', jobs: [job] };
  c.save = async () => {};
  await c.publishReviewResult(job);
  assert.equal(job.phase, 'repair');
  assert.equal(job.nextRole, 'builder');
  assert.equal(job.reviewPublicationStatus, 'superseded');
  assert.equal(job.reviewResultStatus, 'superseded');
  assert.equal(job.reviewResult, null);
  assert.equal(job.requestRevision, createRequestRevision(world.issues[0]));
  assert.equal(world.receiptLookups.length, 1);
  assert.equal(world.publishedReviews.length, 0);
});

async function fixture(t, { agents = 1, hold = false, maxTurns, reviewEnabled = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'symphony-runtime-'));
  const root = join(dir, 'source'), remote = join(dir, 'remote.git');
  await mkdir(root); await git(dir, 'init', '--bare', '--initial-branch=main', remote);
  await git(root, 'init', '--initial-branch=main');
  await git(root, 'config', 'user.name', 'Fixture'); await git(root, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(root, 'check.mjs'), "import {existsSync} from 'node:fs'; if(existsSync('fail-check')) process.exit(1);\n");
  await git(root, 'add', 'check.mjs'); await git(root, 'commit', '-m', 'Fixture');
  await git(root, 'remote', 'add', 'origin', remote); await git(root, 'push', '-u', 'origin', 'main');
  const repo = await inspectRepository(root);
  const world = { root, remote, issues: [issue(1), issue(2), issue(3)], pulls: new Map(), threads: new Map(), starts: 0, resumes: [], turns: 0, closed: [], merges: [], hold, blockers: new Set(), clients: [], coordinators: [], reviewResults: [], publishedReviews: [], prompts: [], advanceBaseDuringReview: false, changeRequestDuringReview: false, receiptLookups: [], closeUncertain: false };
  class Client extends EventEmitter {
    constructor({ cwd }) { super(); this.cwd = cwd; this.pid = undefined; world.clients.push(this); }
    async connect() {}
    async readConfig() { return { config: { additional: { mcp_servers: { github: {} }, apps: { github: {} }, plugins: { 'example@local': {} } } } }; }
    async startThread(options = {}) { this.sandbox = options.sandbox; this.threadId = `thread-${++world.starts}`; world.threads.set(this.threadId, { turns: [], name: null, sandbox: options.sandbox, approvalPolicy: options.approvalPolicy, config: options.config }); return { id: this.threadId }; }
    async setThreadName({ threadId, name }) { world.threads.get(threadId).name = name; }
    async readThread({ threadId }) { return world.threads.get(threadId); }
    async resumeThread({ threadId, sandbox, approvalPolicy, config: roleConfig }) { this.threadId = threadId; world.resumes.push(threadId); if (sandbox) Object.assign(world.threads.get(threadId), { sandbox, approvalPolicy, config: roleConfig }); return { id: threadId }; }
    async startTurn({ prompt, outputSchema }) {
      const id = `turn-${++world.turns}`;
      world.prompts.push({ threadId: this.threadId, prompt, outputSchema });
      world.threads.get(this.threadId).turns = [{ id, status: 'inProgress' }];
      if (world.hold === 'launch') return new Promise((resolve, reject) => { this.launchResolve = resolve; this.launchReject = reject; });
      const reviewer = outputSchema?.properties?.status;
      if (!world.hold || world.hold === 'reviewer' && !reviewer) this.completion = reviewer ? this.finishReview(id) : this.finish(id);
      return { id };
    }
    async finishReview(id) {
      await delay(1); if (this.closed) return;
      const result = world.reviewResults.shift() ?? { status: 'clear', summary: 'No actionable findings.', findings: [] };
      if (world.changeRequestDuringReview) {
        world.changeRequestDuringReview = false;
        world.issues[0].body = 'Revised while reviewer was active.';
      }
      if (world.advanceBaseDuringReview) {
        world.advanceBaseDuringReview = false;
        await writeFile(join(world.root, 'base-advance.txt'), 'New accepted base commit.\n');
        await git(world.root, 'add', 'base-advance.txt'); await git(world.root, 'commit', '-m', 'Advance base during review');
        await git(world.root, 'push', 'origin', 'main');
      }
      world.threads.get(this.threadId).turns = [{ id, status: 'completed' }];
      this.emit('notification', { method: 'item/completed', params: { threadId: this.threadId, item: { type: 'agentMessage', text: JSON.stringify(result) } } });
      this.emit('notification', { method: 'turn/completed', params: { threadId: this.threadId, turn: { id, status: 'completed' } } });
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
    findReviewReceipt: async (n, receipt) => { world.receiptLookups.push({ n, ...receipt }); return null; },
    submitReview: async (n, review) => { world.publishedReviews.push({ n, ...review }); return { reviewId: `review-${world.publishedReviews.length}`, commentIds: [] }; },
    merge: async n => { const p = world.pulls.get(n); world.merges.push(n); p.autoMergeRequest = {}; },
    disableAutoMerge: async n => { world.pulls.get(n).autoMergeRequest = null; },
    closeIssue: async n => { if (world.issues.find(i => i.number === n).state === 'closed') return; world.closed.push(n); world.issues.find(i => i.number === n).state = 'closed'; if (world.closeUncertain) { world.closeUncertain = false; throw new Error('Injected lost close response.'); } },
  };
  function coordinator() {
    const c = new Coordinator({ repo, config: { ...config(), agents, maxTurns, reviewEnabled }, store: new Store(repo.commonDir), github, Client });
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
  assert.equal(world.merges.length, 2, JSON.stringify({ jobs: c.state.jobs.map(j => ({ issue: j.issue, phase: j.phase, summary: j.summary, checkBase: j.checkBase, checkHead: j.checkHead, mergeArmed: j.mergeArmed })), pulls: [...world.pulls.values()].map(p => ({ number: p.number, state: p.state, headRefOid: p.headRefOid, statusCheckRollup: p.statusCheckRollup })), notice: world.notice }));
  const second = c.state.jobs.find(j => j.issue === 3);
  assert.equal(second.checkBase, first.headRefOid);
  assert.equal(world.turns, count);
});

test('review finding returns to builder, then the same isolated reviewer clears the repaired head', async t => {
  const { world, coordinator } = await fixture(t, { reviewEnabled: true });
  world.issues = world.issues.slice(0, 1);
  world.reviewResults = [
    { status: 'findings', summary: 'One acceptance defect.', findings: [{ title: 'Missing case', body: 'Cover the failure path.', priority: 'P2', location: { path: 'thread-1.txt', startLine: 1, endLine: 1 } }] },
    { status: 'clear', summary: 'The repair resolves the finding.', findings: [] },
  ];
  const c = coordinator(); await c.start();
  await until(() => c.state.jobs[0]?.phase === 'waiting' && c.state.jobs[0]?.reviewStatus === 'clear', 'review clearance after repair');
  const job = c.state.jobs[0];
  assert.equal(world.turns, 4);
  assert.equal(job.builderThreadId, job.threadId);
  assert.equal(job.activeRole, null);
  assert.notEqual(job.builderThreadId, job.reviewerThreadId);
  assert.deepEqual(world.resumes, [job.builderThreadId, job.reviewerThreadId]);
  assert.equal(world.threads.get(job.reviewerThreadId).name, 'example/project #1 - reviewer');
  assert.equal(world.threads.get(job.reviewerThreadId).sandbox, 'read-only');
  assert.equal(world.threads.get(job.reviewerThreadId).approvalPolicy, 'never');
  assert.deepEqual(world.threads.get(job.reviewerThreadId).config, {
    'apps._default.enabled': false,
    'plugins._default.enabled': false,
    'mcp_servers.github': { enabled: false },
    'apps.github.enabled': false,
    'plugins.example@local.enabled': false,
  });
  assert.equal(world.publishedReviews.length, 2);
  assert.equal(world.publishedReviews[0].result.status, 'findings');
  assert.equal(world.publishedReviews[1].result.status, 'clear');
  assert.equal(job.reviewClearance.head, job.checkHead);
  assert.equal(job.reviewClearance.base, job.checkBase);
  assert.equal(job.reviewClearance.requestRevision, job.requestRevision);
});

test('base advancement during review refreshes checks and automatically resumes the same reviewer', async t => {
  const { world, coordinator } = await fixture(t, { reviewEnabled: true });
  world.issues = world.issues.slice(0, 1);
  world.advanceBaseDuringReview = true;
  world.reviewResults = [
    { status: 'clear', summary: 'First review used a base that advanced before completion.', findings: [] },
    { status: 'clear', summary: 'Integrated head is clear.', findings: [] },
  ];
  const c = coordinator(); await c.start();
  await until(() => c.state.jobs[0]?.phase === 'waiting' && c.state.jobs[0]?.reviewStatus === 'clear', 're-review after base refresh');
  const job = c.state.jobs[0];
  assert.equal(world.turns, 3);
  assert.equal(job.reviewAttempt, 1);
  assert.equal(job.reviewClearance.base, await git(world.root, 'rev-parse', 'origin/main'));
  assert.equal(job.checkBase, job.reviewClearance.base);
  assert.equal(job.checkHead, job.reviewClearance.head);
  assert.equal(job.reviewClearance.requestRevision, job.requestRevision);
  assert.equal(await readFile(join(job.worktree, 'base-advance.txt'), 'utf8'), 'New accepted base commit.\n');
  assert.deepEqual(world.resumes, [job.reviewerThreadId]);
  assert.equal(world.publishedReviews.length, 1);
  assert.equal(world.publishedReviews[0].result.summary, 'Integrated head is clear.');
});

test('issue request changed during review sends the revised request to builder before publishing a result', async t => {
  const { world, coordinator } = await fixture(t, { reviewEnabled: true });
  world.issues = world.issues.slice(0, 1);
  world.changeRequestDuringReview = true;
  world.reviewResults = [
    { status: 'clear', summary: 'Result for old request.', findings: [] },
    { status: 'clear', summary: 'Result for revised request.', findings: [] },
  ];
  const c = coordinator(); await c.start();
  await until(() => c.state.jobs[0]?.phase === 'waiting' && c.state.jobs[0]?.reviewStatus === 'clear', 'review of revised request');
  const job = c.state.jobs[0];
  assert.equal(world.turns, 4);
  assert.equal(job.requestRevision, createRequestRevision(world.issues[0]));
  assert.ok(world.prompts.some(item => item.threadId === job.builderThreadId && item.prompt.includes('Reassess its revised acceptance')));
  assert.equal(world.publishedReviews.length, 1);
  assert.equal(world.publishedReviews[0].result.summary, 'Result for revised request.');
});

test('blocked reviewer result never clears review or reaches PR publication', async t => {
  const { world, coordinator } = await fixture(t, { reviewEnabled: true });
  world.issues = world.issues.slice(0, 1);
  world.reviewResults = [{ status: 'blocked', summary: 'The required source location is unavailable.', findings: [] }];
  const c = coordinator(); await c.start(); await until(() => c.state.jobs[0]?.phase === 'blocked', 'blocked review result');
  const job = c.state.jobs[0];
  assert.equal(job.nextRole, 'reviewer');
  assert.notEqual(job.reviewStatus, 'clear');
  assert.deepEqual(world.publishedReviews, []);
});

test('changed review instructions invalidate clearance and reuse the reviewer thread', async t => {
  const { world, coordinator } = await fixture(t, { reviewEnabled: true });
  world.issues = world.issues.slice(0, 1);
  world.reviewResults = [
    { status: 'clear', summary: 'Initial instructions cleared.', findings: [] },
    { status: 'clear', summary: 'Updated instructions cleared.', findings: [] },
  ];
  const c = coordinator(); await c.start();
  await until(() => c.state.jobs[0]?.phase === 'waiting' && c.state.jobs[0]?.reviewStatus === 'clear', 'initial review');
  const job = c.state.jobs[0], originalReviewer = job.reviewerThreadId, priorInstructions = job.reviewClearance.instructionRevision;
  world.pulls.get(job.pr).statusCheckRollup = [];
  c.config.reviewInstructions = 'Check recovery from interrupted state.';
  await c.wake();
  await until(() => job.phase === 'waiting' && job.reviewStatus === 'clear' && job.reviewClearance.instructionRevision !== priorInstructions, 'review under changed instructions');
  assert.equal(world.turns, 3);
  assert.equal(job.reviewerThreadId, originalReviewer);
  assert.deepEqual(world.resumes, [originalReviewer]);
  assert.equal(job.reviewClearance.requestRevision, job.requestRevision);
});

test('reviewer interruption preserves and resumes its named thread; role turns share maxTurns', async t => {
  const { world, coordinator } = await fixture(t, { reviewEnabled: true, hold: 'reviewer' });
  world.issues = world.issues.slice(0, 1);
  const c = coordinator(); await c.start();
  await until(() => c.state.jobs[0]?.phase === 'reviewing', 'reviewer turn to interrupt');
  const job = c.state.jobs[0], reviewerThread = job.reviewerThreadId, builderThread = job.builderThreadId;
  await c.stop();
  assert.equal(job.phase, 'stopped');
  assert.equal(job.nextRole, 'reviewer');
  world.hold = false;
  const resumed = coordinator(); await resumed.start(); await until(() => resumed.state.jobs[0]?.phase === 'waiting', 'resumed reviewer clearance');
  assert.equal(resumed.state.jobs[0].builderThreadId, builderThread);
  assert.equal(resumed.state.jobs[0].reviewerThreadId, reviewerThread);
  assert.ok(world.resumes.includes(reviewerThread));

  const bounded = await fixture(t, { reviewEnabled: true, maxTurns: 1 });
  bounded.world.issues = bounded.world.issues.slice(0, 1);
  const limited = bounded.coordinator(); await limited.start();
  await until(() => ['blocked','uncertain'].includes(limited.state.jobs[0]?.phase), 'shared turn budget blocks reviewer', 5000).catch(error => {
    const job = limited.state.jobs[0]; throw new Error(`${error.message}: ${JSON.stringify({ phase: job?.phase, nextRole: job?.nextRole, turns: bounded.world.turns, jobTurns: job?.turnCount, error: job?.lastError, notice: bounded.world.notice })}`);
  });
  assert.equal(bounded.world.turns, 1);
  assert.equal(limited.state.jobs[0].turnCount, 1);
  assert.equal(limited.state.jobs[0].activeRole, 'reviewer');
});

test('merged PR does not close a newer issue revision; uncertain close reconciles idempotently', async t => {
  const stale = await fixture(t);
  stale.world.issues = stale.world.issues.slice(0, 1);
  const staleCoordinator = stale.coordinator(); await staleCoordinator.start();
  await until(() => staleCoordinator.state.jobs[0]?.phase === 'waiting');
  const staleJob = staleCoordinator.state.jobs[0], stalePull = stale.world.pulls.get(staleJob.pr);
  stalePull.state = 'MERGED'; stalePull.mergeCommit = { oid: stalePull.headRefOid };
  await git(stale.remote, 'update-ref', 'refs/heads/main', stalePull.headRefOid);
  stale.world.issues[0].body = 'New request after old revision merged.';
  await staleCoordinator.wake();
  assert.equal(staleJob.phase, 'blocked');
  assert.deepEqual(stale.world.closed, []);
  assert.equal(stale.world.issues[0].state, 'open');
  assert.equal(staleJob.landedRequestRevision, staleJob.requestRevision);
  assert.equal(staleJob.currentRequestRevision, createRequestRevision(stale.world.issues[0]));
  await staleCoordinator.stop();

  const uncertain = await fixture(t);
  uncertain.world.issues = uncertain.world.issues.slice(0, 1);
  uncertain.world.closeUncertain = true;
  const c = uncertain.coordinator(); await c.start();
  await until(() => c.state.jobs[0]?.phase === 'waiting');
  const job = c.state.jobs[0], pull = uncertain.world.pulls.get(job.pr);
  pull.state = 'MERGED'; pull.mergeCommit = { oid: pull.headRefOid };
  await git(uncertain.remote, 'update-ref', 'refs/heads/main', pull.headRefOid);
  await c.wake();
  assert.equal(uncertain.world.issues[0].state, 'closed');
  await c.wake();
  assert.equal(job.phase, 'complete');
  assert.deepEqual(uncertain.world.closed, [1]);
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
