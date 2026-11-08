import test from 'node:test';
import assert from 'node:assert/strict';
import { Director } from '../plugins/conductor/lib/director.mjs';
import { GitHub } from '../plugins/conductor/lib/github.mjs';

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
  let nextCommentId = 1;
  const github = {
    repository: REPO,
    ensureWorkflowLabels: async () => {},
    applyIssueHold: async (...args) => GitHub.prototype.applyIssueHold.call(github, ...args),
    releaseIssueHold: async (...args) => GitHub.prototype.releaseIssueHold.call(github, ...args),
    gh: async args => {
      const issue = records.get(Number(args[2]));
      if (args.includes('--add-label')) issue.labels.push(args[args.indexOf('--add-label') + 1]);
      if (args.includes('--remove-label')) issue.labels = issue.labels.filter(label => label !== args[args.indexOf('--remove-label') + 1]);
      return '';
    },
    openIssues: async () => [...records.values()].filter(issue => issue.state === 'open').map(issue => structuredClone(issue)),
    issue: async number => { const issue = records.get(number); if (!issue) throw new Error(`missing #${number}`); return structuredClone(issue); },
    dependencies: async () => [],
    parents: async number => (parentMap.get(number) ?? []).map(n => structuredClone(records.get(n))),
    children: async number => (childrenMap.get(number) ?? []).map(n => structuredClone(records.get(n))),
    comments: async number => structuredClone(comments.get(number) ?? []),
    setNeedsInput: async (number, needed, labels) => {
      const issue = records.get(number);
      issue.labels = issue.labels.filter(label => label !== labels.needsInput);
      if (needed) issue.labels.push(labels.needsInput);
      return structuredClone(issue);
    },
    setWorkflowState: async (number, state, labels) => {
      const issue = records.get(number);
      const primary = ['triage','proposal','ready','hold'].map(key => labels[key]);
      issue.labels = issue.labels.filter(label => !primary.includes(label));
      issue.labels.push(labels[state]);
      return structuredClone(issue);
    },
    api: async (path, { method, fields }) => {
      const match = path.match(/issues\/(\d+)\/comments$/);
      if (match && method === 'POST') comments.get(Number(match[1])).push({ id: nextCommentId++, body: fields.body });
      const patch = path.match(/issues\/comments\/(\d+)$/);
      if (patch && method === 'PATCH') [...comments.values()].flat().find(comment => comment.id === Number(patch[1])).body = fields.body;
      return null;
    },
  };
  const state = { jobs, director: { threadId: THREAD } };
  const coordinator = {
    config: { version: 2, repository: REPO, labels: LABELS, agents: 2 },
    repo: { root: 'C:/repo' }, state, github, execute,
    clients: new Map(), tasks: new Map(), requests: new Map(),
    save: async () => {}, base: async () => 'base-sha',
    dispatchIssue: async (issue, base, eligibilityRevision, designHandoff) => { const job = { issue: issue.number, base, eligibilityRevision, designHandoff, phase: 'starting' }; state.jobs.push(job); return job; },
    resumeIssue: async request => calls.push(['resume', request.issue, request.workerThreadId, request.role, request.designHandoff]),
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
  const write = h.github.applyIssueHold;
  h.github.applyIssueHold = async (number, ...args) => {
    if (number === 1) throw new Error('transport failure before label write');
    return write(number, ...args);
  };
  await assert.rejects(h.director.hold({ issues: [1,2] }), /transport failure/);
  assert.equal(h.state.holds[0].active, true);
  await h.director.release({ holdId: h.state.holds[0].id });
  assert.deepEqual(h.records.get(1).labels, ['ready']);
  assert.deepEqual(h.records.get(2).labels, ['proposal']);
});

test('establishes a hold after any cleanup sweep that already took its hold snapshot', async () => {
  const h = setup({ issues: [issue(1)] });
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  h.coordinator.worktreeCleanup = first.promise.finally(() => { h.coordinator.worktreeCleanup = null; });
  // A second sweep can take its snapshot before the waiting hold resumes.
  const next = h.coordinator.worktreeCleanup.then(() => {
    h.coordinator.worktreeCleanup = second.promise.finally(() => { h.coordinator.worktreeCleanup = null; });
  });
  const holding = h.director.hold({ issue: 1 });
  assert.equal(h.state.holds.length, 0);
  first.resolve();
  await next;
  assert.equal(h.state.holds.length, 0);
  second.resolve();

  const held = await holding;
  assert.equal(h.state.holds[0].id, held.id);
  assert.equal(held.active, true);
});

