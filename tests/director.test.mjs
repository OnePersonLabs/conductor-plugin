import test from 'node:test';
import assert from 'node:assert/strict';
import { Director } from '../plugins/conductor/lib/director.mjs';

const THREAD = '019c6e27-e55b-73d1-87d8-4e01f1f75043';
const REPO = 'example/project';
const LABELS = { triage: 'triage', proposal: 'proposal', ready: 'ready', hold: 'on-hold', needsInput: 'needs-input' };
function setup({ issues = [], jobs = [], execute = async () => ({ code: 0, stdout: 'queued' }) } = {}) {
  const records = new Map(issues.map(issue => [issue.number, structuredClone(issue)]));
  const comments = new Map(issues.map(issue => [issue.number, []]));
  const parentMap = new Map();
  const childrenMap = new Map();
  const calls = [];
  const tasks = new Map();
  const github = {
    openIssues: async () => [...records.values()].filter(issue => issue.state === 'open').map(issue => structuredClone(issue)),
    issue: async number => { const issue = records.get(number); if (!issue) throw new Error(`missing #${number}`); return structuredClone(issue); },
    dependencies: async () => [],
    parents: async number => (parentMap.get(number) ?? []).map(n => structuredClone(records.get(n))),
    children: async number => (childrenMap.get(number) ?? []).map(n => structuredClone(records.get(n))),
    comments: async number => structuredClone(comments.get(number) ?? []),
    setWorkflowState: async (number, state, labels) => {
      const issue = records.get(number);
      const primary = ['triage','proposal','ready','hold'].map(key => labels[key]);
      issue.labels = issue.labels.filter(label => !primary.includes(label));
      issue.labels.push(labels[state]);
      return structuredClone(issue);
    },
    api: async (path, { method, fields }) => {
      const match = path.match(/issues\/(\d+)\/comments$/);
      if (match && method === 'POST') comments.get(Number(match[1])).push({ id: comments.get(Number(match[1])).length + 1, body: fields.body });
      return null;
    },
  };
  const state = { jobs, director: { threadId: THREAD } };
  const coordinator = {
    config: { version: 2, repository: REPO, labels: LABELS, agents: 2 },
    repo: { root: 'C:/repo' }, state, github, execute,
    clients: new Map(), tasks: new Map(), requests: new Map(),
    save: async () => {}, base: async () => 'base-sha',
    dispatchIssue: async (issue, base, eligibilityRevision) => { const job = { issue: issue.number, base, eligibilityRevision, phase: 'starting' }; state.jobs.push(job); return job; },
    resume: async (...args) => calls.push(['resume', ...args]),
    answer: async (...args) => calls.push(['answer', ...args]),
    haltClient: async (...args) => calls.push(['halt', ...args]),
    tasks,
    deliveryAction: async action => action(),
    disarm: async () => {},
    wake: () => { calls.push(['wake']); },
  };
  const director = new Director(coordinator, THREAD);
  return { director, coordinator, records, comments, parentMap, childrenMap, calls, state, github };
}
const issue = (number, labels = ['ready'], body = `Work ${number}`) => ({ number, title: `Issue ${number}`, body, state: 'open', labels, state_reason: null });

test('releasing a partially applied group hold leaves untouched issues unchanged', async () => {
  const h = setup({ issues: [issue(1), issue(2, ['proposal'])] });
  const write = h.github.setWorkflowState;
  h.github.setWorkflowState = async (number, state, labels) => {
    if (number === 1 && state === 'hold') throw new Error('transport failure before label write');
    return write(number, state, labels);
  };
  await assert.rejects(h.director.hold({ issues: [1,2] }), /transport failure/);
  assert.equal(h.state.holds[0].active, true);
  await h.director.release({ holdId: h.state.holds[0].id });
  assert.deepEqual(h.records.get(1).labels, ['ready']);
  assert.deepEqual(h.records.get(2).labels, ['proposal']);
});

test('a merge racing a hold is reconciled only after release without starting another builder', async () => {
  const job = { issue: 1, pr: 11, phase: 'paused', intent: 'pause', deliveryReconciliationRequired: true };
  const h = setup({ issues: [issue(1)], jobs: [job] });
  h.github.pull = async () => ({ state: 'MERGED' });
  h.coordinator.reconcilePull = async owned => { assert.equal(owned, job); owned.phase = 'complete'; owned.mergedCommit = 'verified-commit'; };
  const held = await h.director.hold({ issue: 1 });
  let current = await h.director.snapshot(1);
  await assert.rejects(h.director.control({ op:'reconcile', issue:1, repository:REPO, threadId:THREAD, expectedRevision:current.revision }), /hold/);
  await h.director.release({ holdId:held.id });
  current = await h.director.snapshot(1);
  const result = await h.director.control({ op:'reconcile', issue:1, repository:REPO, threadId:THREAD, expectedRevision:current.revision });
  assert.equal(result.phase, 'complete');
  assert.equal(job.deliveryReconciliationRequired, false);
  assert.equal(h.state.jobs.length, 1);
});

