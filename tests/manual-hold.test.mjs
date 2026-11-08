import test from 'node:test';
import assert from 'node:assert/strict';
import { runManualHold } from '../plugins/conductor/lib/manual-hold.mjs';
import { DEFAULT_LABELS } from '../plugins/conductor/lib/workflow.mjs';
import { releaseRemoteHold } from '../plugins/conductor/lib/remote-holds.mjs';
import { Director } from '../plugins/conductor/lib/director.mjs';
import { GitHub } from '../plugins/conductor/lib/github.mjs';

const REPO = 'example/project';
const HOLD = '019c6e27-e55b-73d1-87d8-4e01f1f75043';
const SECOND = '019c6e27-e55b-73d1-87d8-4e01f1f75044';
const request = (op, holdId = HOLD) => ({ op, repository: REPO, issue: 1, holdId });

function fixture({ labels = ['ready', 'area/music'], catalog = ['ready'], jobs = [] } = {}) {
  const issue = { number: 1, state: 'open', labels };
  const comments = [];
  const definitions = new Set(catalog);
  const writes = [];
  const state = { version: 1, jobs, director: {}, holds: [] };
  let owner = null, failPost = false, failLabels = false;
  const github = {
    repository: REPO,
    issue: async () => structuredClone(issue),
    comments: async () => structuredClone(comments),
    ensureWorkflowLabels: async (mapping, states) => {
      for (const key of states) if (!definitions.has(mapping[key])) { definitions.add(mapping[key]); writes.push(['label', mapping[key]]); }
    },
    applyIssueHold: async (...args) => GitHub.prototype.applyIssueHold.call(github, ...args),
    releaseIssueHold: async (...args) => GitHub.prototype.releaseIssueHold.call(github, ...args),
    gh: async args => {
      if (failLabels) throw new Error('label write failed');
      if (args.includes('--add-label')) {
        const label = args[args.indexOf('--add-label') + 1];
        assert.equal(definitions.has(label), true);
        if (!issue.labels.includes(label)) issue.labels.push(label);
        writes.push(['add', label]);
      } else {
        const label = args[args.indexOf('--remove-label') + 1];
        issue.labels = issue.labels.filter(name => name !== label);
        writes.push(['remove', label]);
      }
      return '';
    },
    api: async (path, { method, fields }) => {
      writes.push([method, path]);
      if (method === 'POST') {
        comments.push({ id: comments.length + 1, html_url: `https://github.com/${REPO}/issues/1#issuecomment-${comments.length + 1}`, body: fields.body });
        if (failPost) { failPost = false; throw new Error('lost POST response'); }
      } else comments.find(item => path.endsWith(`/comments/${item.id}`)).body = fields.body;
    },
  };
  const store = {
    token: 'manual-operation',
    read: async () => structuredClone(state), owner: async () => owner,
    acquire: async () => { assert.equal(owner, null); owner = { token: store.token }; },
    release: async () => { owner = null; },
  };
  const dependencies = { github, store,
    checkWorkScope: async (cwd, scope) => { assert.equal(cwd, 'C:/repo'); assert.equal(scope, 'issues'); return { root: cwd, repository: REPO, configured: false }; },
    inspectRepository: async root => ({ root, commonDir: 'C:/repo/.git' }),
  };
  return { issue, comments, definitions, writes, state, github, store, dependencies,
    run: value => runManualHold('C:/repo', value, dependencies),
    losePost: () => { failPost = true; }, failLabels: value => { failLabels = value; }, setOwner: value => { owner = value; } };
}

