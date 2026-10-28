import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Coordinator } from '../plugins/conductor/lib/coordinator.mjs';
import { Director } from '../plugins/conductor/lib/director.mjs';

const OLD = '019c6e27-e55b-73d1-87d8-4e01f1f75043';
const NEXT = '019c6e27-e55b-73d1-87d8-4e01f1f75044';
const OTHER = '019c6e27-e55b-73d1-87d8-4e01f1f75045';
const activity = (state, turnId = null, revision = 0) => ({ state, turnId, nativeTurnId: turnId, wakeupMarker: null, revision });

function fixture({ old = activity('idle', 'old-turn', 2), target = activity('unknown'), busyControl = 0 } = {}) {
  const queue = new Map([[OLD, []], [NEXT, []]]);
  const activities = new Map([[OLD, old], [NEXT, target]]);
  const writes = { saves: 0, binds: [], starts: 0, scans: 0 };
  const directorState = { threadId: OLD, enabled: true, snapshots: {}, events: [], batches: [], acknowledged: [], checkRevision: 0, checkedRevision: 0, threadHostOwnership: { threadId: OLD, host: 'codex-desktop' } };
  const state = { repository: 'owner/repo', root: 'C:/repo', director: directorState, jobs: [{ issue: 7, phase: 'paused', intent: 'pause', threadId: 'worker-7' }], holds: [{ id: 'hold-1', active: true }], admissionPaused: true };
  const client = {
    listQueuedMessages: async ({ threadId }) => structuredClone(queue.get(threadId) ?? []),
    deleteQueuedMessage: async ({ threadId, queuedSubmissionId }) => {
      const items = queue.get(threadId) ?? [], index = items.findIndex(item => item.id === queuedSubmissionId);
      if (index < 0) return false;
      items.splice(index, 1); return true;
    },
  };
  const host = new EventEmitter();
  Object.assign(host, {
    hostMode: 'codex-desktop', threadId: OLD, threadEnsured: true, client, currentStatus: { type: 'idle', activeFlags: [] },
    cancelQueuedWakeup: async (queueItemId) => {
      const items = queue.get(OLD) ?? [], index = items.findIndex(item => item.id === queueItemId);
      if (index < 0) return false;
      items.splice(index, 1); return true;
    },
    validateDesktopThread: async id => {
      if (id === OTHER) throw new Error('destination belongs to another repository');
      return { id, cwd: 'C:/repo', status: activities.get(id)?.state ?? 'unknown' };
    },
    status: async () => {
      const row = activities.get(host.threadId) ?? activity('unknown');
      return { type: row.state, nativeTurnId: row.turnId };
    },
    startRunner: async () => { writes.starts++; return { queued: true, id: `queue-${writes.starts}` }; },
  });
  const activityStore = {
    read: async id => structuredClone(activities.get(id) ?? activity('unknown')),
    pruneExcept: async ids => { writes.binds.push([...ids]); for (const key of activities.keys()) if (!ids.includes(key) && activities.get(key).state !== 'active') activities.delete(key); },
  };
  const coordinator = new Coordinator({ repo: { root: 'C:/repo', commonDir: 'C:/repo/.git' }, config: { version: 2, repository: 'owner/repo', labels: {}, pollMs: 1_000 }, store: { save: async () => { writes.saves++; }, cleanupOwned: async () => ({}) }, github: {} });
  coordinator.state = state; coordinator.directorHost = host; coordinator.directorActivity = activityStore; coordinator.director = new Director(coordinator, OLD); coordinator.directorControlCount = busyControl; coordinator.execute = async () => ({ code: 0, stdout: '', stderr: '' });
  coordinator.ready = true;
  coordinator.loop.wake = async () => { writes.scans++; };
  return { coordinator, state, directorState, host, activities, queue, writes };
}

test('idle attach switches only after reconciling old queued wakes and schedules the destination check', async () => {
  const h = fixture();
  const batch = { id: '550e8400-e29b-41d4-a716-446655440000', threadId: OLD, status: 'queued', queueItemId: 'obsolete', eventIds: ['evt'] };
  h.directorState.batches.push(batch);
  h.directorState.events.push({ id: 'evt', revision: 1, event: { kind: 'pending' }, acknowledgedAt: null });
  h.queue.set(OLD, [{ id: 'obsolete', input: [{ type: 'text', text: `<!-- conductor:director-wakeup:${batch.id} -->` }] }]);
  const result = await h.coordinator.attachThread(NEXT);
  assert.equal(result.status, 'attached');
  assert.equal(result.threadId, NEXT);
  assert.equal(h.state.director.threadId, NEXT);
  assert.deepEqual(h.queue.get(OLD), []);
  assert.equal(batch.status, 'reconciled-not-queued');
  assert.equal(h.writes.starts, 0, 'unknown destination lifecycle is never treated as idle');
  assert.deepEqual(h.state.jobs, [{ issue: 7, phase: 'paused', intent: 'pause', threadId: 'worker-7' }]);
  assert.equal(h.state.admissionPaused, true);
  assert.deepEqual(h.state.holds, [{ id: 'hold-1', active: true }]);
  await h.coordinator.wake();
  assert.equal(h.writes.scans, 1, 'normal scans resume after the binding has changed');
});

