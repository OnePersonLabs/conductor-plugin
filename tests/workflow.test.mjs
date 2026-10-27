import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LABELS, workflowState, eligibility } from '../plugins/conductor/lib/workflow.mjs';
import { GitHub } from '../plugins/conductor/lib/github.mjs';

const issue = (number, labels = []) => ({ number, node_id: `node-${number}`, title: `Work ${number}`, body: 'Bounded task', state: 'open', labels });
const adapter = ({ item = issue(1, ['ready']), dependencies = [], parents = [], comments = [] } = {}) => ({
  issue: async () => item,
  dependencies: async () => dependencies,
  parents: async () => parents,
  comments: async () => comments,
});

test('workflow labels default unlabeled work to triage and detect conflicts', () => {
  assert.deepEqual(workflowState(issue(1)), { state: 'triage', needsInput: false, conflict: false });
  assert.deepEqual(workflowState(issue(1, ['Proposal', 'ready', 'needs-input'])), { state: 'conflict', needsInput: true, conflict: true });
  assert.deepEqual(workflowState(issue(1, [{ name: 'on-hold' }])), { state: 'hold', needsInput: false, conflict: false });
  assert.deepEqual(DEFAULT_LABELS, { triage: 'triage', proposal: 'proposal', ready: 'ready', hold: 'on-hold', needsInput: 'needs-input' });
});