test('manual hold establishes and verifies its remote barrier without setup, runtime or existing workflow labels', async () => {
  const h = fixture({ labels: ['area/music'], catalog: [] });
  h.losePost();
  const held = await h.run(request('create'));
  assert.equal(held.state, 'held');
  assert.equal(held.deliveryBarrierEstablished, true);
  assert.equal(held.receipt.previous, 'triage');
  assert.deepEqual(h.issue.labels, ['area/music', 'on-hold']);
  assert.deepEqual([...h.definitions], ['on-hold']);
  assert.equal(h.writes.filter(([kind]) => kind === 'POST').length, 1);
  h.issue.state = 'closed';
  const before = h.writes.length;
  const inspected = await h.run(request('reconcile'));
  assert.equal(inspected.state, 'held');
  assert.equal(h.issue.state, 'closed');
  assert.equal(h.writes.length, before);
  await h.run(request('release'));
  assert.deepEqual(h.issue.labels, ['area/music', 'triage']);
  assert.deepEqual([...h.definitions], ['on-hold', 'triage']);
  assert.equal(h.issue.state, 'closed');
});

test('read-only reconcile leaves incomplete create alone; explicit create retry preserves receipt identity and prior state', async () => {
  const h = fixture();
  h.failLabels(true);
  await assert.rejects(h.run(request('create')), /label write failed/);
  assert.equal(h.comments.length, 1);
  const before = h.writes.length;
  const inspected = await h.run(request('reconcile'));
  assert.equal(inspected.state, 'incomplete');
  assert.equal(inspected.deliveryBarrierEstablished, false);
  assert.equal(h.writes.length, before);
  h.failLabels(false);
  h.issue.labels.push('on-hold'); // The first label add could have landed.
  await h.run(request('create'));
  assert.equal(h.comments.length, 1);
  await h.run(request('release'));
  assert.deepEqual(h.issue.labels, ['area/music', 'ready']);
});

for (const order of [[HOLD, SECOND], [SECOND, HOLD]]) test(`manual release preserves overlapping receipts in order ${order[0]}`, async () => {
  const h = fixture();
  await h.run(request('create', HOLD));
  await h.run(request('create', SECOND));
  await h.run(request('release', order[0]));
  assert.deepEqual(h.issue.labels, ['area/music', 'on-hold']);
  await h.run(request('release', order[1]));
  assert.deepEqual(h.issue.labels, ['area/music', 'ready']);
  const before = h.writes.length;
  h.issue.labels = ['area/music', 'on-hold']; // A later external hold is not ours.
  await h.run(request('release', order[1]));
  assert.equal(h.writes.length, before);
  assert.deepEqual(h.issue.labels, ['area/music', 'on-hold']);
});

test('manual operations reject mismatched identity and runtime ownership without any GitHub write', async () => {
  for (const runtime of [{ phase: 'paused', issue: 1 }, { phase: 'complete', issue: 1, deliveryReconciliationRequired: true }]) {
    const h = fixture({ jobs: [runtime] });
    await assert.rejects(h.run(request('create')), /owning director/);
    assert.deepEqual(h.writes, []);
  }
  const h = fixture();
  await assert.rejects(h.run({ ...request('create'), repository: 'other/repo' }), /exactly match/);
  h.setOwner({ token: 'runtime', pid: process.pid, hostname: 'foreign-host', platform: 'other-platform' });
  await assert.rejects(h.run(request('create')), /owning director/);
  assert.deepEqual(h.writes, []);
});

test('manual release leaves active runtime snapshots intact and rejects releasing their own record', async () => {
  const h = fixture();
  await h.run(request('create'));
  h.state.holds.push({ id: SECOND, active: true, issues: [1] });
  const snapshot = structuredClone(h.state);
  await h.run(request('release'));
  assert.deepEqual(h.issue.labels, ['area/music', 'on-hold']);
  assert.deepEqual(h.state, snapshot);
  await assert.rejects(h.run(request('release', SECOND)), /runtime snapshot/);
});

test('release retry reconciles a partial label failure and cannot revive a released hold', async () => {
  const h = fixture();
  await h.run(request('create'));
  h.failLabels(true);
  await assert.rejects(h.run(request('release')), /label write failed/);
  const inspected = await h.run(request('reconcile'));
  assert.equal(inspected.state, 'incomplete');
  assert.equal(inspected.active, false);
  assert.equal(inspected.deliveryBarrierEstablished, false);
  h.failLabels(false);
  await h.run(request('release'));
  assert.equal((await h.run(request('reconcile'))).state, 'released');
  await assert.rejects(h.run(request('create')), /do not revive/);
  assert.equal(h.comments.length, 1);
});

