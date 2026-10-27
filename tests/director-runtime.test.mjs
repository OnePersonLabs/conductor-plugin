import test from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../plugins/conductor/lib/coordinator.mjs';
import { Director } from '../plugins/conductor/lib/director.mjs';
import { DEFAULT_LABELS } from '../plugins/conductor/lib/workflow.mjs';
import { EventEmitter } from 'node:events';

const THREAD = '019c6e27-e55b-73d1-87d8-4e01f1f75043';
const REPO = 'example/project';
const makeIssue = (number, state = 'ready') => ({ number, node_id: `node-${number}`, title: `Issue ${number}`, body: `Accepted work ${number}`, state: 'open', state_reason: null, labels: [state] });

function fixture({ issues = [makeIssue(1)], jobs = [], agents = 1 } = {}) {
  const records = new Map(issues.map(issue => [issue.number, structuredClone(issue)]));
  const comments = new Map([...records.keys()].map(number => [number, []]));
  const calls = { launch: [], prepare: [], disarm: [], merge: [], push: [] };
  const github = {
    openIssues: async () => [...records.values()].map(issue => structuredClone(issue)),
    issue: async number => structuredClone(records.get(number)),
    dependencies: async () => [],
    parents: async () => [],
    children: async () => [],
    comments: async number => structuredClone(comments.get(number) ?? []),
    api: async (_path, { method, fields }) => {
      if (method === 'POST') comments.get(Number(_path.match(/issues\/(\d+)\/comments/)[1])).push({ id: 99, body: fields.body });
      return null;
    },
    pull: async number => ({ number, headRefOid: `head-${number}`, state: 'OPEN', isDraft: false, statusCheckRollup: [] }),
    feedback: async () => ({ items: [], hash: 'empty' }),
    setWorkflowState: async (number, state, labels) => {
      const issue = records.get(number);
      const primary = ['triage','proposal','ready','hold'].map(key => labels[key]);
      issue.labels = issue.labels.filter(label => !primary.includes(label));
      issue.labels.push(labels[state]);
      return structuredClone(issue);
    },
    pullForBranch: async () => null,
  };
  const saved = [];
  const initialState = { jobs, director: { threadId: THREAD, enabled: true, snapshots: {}, events: [], batches: [], acknowledged: [] }, holds: [], admissionPaused: false };
  const store = {
    acquire: async () => {},
    read: async () => structuredClone(initialState),
    save: async state => saved.push(structuredClone(state)),
    release: async () => {},
  };
  const coordinator = new Coordinator({
    repo: { root: 'C:/fixture', commonDir: 'C:/fixture/.git' },
    config: { version: 2, repository: REPO, baseBranch: 'main', agents, labels: DEFAULT_LABELS, prepare: [], reviewEnabled: false, checks: [], pollMs: 30 * 60_000 },
    store, github,
    execute: async () => ({ code: 0, stdout: 'queued', stderr: '' }),
    Client: class extends EventEmitter {},
    Host: class extends EventEmitter {
      async connect() {}
      async ensureThread() { return THREAD; }
      async status() { return { type: 'active' }; }
      async close() {}
    },
    workspace: {},
  });
  coordinator.state = { jobs, director: { threadId: THREAD, enabled: true, snapshots: {}, events: [], batches: [], acknowledged: [] }, holds: [], admissionPaused: false };
  coordinator.director = new Director(coordinator, THREAD);
  coordinator.base = async () => 'base-sha';
  coordinator.prepare = async job => { calls.prepare.push(job.issue); job.prepared = true; };
  coordinator.launch = (job, _issue, _reason, _feedback, _role) => { calls.launch.push(job.issue); job.phase = 'building'; };
  coordinator.disarm = async job => { calls.disarm.push(job.issue); job.mergeArmed = false; };
  coordinator.push = async job => calls.push.push(job.issue);
  coordinator.merge = async job => calls.merge.push(job.issue);
  coordinator.wake = () => {};
  return { coordinator, github, records, comments, calls, saved };
}

test('v2 scan observes ready issues but never autoadmits; explicit revision-bound dispatch starts exactly one worker', async () => {
  const h = fixture({ issues: [makeIssue(1), makeIssue(2)] });
  await h.coordinator.scan();
  assert.equal(h.coordinator.state.jobs.length, 0);
  assert.deepEqual(h.calls.launch, []);
  assert.equal(h.coordinator.director.issues.length, 2);
  const current = await h.coordinator.director.snapshot(1);
  const result = await h.coordinator.control({ op: 'dispatch', issue: 1, repository: REPO, threadId: THREAD, expectedRevision: current.revision });
  await h.coordinator.preparations.get(1);
  assert.equal(result.issue, 1);
  assert.deepEqual(h.calls.prepare, [1]);
  assert.deepEqual(h.calls.launch, [1]);
  assert.equal(h.coordinator.state.jobs[0].eligibilityRevision, current.revision);
  await assert.rejects(h.coordinator.control({ op: 'dispatch', issue: 2, repository: REPO, threadId: THREAD, expectedRevision: 'stale' }), /revision changed/);
  assert.deepEqual(h.calls.launch, [1]);
});