test('a merge racing a hold is reconciled while retaining the hold without starting another builder', async () => {
  const job = { issue: 1, pr: 11, phase: 'paused', intent: 'pause', deliveryReconciliationRequired: true };
  const h = setup({ issues: [issue(1)], jobs: [job] });
  h.github.pull = async () => ({ state: 'MERGED' });
  h.coordinator.reconcilePull = async owned => { assert.equal(owned, job); owned.phase = 'complete'; owned.mergedCommit = 'verified-commit'; };
  h.coordinator.disarm = async () => { throw Object.assign(new Error('PR already landed'), { code: 'ALREADY_MERGED' }); };
  const evidence = { pr: 11, mergeCommit: 'verified-commit', acceptedBase: 'accepted-base', requestRevision: 'request', currentRequestRevision: 'request', acceptanceComplete: true, requestMatches: true, deliveredHead: 'verified-head' };
  h.coordinator.mergedDeliveryEvidence = async owned => { assert.equal(owned, job); return evidence; };
  const held = await h.director.hold({ issue: 1 });
  assert.equal(held.applied, false);
  assert.equal(held.deliveryBarrierEstablished, false);
  let current = await h.director.snapshot(1);
  await assert.rejects(h.director.control({ op:'reconcile', issue:1, repository:REPO, threadId:THREAD, expectedRevision:current.revision }), /hold/);
  await assert.rejects(h.director.release({ holdId: held.id }), /retain the hold/);
  const reconciled = await h.director.control({ op:'reconcile-delivery', issue:1, repository:REPO, threadId:THREAD, expectedRevision:current.revision });
  assert.deepEqual(reconciled.evidence, { ...evidence, eligibilityRevision: current.revision });
  assert.equal(job.phase, 'paused');
  assert.equal(job.intent, 'pause');
  assert.equal(held.active, true);
  assert.equal(held.applied, true);
  assert.deepEqual(h.records.get(1).labels, ['on-hold']);
  await h.director.release({ holdId:held.id });
  current = await h.director.snapshot(1);
  const result = await h.director.control({ op:'reconcile', issue:1, repository:REPO, threadId:THREAD, expectedRevision:current.revision });
  assert.equal(result.phase, 'complete');
  assert.equal(job.deliveryReconciliationRequired, false);
  assert.equal(h.state.jobs.length, 1);
});

test('failed auto-merge disarm stops the worker but cannot establish a hold until pause verifies disarm', async () => {
  const job = { issue: 1, pr: 11, phase: 'building', mergeArmed: true };
  const h = setup({ issues: [issue(1)], jobs: [job] });
  h.coordinator.clients.set(1, {});
  h.coordinator.disarm = async () => { throw new Error('disable-auto failed'); };
  const held = await h.director.hold({ issue: 1 });
  assert.equal(job.phase, 'paused');
  assert.equal(h.calls.some(call => call[0] === 'halt'), true);
  assert.equal(job.mergeArmed, true);
  assert.equal(job.deliveryReconciliationRequired, true);
  assert.equal(held.active, true);
  assert.equal(held.applied, false);
  assert.deepEqual(held.deliveryReconciliationRequired, [1]);
  await assert.rejects(h.director.release({ holdId: held.id }), /retain the hold/);
  h.coordinator.disarm = async owned => { owned.mergeArmed = false; };
  const paused = await h.director.pause(1);
  assert.equal(paused.deliveryBarrierEstablished, true);
  assert.equal(job.deliveryReconciliationRequired, false);
  assert.equal(held.applied, true);
  await h.director.release({ holdId: held.id });
  assert.deepEqual(h.records.get(1).labels, ['ready']);
});

