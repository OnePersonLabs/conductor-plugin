import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectorEvents } from '../plugins/conductor/lib/director-events.mjs';

const THREAD = '019c6e27-e55b-73d1-87d8-4e01f1f75043';
function harness({ execute = async () => ({ code: 0, stdout: 'queued' }), state = {}, host } = {}) {
  let saves = 0;
  const events = new DirectorEvents({ state, threadId: THREAD, cwd: 'repo', execute, host, save: async () => { saves++; } });
  return { events, state, saves: () => saves };
}

test('consumption resolves an uncertain submission without replaying it', async () => {
  let calls = 0;
  const { events } = harness({ execute: async () => {
    if (++calls === 1) throw new Error('reply lost after queue accepted');
    return { code: 0 };
  } });
  const first = await events.emit({ kind: 'done' });
  assert.equal((await events.flush()).status, 'uncertain');
  await events.acknowledge([first.id]);
  await events.emit({ kind: 'next' });
  assert.equal((await events.flush()).status, 'queued');
  assert.equal(calls, 2);
});

test('busy director retains changes and starts one turn only after becoming idle', async () => {
  let type = 'active', calls = 0;
  const host = { status: async () => ({ type }), startRunner: async () => { calls++; type = 'active'; return { id: 'turn-1' }; } };
  const { events, state } = harness({ host });
  await events.emit({ kind: 'first' });
  assert.equal((await events.flush()).status, 'busy');
  await events.emit({ kind: 'second' });
  assert.equal((await events.flush()).status, 'busy');
  assert.equal(calls, 0);
  type = 'idle';
  await Promise.all([events.flush(), events.flush(), events.flush()]);
  assert.equal(calls, 1);
  assert.equal(state.batches[0].eventIds.length, 2);
  assert.equal(state.batches[0].turnId, 'turn-1');
  await events.acknowledge(state.batches[0].eventIds);
  await events.emit({ kind: 'arrived-after-ack' });
  assert.equal((await events.flush()).status, 'busy');
  assert.equal(calls, 1);
  type = 'idle';
  assert.equal((await events.flush()).status, 'queued');
  assert.equal(calls, 2);
  assert.equal((await events.settle(state.checkRevision)).idle, true);
  type = 'idle';
  assert.equal((await events.flush()).status, 'idle');
  assert.equal(calls, 2);
});

test('settle consumes only the inspected revision and preserves a change at the idle boundary', async () => {
  const { events, state } = harness();
  await events.emit({ kind: 'inspected' });
  const revision = state.checkRevision;
  await events.emit({ kind: 'arrived-later' });
  const receipt = await events.settle(revision);
  assert.equal(receipt.idle, false);
  assert.equal(state.pendingCheck, true);
  assert.deepEqual((await events.pending()).map(item => item.event.kind), ['arrived-later']);
  assert.equal((await events.settle(state.checkRevision)).idle, true);
  assert.equal(state.pendingCheck, false);
  await assert.rejects(events.settle(state.checkRevision + 1), /checkRevision/);
});

test('unknown host state and recovery-required turns never submit automatically', async () => {
  let calls = 0;
  const host = { status: async () => ({ type: 'unknown' }), startRunner: async () => { calls++; } };
  const { events, state } = harness({ host });
  await events.emit({ kind: 'change' });
  assert.equal((await events.flush()).status, 'unavailable');
  state.recoveryRequired = 'last turn failed';
  host.status = async () => ({ type: 'idle' });
  assert.equal((await events.flush()).status, 'recovery-required');
  assert.equal(calls, 0);
});

test('observations wake only on first value or a changed snapshot', async () => {
  const { events } = harness();
  assert.equal((await events.observe('issues', [{ number: 1 }], { kind: 'issue-change' })).changed, true);
  assert.equal((await events.observe('issues', [{ number: 1 }], { kind: 'issue-change' })).changed, false);
  assert.equal((await events.observe('issues', [{ number: 2 }], { kind: 'issue-change' })).changed, true);
  assert.equal((await events.pending()).length, 2);
});