test('ready issue is eligible only when open, unblocked, and without human input or held ancestors', async () => {
  const clean = await eligibility(adapter(), 1);
  assert.equal(clean.eligible, true);
  assert.deepEqual(clean.reasons, []);
  assert.match(clean.revision, /^[a-f0-9]{64}$/);

  const blocked = await eligibility(adapter({ dependencies: [{ number: 2, state: 'open' }] }), 1);
  assert.equal(blocked.eligible, false);
  assert.match(blocked.reasons.join(' '), /blocked by open issue #2/);

  const abandoned = await eligibility(adapter({ dependencies: [{ number: 2, state: 'closed', state_reason: 'not_planned' }] }), 1);
  assert.match(abandoned.reasons.join(' '), /closed as not planned/);

  const parent = await eligibility(adapter({ parents: [issue(8, ['on-hold'])] }), 1);
  assert.match(parent.reasons.join(' '), /parent issue #8 is hold/);

  const needsInput = await eligibility(adapter({ item: issue(1, ['ready', 'needs-input']) }), 1);
  assert.match(needsInput.reasons.join(' '), /needs human input/);

  const closed = await eligibility(adapter({ item: { ...issue(1, ['ready']), state: 'closed' } }), 1);
  assert.match(closed.reasons.join(' '), /issue is closed/);
});

test('eligibility revision changes when relevant issue, dependency, parent, or comment data changes', async () => {
  const base = await eligibility(adapter(), 1);
  const body = await eligibility(adapter({ item: { ...issue(1, ['ready']), body: 'Changed acceptance' } }), 1);
  const dep = await eligibility(adapter({ dependencies: [{ number: 2, state: 'closed', state_reason: 'completed' }] }), 1);
  const parent = await eligibility(adapter({ parents: [issue(8, ['ready'])] }), 1);
  const comment = await eligibility(adapter({ comments: [{ id: 3, body: 'Scope clarification', updated_at: '2026-10-27T00:00:00Z' }] }), 1);
  const progressOnly = await eligibility(adapter({ comments: [{ id: 4, body: '<!-- conductor:1 -->\nConductor: building', updated_at: '2026-10-27T00:00:00Z' }] }), 1);
  assert.notEqual(base.revision, body.revision);
  assert.notEqual(base.revision, dep.revision);
  assert.notEqual(base.revision, parent.revision);
  assert.notEqual(base.revision, comment.revision);
  assert.equal(base.revision, progressOnly.revision);
});

test('GitHub adapter reads all open issues, dependencies, descendants and paginated comments', async () => {
  const calls = [];
  const execute = async (_command, args) => {
    calls.push(args);
    const path = args[1];
    const body = path.includes('/issues?') ? JSON.stringify([[{ number: 1 }, { number: 2, pull_request: {} }]])
      : path.includes('/dependencies/blocked_by') ? JSON.stringify([[{ number: 3, state: 'closed', state_reason: 'not_planned' }]])
      : path.includes('/sub_issues') ? JSON.stringify([[{ number: 4 }]])
      : path.includes('/comments') ? JSON.stringify([[{ id: 5 }]])
      : '[]';
    return { stdout: body, stderr: '', code: 0 };
  };
  const github = new GitHub('example/project', { execute });
  assert.deepEqual(await github.openIssues(), [{ number: 1 }]);
  assert.deepEqual(await github.dependencies(1), [{ number: 3, state: 'closed', state_reason: 'not_planned' }]);
  assert.deepEqual(await github.children(1), [{ number: 4 }]);
  assert.deepEqual(await github.comments(1), [{ id: 5 }]);
  assert.equal(calls.length, 4);
});

test('GitHub adapter treats a missing parent as a top-level issue and preserves unrelated labels on state updates', async () => {
  let names = ['enhancement', 'area/music'];
  const execute = async (_command, args) => {
    if (args[0] === 'api' && args[1].endsWith('/parent')) {
      throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { result: { stderr: 'gh: Not Found (HTTP 404)' } });
    }
    if (args[0] === 'issue' && args[1] === 'edit') {
      const addIndex = args.indexOf('--add-label'), removeIndex = args.indexOf('--remove-label');
      if (addIndex >= 0) names.push(args[addIndex + 1]);
      if (removeIndex >= 0) names = names.filter(value => value !== args[removeIndex + 1]);
      return { stdout: '', stderr: '', code: 0 };
    }
    if (args[0] === 'api' && args[1].includes('/issues/1')) return { stdout: JSON.stringify({ number: 1, labels: names.map(name => ({ name })) }), stderr: '', code: 0 };
    throw new Error(`Unexpected command ${args.join(' ')}`);
  };
  const github = new GitHub('example/project', { execute });
  assert.deepEqual(await github.parents(1), []);
  const updated = await github.setWorkflowState(1, 'ready', DEFAULT_LABELS);
  assert.deepEqual(updated.labels.map(label => label.name), ['enhancement', 'area/music', 'ready']);
});

test('unknown closed blocker reasons require reconciliation', async () => {
  const result = await eligibility(adapter({ dependencies: [{ number: 12, state: 'closed', state_reason: null }] }), 1);
  assert.equal(result.eligible, false);
  assert.match(result.reasons.join(' '), /unrecognized closed reason/);
});

test('GitHub adapter creates only missing workflow labels and verifies the result', async () => {
  const names = new Set(['ready', 'triage']);
  const calls = [];
  const execute = async (_command, args) => {
    calls.push(args);
    if (args[0] === 'label' && args[1] === 'list') return { stdout: JSON.stringify([...names].map(name => ({ name }))), stderr: '', code: 0 };
    if (args[0] === 'label' && args[1] === 'create') { names.add(args[2]); return { stdout: '', stderr: '', code: 0 }; }
    throw new Error(`Unexpected command ${args.join(' ')}`);
  };
  const github = new GitHub('example/project', { execute });
  const result = await github.ensureWorkflowLabels(DEFAULT_LABELS);
  assert.deepEqual(result.created, ['proposal', 'on-hold', 'needs-input']);
  assert.equal(calls.filter(args => args[0] === 'label' && args[1] === 'create').length, 3);
  assert.equal(names.size, 5);
});

test('GitHub adapter rejects native parent cycles instead of hiding malformed relationships', async () => {
  const execute = async (_command, args) => {
    if (args[0] === 'api' && args[1].endsWith('/issues/1/parent')) return { stdout: JSON.stringify({ number: 2 }), stderr: '', code: 0 };
    if (args[0] === 'api' && args[1].endsWith('/issues/2/parent')) return { stdout: JSON.stringify({ number: 1 }), stderr: '', code: 0 };
    throw new Error(`Unexpected command ${args.join(' ')}`);
  };
  const github = new GitHub('example/project', { execute });
  await assert.rejects(github.parents(1), /parent cycle detected/);
});