test('failed or stale merged-delivery evidence keeps the original job and hold unresolved', async () => {
  for (const stale of [false, true]) {
    const job = { issue: 1, pr: 11, phase: 'waiting', mergeArmed: true };
    const h = setup({ issues: [issue(1)], jobs: [job] });
    h.coordinator.disarm = async () => { throw new Error('delivery uncertain'); };
    const held = await h.director.hold({ issue: 1 });
    const current = await h.director.snapshot(1);
    h.coordinator.mergedDeliveryEvidence = async () => {
      if (!stale) throw new Error('merge commit is not on accepted base');
      h.records.get(1).body += '\nChanged request';
      return { mergeCommit: 'landed' };
    };
    await assert.rejects(h.director.control({ op: 'reconcile-delivery', issue: 1, repository: REPO, threadId: THREAD, expectedRevision: current.revision }), /accepted base|revision changed/);
    assert.equal(job.phase, 'paused');
    assert.equal(job.deliveryReconciliationRequired, true);
    assert.equal(held.active, true);
    assert.equal(held.applied, false);
    assert.deepEqual(h.records.get(1).labels, ['on-hold']);
  }
});

test('read-only delivery reconciliation works through a paused runner without releasing its gates', async () => {
  const job = { issue: 1, pr: 11, phase: 'paused', intent: 'pause', deliveryReconciliationRequired: true };
  const h = setup({ issues: [issue(1, ['on-hold'])], jobs: [job] });
  h.state.runnerPause = { reason: 'Stopped by user' };
  h.state.admissionPaused = true;
  h.coordinator.assertRunning = () => { throw Object.assign(new Error('runner paused'), { code: 'RUNNER_PAUSED' }); };
  h.coordinator.mergedDeliveryEvidence = async () => ({ pr: 11, mergeCommit: 'verified', acceptedBase: 'base', acceptanceComplete: false, requestMatches: false });
  const current = await h.director.snapshot(1);
  const result = await h.director.control({ op: 'reconcile-delivery', issue: 1, expectedRevision: current.revision, repository: REPO, threadId: THREAD });
  assert.equal(result.deliveryBarrierEstablished, true);
  assert.equal(result.evidence.acceptanceComplete, false);
  assert.equal(job.phase, 'paused');
  assert.equal(job.intent, 'pause');
  assert.equal(h.state.runnerPause.reason, 'Stopped by user');
  assert.equal(h.state.admissionPaused, true);
  assert.deepEqual(h.records.get(1).labels, ['on-hold']);
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

for (const order of [[0, 1], [1, 0]]) test(`remote hold receipts preserve overlap after local recovery, release order ${order.join(',')}`, async () => {
  const h = setup({ issues: [issue(1, ['proposal'])] });
  const holds = [await h.director.hold({ issue: 1 }), await h.director.hold({ issue: 1 })];
  h.state.holds = [];
  await h.director.release({ holdId: holds[order[0]].id, issue: 1 });
  assert.deepEqual(h.records.get(1).labels, ['on-hold']);
  h.state.holds = [];
  await h.director.release({ holdId: holds[order[1]].id, issue: 1 });
  assert.deepEqual(h.records.get(1).labels, ['proposal']);
  assert.equal(h.comments.get(1).every(comment => JSON.parse(comment.body.split('\n').at(-1)).releasedAt), true);
});

test('overlap recovery restores this hold cycle and reconciles a lost release response before retry', async () => {
  const h = setup({ issues: [issue(1)] });
  const old = await h.director.hold({ issue: 1 });
  await h.director.release({ holdId: old.id });
  h.records.get(1).labels = ['proposal'];
  const first = await h.director.hold({ issue: 1 });
  const second = await h.director.hold({ issue: 1 });
  h.state.holds = [first];
  const api = h.github.api;
  let writes = 0;
  h.github.api = async (...args) => { writes++; await api(...args); throw new Error('lost PATCH response'); };
  await h.director.release({ holdId: first.id });
  assert.equal(writes, 2);
  assert.deepEqual(h.records.get(1).labels, ['on-hold']);
  h.state.holds = [];
  await h.director.release({ holdId: second.id, issue: 1 });
  assert.equal(writes, 4);
  assert.deepEqual(h.records.get(1).labels, ['proposal']);
});

test('dispatch rejects stale revision and accepts a fresh ready revision', async () => {
  const h = setup({ issues: [issue(7)] });
  const snapshot = await h.director.snapshot(7);
  h.records.get(7).body += '\nnew acceptance';
  await assert.rejects(h.director.control({ op: 'dispatch', issue: 7, repository: REPO, threadId: THREAD, expectedRevision: snapshot.revision }), /revision changed/);
  const fresh = await h.director.snapshot(7);
  const payload = { review: { verdict: 'clear' }, increment: { id: 'first' } };
  const result = await h.director.control({ op: 'dispatch', issue: 7, repository: REPO, threadId: THREAD, expectedRevision: fresh.revision, designHandoff: payload });
  assert.equal(result.eligibilityRevision, fresh.revision);
  assert.deepEqual(result.designHandoff, payload);
  h.state.jobs[0].phase = 'blocked';
  await h.director.control({ op: 'resume', issue: 7, repository: REPO, threadId: THREAD, expectedRevision: fresh.revision, designHandoff: payload });
  assert.deepEqual(h.calls.at(-1), ['resume', 7, undefined, undefined, payload]);
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

test('interaction gates new work, survives restart and settles without waking itself', async () => {
  let wakes = 0;
  const h = setup({ issues: [issue(1), issue(2)], jobs: [{ issue: 2, phase: 'building' }], execute: async () => { wakes++; return { code: 0 }; } });
  const control = request => h.director.control({ repository: REPO, threadId: THREAD, ...request });
  const phase = await control({ op: 'interaction-begin', batchKey: 'contracts-v1' });
  const status = await control({ op: 'status' });
  assert.equal(status.interaction.id, phase.id);
  assert.equal(wakes, 0);
  await assert.rejects(control({ op: 'dispatch', issue: 1, expectedRevision: status.issues[0].revision }), /Interactive resolution/);
  await assert.rejects(control({ op: 'resume', issue: 2, expectedRevision: status.issues[1].revision }), /Interactive resolution/);
  assert.equal(await h.director.checkJob(h.state.jobs[0]), true);
  h.director = new Director(h.coordinator, THREAD);
  assert.equal((await control({ op: 'settle', checkRevision: status.checkRevision })).idle, false);
  await assert.rejects(control({ op: 'interaction-complete', interactionId: phase.id, checkRevision: -1 }), /current events/);
  await control({ op: 'interaction-complete', interactionId: phase.id, checkRevision: h.state.director.checkRevision });
  assert.equal(h.state.admissionPaused, false);
  await control({ op: 'dispatch', issue: 1, expectedRevision: status.issues[0].revision });
});

test('manual wake bypasses a batch without changing admission and does not immediately reopen it', async () => {
  const h = setup();
  h.state.admissionPaused = true;
  h.coordinator.requestCheck = async () => ({ status: 'checked' });
  const control = request => h.director.control({ repository: REPO, threadId: THREAD, ...request });
  await control({ op: 'interaction-begin', batchKey: 'decisions-v1' });
  await control({ op: 'wakeup' });
  assert.equal(h.state.director.interaction.active, false);
  assert.equal(h.state.admissionPaused, true);
  await assert.rejects(control({ op: 'interaction-begin', batchKey: 'decisions-v1' }), /bypassed/);
  await control({ op: 'interaction-begin', batchKey: 'decisions-v2' });
});

test('a batch cannot finish before its recorded answers are integrated or explicitly deferred', async () => {
  const h = setup({ issues: [issue(1, ['proposal', 'needs-input'])] });
  const control = request => h.director.control({ repository: REPO, threadId: THREAD, ...request });
  const phase = await control({ op: 'interaction-begin', batchKey: 'decision-1' });
  let snapshot = await control({ op: 'decision-read', issue: 1 });
  const record = { context: 'Choose behavior', question: 'Should saving retain the current session?', status: 'pending' };
  snapshot = await control({ op: 'decision-record', issue: 1, decisionId: 'saving', expectedRevision: snapshot.revision, record });
  await assert.rejects(control({ op: 'interaction-complete', interactionId: phase.id, checkRevision: 0 }), /pending decisions/);
  snapshot = await control({ op: 'decision-record', issue: 1, decisionId: 'saving', expectedRevision: snapshot.revision, record: { ...record, status: 'answered', answer: 'Yes' } });
  await assert.rejects(control({ op: 'interaction-complete', interactionId: phase.id, checkRevision: 0 }), /awaiting integration/);
  const current = await h.director.snapshot(1);
  await control({ op: 'decision-integrate', issue: 1, decisionId: 'saving', expectedRevision: snapshot.revision, expectedIssueRevision: current.revision, state: 'ready', needsInput: false, record: { ...record, status: 'integrated', answer: 'Yes', integration: 'Issue acceptance updated and verified.' } });
  assert.equal(h.records.get(1).labels.includes('proposal'), false);
  assert.equal(h.records.get(1).labels.includes('needs-input'), false);
  await control({ op: 'interaction-complete', interactionId: phase.id, checkRevision: h.state.director.checkRevision });
});

test('reading a recovered unanswered decision enrolls its issue and prevents premature completion', async () => {
  const h = setup({ issues: [issue(1)] });
  const control = request => h.director.control({ repository: REPO, threadId: THREAD, ...request });
  const saved = await control({ op: 'decision-read', issue: 1 });
  await control({ op: 'decision-record', issue: 1, decisionId: 'unfinished', expectedRevision: saved.revision, record: { context: 'Existing decision', question: 'Which outcome?', status: 'pending' } });
  const phase = await control({ op: 'interaction-begin', batchKey: 'recovered' });
  await control({ op: 'decision-read', issue: 1 });
  await assert.rejects(control({ op: 'interaction-complete', interactionId: phase.id, checkRevision: 0 }), /pending decisions/);
});

test('integration reconciles partial and rejected proposals and preserves explicit holds', async () => {
  for (const [labels, state, needsInput] of [[['proposal', 'needs-input'], 'proposal', true], [['proposal', 'needs-input'], 'triage', false], [['on-hold', 'needs-input'], 'hold', false]]) {
    const h = setup({ issues: [issue(1, labels)] });
    const control = request => h.director.control({ repository: REPO, threadId: THREAD, ...request });
    let decisions = await control({ op: 'decision-read', issue: 1 });
    const record = { context: 'Candidate behavior', question: 'Keep this direction?', answer: state === 'triage' ? 'No; investigate another direction.' : 'Yes', status: 'answered' };
    decisions = await control({ op: 'decision-record', issue: 1, decisionId: 'direction', expectedRevision: decisions.revision, record });
    const current = await h.director.snapshot(1);
    const request = { op: 'decision-integrate', issue: 1, decisionId: 'direction', expectedRevision: decisions.revision, expectedIssueRevision: current.revision, state, needsInput, record: { ...record, status: 'integrated', integration: 'Verified corresponding issue meaning and remaining decision scope.' } };
    if (state === 'hold') await assert.rejects(control({ ...request, state: 'ready' }), /explicit hold/);
    await control(request);
    assert.equal(h.records.get(1).labels.includes(LABELS[state]), true);
    assert.equal(h.records.get(1).labels.includes('needs-input'), needsInput);
    assert.equal(h.records.get(1).labels.includes('proposal'), state === 'proposal');
  }
});

test('failed label reconciliation leaves the answer recoverable; a fresh retry integrates it', async () => {
  const h = setup({ issues: [issue(1, ['proposal', 'needs-input'])] });
  const control = request => h.director.control({ repository: REPO, threadId: THREAD, ...request });
  let saved = await control({ op: 'decision-read', issue: 1 });
  const record = { context: 'Scope', question: 'Accept this scope?', status: 'answered', answer: 'Yes' };
  saved = await control({ op: 'decision-record', issue: 1, decisionId: 'scope', expectedRevision: saved.revision, record });
  const original = h.github.setNeedsInput;
  h.github.setNeedsInput = async () => { throw new Error('label write failed'); };
  const integrate = async () => control({ op: 'decision-integrate', issue: 1, decisionId: 'scope', expectedRevision: saved.revision, expectedIssueRevision: (await h.director.snapshot(1)).revision, state: 'ready', needsInput: false, record: { ...record, status: 'integrated', integration: 'Meaning updated and verified.' } });
  await assert.rejects(integrate(), /label write failed/);
  assert.equal((await control({ op: 'decision-read', issue: 1 })).decisions[0].record.status, 'answered');
  h.github.setNeedsInput = original;
  await integrate();
  assert.equal((await control({ op: 'decision-read', issue: 1 })).decisions[0].record.status, 'integrated');
});