test('shared release preserves unknown existing hold ownership', async () => {
  const h = fixture({ labels: ['on-hold'], catalog: ['on-hold'] });
  await h.run(request('create'));
  await assert.rejects(releaseRemoteHold(h.github, { number: 1, holdId: HOLD, labels: DEFAULT_LABELS }), /no recoverable owner/);
  assert.deepEqual(h.issue.labels, ['on-hold']);
});

for (const manualFirst of [true, false]) test(`manual and runtime holds share remote ownership, manual release first: ${manualFirst}`, async () => {
  const h = fixture();
  await h.run(request('create'));
  const coordinator = { state: h.state, github: h.github, config: { repository: REPO, labels: DEFAULT_LABELS }, repo: { root: 'C:/repo' }, save: async () => {}, execute: async () => ({ code: 0 }) };
  const director = new Director(coordinator, SECOND);
  const runtime = await director.hold({ issue: 1, holdId: SECOND });
  const releaseManual = () => director.release({ holdId: HOLD, issue: 1 });
  if (manualFirst) await releaseManual();
  else await director.release({ holdId: runtime.id });
  assert.deepEqual(h.issue.labels, ['area/music', 'on-hold']);
  if (manualFirst) await director.release({ holdId: runtime.id });
  else await releaseManual();
  assert.deepEqual(h.issue.labels, ['area/music', 'ready']);
});

for (const changed of [['proposal'], ['proposal', 'ready']]) test(`releasing a hold preserves newer primary labels: ${changed.join(',')}`, async () => {
  const h = fixture();
  await h.run(request('create'));
  h.issue.labels.push(...changed);
  const released = await h.run(request('release'));
  assert.equal(released.state, 'released');
  assert.deepEqual(h.issue.labels, ['area/music', ...changed]);
  assert.equal(released.workflow.state, changed.length > 1 ? 'conflict' : 'proposal');
});

test('release reads newer decision labels again after receipt update before restoring the old state', async () => {
  const h = fixture();
  await h.run(request('create'));
  const api = h.github.api;
  let changed = false;
  h.github.api = async (...args) => {
    const result = await api(...args);
    if (args[1].method === 'PATCH' && !changed) { changed = true; h.issue.labels = ['area/music', 'on-hold', 'proposal']; }
    return result;
  };
  await h.run(request('release'));
  assert.deepEqual(h.issue.labels, ['area/music', 'proposal']);
});

test('release rechecks primary labels after preparing the restored label and before adding it', async () => {
  const h = fixture();
  await h.run(request('create'));
  const ensure = h.github.ensureWorkflowLabels;
  h.github.ensureWorkflowLabels = async (...args) => { await ensure(...args); h.issue.labels.push('proposal'); };
  await h.run(request('release'));
  assert.deepEqual(h.issue.labels, ['area/music', 'proposal']);
});

test('a hold create retry preserves a newer decision instead of replacing it with the old snapshot', async () => {
  const h = fixture();
  h.failLabels(true);
  await assert.rejects(h.run(request('create')), /label write failed/);
  h.failLabels(false);
  h.issue.labels = ['area/music', 'proposal'];
  await assert.rejects(h.run(request('create')), /changed or conflicting workflow labels/);
  assert.deepEqual(h.issue.labels, ['area/music', 'proposal', 'on-hold']);
  assert.equal((await h.run(request('reconcile'))).deliveryBarrierEstablished, false);
  assert.equal(h.comments.length, 1);
});

test('a human decision arriving during creation is preserved and prevents a successful barrier result', async () => {
  const h = fixture();
  const api = h.github.api;
  h.github.api = async (...args) => {
    const result = await api(...args);
    if (args[1].method === 'POST') h.issue.labels.push('proposal');
    return result;
  };
  await assert.rejects(h.run(request('create')), /changed or conflicting workflow labels/);
  assert.deepEqual(h.issue.labels, ['ready', 'area/music', 'proposal', 'on-hold']);
});