test('queue submissions are coalesced, persisted, and not repeated when unchanged', async () => {
  const calls = [];
  const { events, state } = harness({ execute: async (...args) => { calls.push(args); return { code: 0, stdout: 'accepted' }; } });
  const first = await events.emit({ kind: 'worker-completed', issue: 4 });
  const second = await events.emit({ kind: 'worker-completed', issue: 5 });
  const result = await events.flush();
  assert.equal(result.status, 'queued');
  assert.deepEqual(result.batch.eventIds, [first.id, second.id]);
  assert.deepEqual(calls[0][1].slice(0, 3), ['queue', '--thread', THREAD]);
  assert.equal(calls[0][1].includes('5'), false);
  assert.equal((await events.flush()).status, 'awaiting-acknowledgement');
  assert.equal(calls.length, 1);
  assert.equal(state.batches[0].status, 'queued');
});

test('new events remain readable but do not create another queued batch before acknowledgement', async () => {
  let calls = 0;
  const { events } = harness({ execute: async () => { calls++; return { code: 0 }; } });
  const first = await events.emit({ kind: 'done', id: 'one' });
  await events.flush();
  const second = await events.emit({ kind: 'done', id: 'two' });
  await events.flush();
  assert.equal(calls, 1);
  assert.deepEqual((await events.pending()).map(item => item.id), [first.id, second.id]);
  await events.acknowledge([first.id]);
  await events.acknowledge([first.id]);
  assert.deepEqual((await events.pending()).map(item => item.id), [second.id]);
  assert.equal((await events.flush()).status, 'queued');
  assert.equal(calls, 2);
});

test('uncertain queue outcome is retained and explicit retry requires reconciliation', async () => {
  let calls = 0;
  const { events, state } = harness({ execute: async () => { calls++; throw new Error('connection closed after write'); } });
  const event = await events.emit({ kind: 'failed-worker' });
  const first = await events.flush();
  assert.equal(first.status, 'uncertain');
  assert.equal((await events.flush()).status, 'uncertain');
  assert.equal(calls, 1);
  await assert.rejects(events.retry(first.batch.id), /confirmNotQueued/);
  const retry = await events.retry(first.batch.id, { confirmedNotQueued: true });
  assert.equal(retry.status, 'uncertain');
  assert.equal(calls, 2);
  assert.equal((await events.pending())[0].id, event.id);
  assert.equal(state.batches.at(-1).eventIds[0], event.id);
});

test('restart retains event and queued batch ownership without replay', async () => {
  let calls = 0;
  const first = harness({ execute: async () => { calls++; return { code: 0 }; } });
  const event = await first.events.emit({ kind: 'question', request: 'r1' });
  await first.events.flush();
  const restored = harness({ state: structuredClone(first.state), execute: async () => { calls++; return { code: 0 }; } });
  assert.equal((await restored.events.pending())[0].id, event.id);
  assert.equal((await restored.events.flush()).status, 'awaiting-acknowledgement');
  assert.equal(calls, 1);
});

test('restart converts interrupted submission to uncertain and retains partial batch receipts', async () => {
  const state = {
    threadId: THREAD, enabled: true, snapshots: {}, acknowledged: [],
    events: [
      { id: 'event-a', event: { kind: 'a' }, acknowledgedAt: null },
      { id: 'event-b', event: { kind: 'b' }, acknowledgedAt: null },
    ],
    batches: [{ id: 'batch-a', eventIds: ['event-a','event-b'], status: 'submitting', threadId: THREAD }],
  };
  let calls = 0;
  const restored = harness({ state, execute: async () => { calls++; return { code: 0 }; } });
  assert.equal((await restored.events.flush()).status, 'uncertain');
  assert.equal(state.batches[0].status, 'uncertain');
  assert.equal(calls, 0);
  await restored.events.acknowledge(['event-a']);
  assert.deepEqual((await restored.events.pending()).map(item => item.id), ['event-b']);
  assert.equal(state.events.length, 2);
  assert.equal(state.batches[0].acknowledgedAt, undefined);
});

test('dedupe keys, disabled state, and UUID binding are enforced', async () => {
  const { events, state } = harness();
  const first = await events.emit({ kind: 'answer', dedupeKey: 'question-1' });
  const repeated = await events.emit({ kind: 'answer', dedupeKey: 'question-1' });
  assert.equal(first.id, repeated.id);
  await events.stop();
  assert.equal((await events.flush()).status, 'disabled');
  assert.throws(() => new DirectorEvents({ state: {}, threadId: 'not-a-uuid', save() {}, execute() {} }), /UUID/);
  assert.throws(() => new DirectorEvents({ state: { threadId: '019c6e27-e55b-73d1-87d8-4e01f1f75043' }, threadId: '111c6e27-e55b-73d1-87d8-4e01f1f75043', save() {}, execute() {} }), /binding/);
});
