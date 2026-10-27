import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectorActivity } from '../plugins/conductor/lib/director-activity.mjs';
import { DirectorHost } from '../plugins/conductor/lib/director-host.mjs';
import { DirectorEvents } from '../plugins/conductor/lib/director-events.mjs';
import { Coordinator } from '../plugins/conductor/lib/coordinator.mjs';

const THREAD = '01a17ea2-0042-7451-9217-6162755fcb6c';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-desktop-'));
  const activity = new DirectorActivity({ dir });
  const state = { threadId: THREAD, threadHostOwnership: { threadId: THREAD, host: 'codex-desktop' } };
  let queueCalls = 0;
  const queue = [];
  const client = new class extends EventEmitter {
    async connect() {}
    async close() {}
    async readThread() { return { id: THREAD, cwd: dir, status: { type: 'notLoaded' } }; }
    async resumeThread() { assert.fail('Desktop chat must never resume in the daemon'); }
    async startThread() { assert.fail('Desktop chat must never be created in the daemon'); }
    async startTurn() { assert.fail('Desktop turns must be delivered through the native queue'); }
    async listQueuedMessages() { return structuredClone(queue); }
    async addQueuedMessage({ text, clientUserMessageId }) {
      const item = { id: `queue-${++queueCalls}`, clientUserMessageId, input: [{ type: 'text', text }] };
      queue.push(item); return item;
    }
    async deleteQueuedMessage({ queuedSubmissionId }) {
      const index = queue.findIndex(item => item.id === queuedSubmissionId);
      if (index < 0) return false;
      queue.splice(index, 1); return true;
    }
  }();
  const host = new DirectorHost({ client, cwd: dir, repository: 'owner/repo', state, activity, save: async () => {} });
  await host.connect(); await host.ensureThread();
  const events = new DirectorEvents({ state, threadId: THREAD, cwd: dir, host, execute: async () => assert.fail('No CLI queue fallback'), save: async () => {} });
  const c = new Coordinator({ repo: { root: dir }, config: { repository: 'owner/repo' }, store: { save: async () => {} } });
  c.state = { director: state, jobs: [] }; c.director = { events }; c.directorHost = host; c.directorActivity = activity;
  t.after(async () => { activity.close(); await host.close(); await rm(dir, { recursive: true, force: true }); });
  return { activity, state, host, events, queue, calls: () => queueCalls, c };
}

test('Desktop hooks suppress busy wakes and its native queue receives one wake on idle', async t => {
  const f = await fixture(t);
  await f.events.emit({ kind: 'ready-issue' });
  assert.equal((await f.events.flush()).status, 'unavailable');
  await f.activity.record({ threadId: THREAD, turnId: 'manual', event: 'UserPromptSubmit' });
  await f.events.emit({ kind: 'another-issue' });
  assert.equal((await f.events.flush()).status, 'busy');
  assert.equal(f.calls(), 0);
  const inspected = f.state.checkRevision;
  await f.events.settle(inspected);
  await f.events.emit({ kind: 'arrived-at-idle-boundary' });
  await f.activity.record({ threadId: THREAD, turnId: 'manual', event: 'Stop' });
  await f.c.refreshDirectorActivity();
  assert.equal(f.calls(), 1);
  const batch = f.state.batches[0];
  assert.equal(batch.queueItemId, 'queue-1');
  assert.equal(batch.turnId, undefined);
  assert.match(f.queue[0].input[0].text, /\$conductor:director/);
  await f.events.emit({ kind: 'after-enqueue' });
  await f.events.flush();
  assert.equal(f.calls(), 1);
  // Native Desktop consumes the queue itself and publishes the actual turn ID.
  f.queue.length = 0;
  await f.activity.record({ threadId: THREAD, turnId: 'native-wake', event: 'UserPromptSubmit', wakeupMarker: batch.id });
  await f.c.refreshDirectorActivity();
  assert.equal(batch.turnId, 'native-wake');
  assert.equal(batch.nativeConsumed, true);
  await f.events.settle(f.state.checkRevision);
  await f.activity.record({ threadId: THREAD, turnId: 'native-wake', event: 'Stop' });
  await f.c.refreshDirectorActivity();
  assert.equal(f.calls(), 1);
});