test('an absent queue marker without a cancellation receipt or terminal consumption keeps the batch and binding', async () => {
  const h = fixture();
  const batch = { id: '550e8400-e29b-41d4-a716-446655440001', threadId: OLD, status: 'queued', queueItemId: 'vanished', eventIds: ['evt'] };
  h.directorState.batches.push(batch);
  const result = await h.coordinator.attachThread(NEXT);
  assert.equal(result.status, 'handoff-pending');
  assert.match(result.blocker, /absent from the queue without a matching terminal consumption receipt/);
  assert.equal(batch.status, 'queued');
  assert.equal(h.state.director.threadId, OLD);
});

test('queue disappearance after unconfirmed cancellation is not treated as delivery or cancellation', async () => {
  const h = fixture();
  const batch = { id: '550e8400-e29b-41d4-a716-446655440002', threadId: OLD, status: 'queued', queueItemId: 'raced', eventIds: ['evt'] };
  h.directorState.batches.push(batch);
  h.queue.set(OLD, [{ id: 'raced', input: [{ type: 'text', text: `<!-- conductor:director-wakeup:${batch.id} -->` }] }]);
  h.host.cancelQueuedWakeup = async () => { h.queue.set(OLD, []); return false; };
  const result = await h.coordinator.attachThread(NEXT);
  assert.equal(result.status, 'handoff-pending');
  assert.match(result.blocker, /Cancellation .* was not confirmed/);
  assert.equal(batch.status, 'queued');
  assert.equal(h.state.director.threadId, OLD);
});

test('a matching terminal consumption receipt permits cleanup when the queue marker is already gone', async () => {
  const terminal = activity('idle', 'consumed-turn', 4);
  const h = fixture({ old: terminal });
  const batch = { id: '550e8400-e29b-41d4-a716-446655440003', threadId: OLD, status: 'queued', turnId: 'consumed-turn', nativeConsumed: true, eventIds: ['evt'] };
  h.directorState.batches.push(batch);
  const result = await h.coordinator.attachThread(NEXT);
  assert.equal(result.status, 'attached');
  assert.equal(h.state.director.threadId, NEXT);
  assert.equal(batch.status, 'reconciled-not-queued');
});

test('a source turn that starts during queue reconciliation defers the handoff', async () => {
  const h = fixture();
  const batch = { id: '550e8400-e29b-41d4-a716-446655440004', threadId: OLD, status: 'queued', queueItemId: 'late-turn', eventIds: ['evt'] };
  h.directorState.batches.push(batch);
  h.queue.set(OLD, [{ id: 'late-turn', input: [{ type: 'text', text: `<!-- conductor:director-wakeup:${batch.id} -->` }] }]);
  h.host.cancelQueuedWakeup = async queueItemId => {
    h.activities.set(OLD, activity('active', 'late-turn-id', 3));
    const items = h.queue.get(OLD), index = items.findIndex(item => item.id === queueItemId);
    if (index >= 0) items.splice(index, 1);
    return true;
  };
  const result = await h.coordinator.attachThread(NEXT);
  assert.equal(result.status, 'handoff-pending');
  assert.equal(result.turnId, 'late-turn-id');
  assert.equal(h.state.director.handoff.status, 'waiting-turn');
  assert.equal(h.state.director.threadId, OLD);
});

test('post-commit cleanup failure reports attached and keeps the durable destination event', async () => {
  const h = fixture();
  h.coordinator.directorActivity.pruneExcept = async () => { throw new Error('locked activity database'); };
  const result = await h.coordinator.attachThread(NEXT);
  assert.equal(result.status, 'attached');
  assert.equal(h.state.director.threadId, NEXT);
  assert.match(result.warning, /cleanup will retry at startup/);
  assert.ok(h.state.director.events.some(item => item.event?.kind === 'director-attached' && item.event.threadId === NEXT && !item.acknowledgedAt));
});

test('pre-commit validation failure remains an explicit blocked handoff', async () => {
  const h = fixture();
  const validate = h.host.validateDesktopThread;
  let calls = 0;
  h.host.validateDesktopThread = async id => {
    if (++calls > 1) throw new Error('destination chat is unavailable');
    return validate(id);
  };
  const result = await h.coordinator.attachThread(NEXT);
  assert.equal(result.status, 'handoff-pending');
  assert.equal(result.blocker, 'destination chat is unavailable');
  assert.equal(h.state.director.handoff.status, 'blocked');
  assert.equal(h.state.director.threadId, OLD);
});