test('a failed status comment cannot downgrade verified delivery, including a lost closure response', async () => {
  const job = { issue:1, pr:11, phase:'paused', intent:'pause', deliveryReconciliationRequired:true };
  const h = setup({ issues:[{...issue(1), state:'closed', state_reason:'completed'}], jobs:[job] });
  h.github.pull = async () => ({state:'MERGED'});
  h.coordinator.reconcilePull = async owned => { owned.phase = 'complete'; owned.mergedCommit = 'verified'; throw new Error('status comment failed'); };
  const current = await h.director.snapshot(1);
  const result = await h.director.control({op:'reconcile', issue:1, repository:REPO, threadId:THREAD, expectedRevision:current.revision});
  assert.equal(result.phase, 'complete');
  assert.equal(job.phase, 'complete');
  assert.equal(job.deliveryReconciliationRequired, false);
  assert.match(result.warning, /status comment/);
});

test('overlapping holds keep issues suspended until every covering hold is released', async () => {
  const h = setup({ issues: [issue(1, ['ready']), issue(2, ['proposal'])] });
  h.childrenMap.set(1, [2]);
  const first = await h.director.hold({ issues: [1], descendants: true, reason: 'Revise this set' });
  assert.deepEqual(first.issues, [1, 2]);
  assert.equal((await h.records.get(1)).labels.includes('on-hold'), true);
  assert.equal(h.records.get(2).labels.includes('on-hold'), true);
  const second = await h.director.hold({ issues: [1], reason: 'Independent review' });
  await h.director.release({ holdId: first.id });
  assert.equal(h.records.get(1).labels.includes('on-hold'), true);
  assert.equal(h.records.get(2).labels.includes('on-hold'), false);
  assert.equal(h.records.get(2).labels.includes('proposal'), true);
  await h.director.release({ holdId: second.id });
  assert.equal(h.records.get(1).labels.includes('ready'), true);
  assert.equal(h.records.get(2).labels.includes('proposal'), true);
});

test('dispatch rejects stale revision and accepts a fresh ready revision', async () => {
  const h = setup({ issues: [issue(7)] });
  const snapshot = await h.director.snapshot(7);
  h.records.get(7).body += '\nnew acceptance';
  await assert.rejects(h.director.control({ op: 'dispatch', issue: 7, repository: REPO, threadId: THREAD, expectedRevision: snapshot.revision }), /revision changed/);
  const fresh = await h.director.snapshot(7);
  const result = await h.director.control({ op: 'dispatch', issue: 7, repository: REPO, threadId: THREAD, expectedRevision: fresh.revision });
  assert.equal(result.eligibilityRevision, fresh.revision);
});

test('parent hold pauses a running child and waits for its worker turn to stop', async () => {
  const job = { issue: 12, phase: 'building', activeRole: 'builder', turnId: 'turn-1' };
  const h = setup({ issues: [issue(10), issue(12)], jobs: [job] });
  h.parentMap.set(12, [10]);
  let finish;
  h.coordinator.tasks.set(12, new Promise(resolve => { finish = resolve; }));
  h.coordinator.clients.set(12, {});
  const holding = h.director.hold({ issues: [10], reason: 'Wait for redesign' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(job.intent, 'pause');
  assert.equal(job.phase, 'building');
  assert.equal(h.calls.some(call => call[0] === 'halt'), true);
  let completed = false;
  holding.then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  finish();
  const result = await holding;
  assert.equal(result.applied, true);
  assert.equal(job.phase, 'paused');
});

test('status exposes jobs and pending questions, and answer routes to the owning request', async () => {
  const h = setup({ issues: [issue(4)], jobs: [{ issue: 4, phase: 'building' }] });
  h.coordinator.requests.set('4:q1', { issue: 4, method: 'item/input', params: { prompt: 'Choose' } });
  const status = await h.director.control({ op: 'status', repository: REPO, threadId: THREAD });
  assert.equal(status.jobs[0].issue, 4);
  assert.equal(status.requests[0].key, '4:q1');
  const answer = await h.director.control({ op: 'answer', repository: REPO, threadId: THREAD, key: '4:q1', value: { choice: 'A' } });
  assert.deepEqual(answer, { answered: '4:q1' });
  assert.deepEqual(h.calls.at(-1), ['answer', '4:q1', '{"choice":"A"}']);
});

test('unchanged external observation does not send repeated director wakeups', async () => {
  let queueCount = 0;
  const h = setup({ issues: [issue(2)], execute: async () => { queueCount++; return { code: 0, stdout: 'queued' }; } });
  const first = await h.director.observe();
  const second = await h.director.observe();
  assert.deepEqual(first, second);
  assert.equal(queueCount, 1);
  assert.equal((await h.director.events.pending()).length, 1);
});