test('a manual Desktop turn cancels an obsolete unconsumed wake after handling its work', async t => {
  const f = await fixture(t);
  await f.activity.record({ threadId: THREAD, turnId: 'first', event: 'UserPromptSubmit' });
  await f.activity.record({ threadId: THREAD, turnId: 'first', event: 'Stop' });
  await f.events.emit({ kind: 'ready' });
  await f.events.flush();
  assert.equal(f.queue.length, 1);
  await f.activity.record({ threadId: THREAD, turnId: 'manual', event: 'UserPromptSubmit' });
  await f.events.settle(f.state.checkRevision);
  assert.equal(f.queue.length, 0);
  await f.activity.record({ threadId: THREAD, turnId: 'manual', event: 'Stop' });
  await f.events.flush();
  assert.equal(f.calls(), 1);
});

test('native receipt resolves an uncertain consumed wake; interruption waits for a new native turn', async t => {
  const f = await fixture(t);
  const event = await f.events.emit({ kind: 'work' });
  const marker = '85d704f0-78d4-4e05-98e1-542381a8672c';
  f.state.batches.push({ id: marker, status: 'uncertain', eventIds: [event.id] });
  await f.activity.record({ threadId: THREAD, turnId: 'consumed', event: 'UserPromptSubmit', wakeupMarker: marker });
  await f.c.refreshDirectorActivity();
  assert.equal(f.state.batches[0].status, 'queued');
  await f.activity.record({ threadId: THREAD, turnId: 'consumed', event: 'Interrupt' });
  await f.c.refreshDirectorActivity();
  assert.equal((await f.events.flush()).status, 'recovery-required');
  await f.activity.record({ threadId: THREAD, turnId: 'explicit-resume', event: 'UserPromptSubmit' });
  await f.c.refreshDirectorActivity();
  assert.ok(f.state.recoveryRequired.resolvedAt);
  assert.equal((await f.events.flush()).status, 'busy');
  assert.equal(f.calls(), 0);
});

test('a manual turn settling during queue submission removes the late wake receipt', async t => {
  const f = await fixture(t);
  await f.activity.record({ threadId: THREAD, turnId: 'initial', event: 'UserPromptSubmit' });
  await f.activity.record({ threadId: THREAD, turnId: 'initial', event: 'Stop' });
  let release, added;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { added = resolve; });
  const original = f.host.client.addQueuedMessage.bind(f.host.client);
  f.host.client.addQueuedMessage = async input => {
    const receipt = await original(input);
    added(); await pending; return receipt;
  };
  await f.events.emit({ kind: 'ready' });
  const flush = f.events.flush();
  await started;
  await f.activity.record({ threadId: THREAD, turnId: 'manual', event: 'UserPromptSubmit' });
  await f.events.settle(f.state.checkRevision);
  release(); await flush;
  assert.equal(f.queue.length, 0);
  assert.equal(f.calls(), 1);
});

test('failed obsolete wake deletion retains recovery and retries deletion without resubmission', async t => {
  const f = await fixture(t);
  await f.activity.record({ threadId: THREAD, turnId: 'initial', event: 'UserPromptSubmit' });
  await f.activity.record({ threadId: THREAD, turnId: 'initial', event: 'Stop' });
  await f.events.emit({ kind: 'ready' });
  await f.events.flush();
  const batch = f.state.batches[0];
  const original = f.host.client.deleteQueuedMessage.bind(f.host.client);
  f.host.client.deleteQueuedMessage = async () => { throw new Error('queue unavailable'); };
  await assert.rejects(f.events.settle(f.state.checkRevision), /queue unavailable/);
  assert.equal(batch.cancellationRequired, true);
  assert.equal((await f.events.flush()).status, 'recovery-required');
  f.host.client.deleteQueuedMessage = original;
  await f.events.retry(batch.id);
  await f.events.settle(f.state.checkRevision);
  assert.equal(f.queue.length, 0);
  assert.equal(f.calls(), 1);
  assert.ok(f.state.recoveryRequired.resolvedAt);
});

test('explicit stop releases the service even when deleting its pending wake fails', async t => {
  const f = await fixture(t);
  await f.activity.record({ threadId: THREAD, turnId: 'initial', event: 'UserPromptSubmit' });
  await f.activity.record({ threadId: THREAD, turnId: 'initial', event: 'Stop' });
  await f.events.emit({ kind: 'ready' });
  await f.events.flush();
  let released = false;
  f.c.store.release = async () => { released = true; };
  f.host.client.deleteQueuedMessage = async () => { throw new Error('queue unavailable'); };
  await assert.rejects(f.c.stop({ explicit: true }), /queue unavailable/);
  assert.equal(released, true);
  assert.equal(f.c.state.running, false);
  assert.equal(f.c.state.admissionPaused, true);
  assert.equal(f.state.enabled, false);
  assert.equal(f.state.batches[0].cancellationRequired, true);
});