test('active handoff persists, suppresses signals, and switches only on the matching terminal receipt', async () => {
  const h = fixture({ old: activity('active', 'turn-live', 4), target: activity('idle', 'target-old', 3) });
  const pending = await h.coordinator.attachThread(NEXT);
  assert.equal(pending.status, 'handoff-pending');
  assert.equal(pending.turnId, 'turn-live');
  assert.equal(h.state.director.threadId, OLD);
  assert.equal((await h.coordinator.requestCheck({ manual: true })).status, 'handoff-pending');
  assert.equal((await h.coordinator.director.events.flush()).status, 'handoff-pending');
  const blocked = await h.coordinator.progressHandoff(activity('active', 'different-turn', 5));
  h.activities.set(OLD, activity('active', 'different-turn', 5));
  assert.equal(blocked.status, 'handoff-pending');
  assert.equal(h.state.director.threadId, OLD);
  h.activities.set(OLD, activity('idle', 'turn-live', 5));
  const result = await h.coordinator.progressHandoff(activity('idle', 'turn-live', 5));
  assert.equal(result.status, 'attached');
  assert.equal(h.state.director.threadId, NEXT);
  assert.equal(h.writes.starts, 1, 'handoff emits a destination reconciliation even when snapshots were unchanged');
  await assert.rejects(h.coordinator.control({ op: 'bind', repository: 'owner/repo', threadId: OLD }), /identity does not match/);
});

test('an interrupted old turn is terminal for handoff and its recovery is resolved', async () => {
  const h = fixture({ old: activity('interrupted', 'turn-interrupted', 6), target: activity('unknown') });
  h.directorState.recoveryRequired = { turnId: 'turn-interrupted', status: 'interrupted' };
  const result = await h.coordinator.attachThread(NEXT);
  assert.equal(result.status, 'attached');
  assert.equal(h.directorState.recoveryRequired.outcome, 'Director chat handed off after its native turn reached a terminal state.');
  assert.ok(h.directorState.recoveryRequired.resolvedAt);
});

test('handoff waits for an in-flight director control and rejects competing destinations', async () => {
  const h = fixture({ busyControl: 1 });
  const pending = await h.coordinator.attachThread(NEXT);
  assert.equal(pending.status, 'handoff-pending');
  assert.match(pending.blocker, /control operation/);
  await assert.rejects(h.coordinator.attachThread(OTHER), /already pending/);
  assert.equal(h.state.director.threadId, OLD);
  h.coordinator.directorControlCount = 0;
  const completed = await h.coordinator.progressHandoff(await h.coordinator.directorActivity.read(OLD));
  assert.equal(completed.status, 'attached');
  assert.equal(h.state.director.threadId, NEXT);
});

test('a pending handoff retries on the same native activity revision', async () => {
  const h = fixture({ busyControl: 1 });
  await h.coordinator.attachThread(NEXT);
  h.coordinator.directorControlCount = 0;
  h.coordinator.activityRevision = 2;
  const retried = await h.coordinator.refreshDirectorActivity();
  assert.equal(retried, undefined);
  assert.equal(h.state.director.threadId, NEXT);
});

test('same-target retry resumes pending handoff and wrong repository destination remains blocked', async () => {
  const h = fixture({ old: activity('active', 'turn-live', 7) });
  await h.coordinator.attachThread(NEXT);
  assert.equal((await h.coordinator.attachThread(NEXT)).status, 'handoff-pending');
  h.activities.set(OLD, activity('idle', 'turn-live', 8));
  const switched = await h.coordinator.progressHandoff(await h.coordinator.directorActivity.read(OLD));
  assert.equal(switched.status, 'attached');
  const bad = fixture();
  await assert.rejects(bad.coordinator.attachThread(OTHER), /another repository/);
  assert.equal(bad.directorState.handoff, undefined, 'invalid destinations cannot strand a pending handoff');
  assert.equal(bad.state.director.threadId, OLD);
});

test('handoff waits for an already-started queue submission before switching', async () => {
  const h = fixture();
  let release;
  h.coordinator.director.events.flushing = new Promise(resolve => { release = resolve; });
  let completed = false;
  const attaching = h.coordinator.attachThread(NEXT).then(result => { completed = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  assert.equal(h.state.director.threadId, OLD);
  release();
  assert.equal((await attaching).status, 'attached');
  assert.equal(h.state.director.threadId, NEXT);
});

test('unknown old activity stays pending until a specific active turn receives its matching terminal receipt', async () => {
  const h = fixture({ old: activity('unknown'), target: activity('unknown') });
  const pending = await h.coordinator.attachThread(NEXT);
  assert.equal(pending.status, 'handoff-pending');
  assert.equal(h.state.director.threadId, OLD);
  assert.equal((await h.coordinator.progressHandoff(activity('unknown'))).status, 'handoff-pending');
  h.activities.set(OLD, activity('active', 'observed-turn', 1));
  const active = await h.coordinator.progressHandoff(await h.coordinator.directorActivity.read(OLD));
  assert.equal(active.status, 'handoff-pending');
  assert.equal(h.directorState.handoff.turnId, 'observed-turn');
  h.activities.set(OLD, activity('idle', 'different-turn', 2));
  assert.equal((await h.coordinator.progressHandoff(await h.coordinator.directorActivity.read(OLD))).status, 'handoff-pending');
  assert.equal(h.state.director.threadId, OLD);
  h.activities.set(OLD, activity('idle', 'observed-turn', 2));
  assert.equal((await h.coordinator.progressHandoff(await h.coordinator.directorActivity.read(OLD))).status, 'attached');
  assert.equal(h.state.director.threadId, NEXT);
});