test('hold pauses the original job, disarms merge, prevents later work and frees its slot', async () => {
  const job = { issue: 1, phase: 'waiting', activeRole: 'builder', nextRole: null, threadId: 'builder-1', pr: 11, mergeArmed: true, eligibilityRevision: 'prior' };
  const h = fixture({ issues: [makeIssue(1), makeIssue(2)], jobs: [job], agents: 1 });
  const held = await h.coordinator.director.hold({ issues: [1], reason: 'Revise acceptance before continuing.' });
  assert.equal(held.applied, true);
  assert.equal(job.phase, 'paused');
  assert.equal(job.intent, 'pause');
  assert.equal(h.records.get(1).labels.includes('on-hold'), true);
  assert.deepEqual(h.calls.disarm, [1]);

  await h.coordinator.scan();
  assert.deepEqual(h.calls.launch, []);
  assert.deepEqual(h.calls.push, []);
  assert.deepEqual(h.calls.merge, []);
  assert.equal(h.coordinator.state.jobs.length, 1);

  const next = await h.coordinator.director.snapshot(2);
  const admitted = await h.coordinator.control({ op: 'dispatch', issue: 2, repository: REPO, threadId: THREAD, expectedRevision: next.revision });
  await h.coordinator.preparations.get(2);
  assert.equal(admitted.issue, 2);
  assert.deepEqual(h.calls.launch, [2]);
  assert.deepEqual(h.calls.push, []);
  assert.deepEqual(h.calls.merge, []);
});

test('v2 service startup preserves a saved pause and never starts that worker', async () => {
  const job = { issue: 1, phase: 'paused', intent: 'pause', activeRole: 'builder', threadId: 'builder-1', eligibilityRevision: 'old' };
  const h = fixture({ issues: [makeIssue(1)], jobs: [job] });
  h.coordinator.preflight = async () => {};
  await h.coordinator.start({ threadId: THREAD });
  assert.equal(h.coordinator.state.jobs[0].phase, 'paused');
  assert.equal(h.coordinator.state.jobs[0].intent, 'pause');
  assert.deepEqual(h.calls.launch, []);
  await h.coordinator.stop();
});

test('explicit enable creates one director before readiness and keeps migration admission paused', async () => {
  const h = fixture({ issues: [makeIssue(1)] });
  h.coordinator.store.read = async () => ({ version: 1, jobs: [], director: {}, admissionPaused: true });
  h.coordinator.preflight = async () => {};
  let creates = 0, turns = 0;
  h.coordinator.Host = class extends EventEmitter {
    constructor({ state, save }) { super(); this.state = state; this.save = save; this.type = 'idle'; }
    async connect() {}
    async ensureThread() { creates++; this.state.threadId = THREAD; await this.save(); return THREAD; }
    async status() { return { type: this.type }; }
    async startRunner() { turns++; this.type = 'active'; return { id: 'director-turn' }; }
    async close() {}
  };
  await h.coordinator.start({ enable: true, manualWake: true });
  assert.equal(creates, 1);
  assert.equal(turns, 1);
  assert.equal(h.coordinator.state.runtimeEnabled, true);
  assert.equal(h.coordinator.state.serviceReady, true);
  assert.equal(h.coordinator.state.admissionPaused, true);
  assert.deepEqual(h.calls.launch, []);
  await h.coordinator.stop({ explicit: true });
  assert.equal(h.coordinator.state.runtimeEnabled, true);
  assert.equal(h.coordinator.state.director.enabled, false);
});

test('manual wake reconciles a known interrupted director without resuming its worker', async () => {
  const job = { issue: 1, phase: 'paused', intent: 'pause', threadId: 'original-worker' };
  const h = fixture({ issues: [makeIssue(1)], jobs: [job] });
  h.coordinator.state.director.recoveryRequired = { turnId: 'failed-turn', status: 'interrupted' };
  h.coordinator.state.director.batches = [{ id: 'batch', status: 'queued', turnId: 'failed-turn', eventIds: [] }];
  h.coordinator.directorHost = {
    status: async () => ({ type: 'idle' }),
    inspectTurn: async () => ({ id: 'failed-turn', status: 'interrupted' }),
    markTurnReconciled: async () => { h.coordinator.state.director.recoveryRequired.resolvedAt = 'now'; },
  };
  await h.coordinator.requestCheck({ manual: true });
  assert.equal(h.coordinator.state.director.batches[0].status, 'reconciled-ended');
  assert.equal(h.coordinator.state.director.recoveryRequired.resolvedAt, 'now');
  assert.equal(job.phase, 'paused');
  assert.equal(job.threadId, 'original-worker');
  assert.deepEqual(h.calls.launch, []);
});
