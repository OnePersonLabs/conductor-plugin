import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DirectorHost } from '../plugins/conductor/lib/director-host.mjs';

class FakeCodex extends EventEmitter {
  constructor() { super(); this.threads = []; this.statusValue = { type: 'idle' }; this.calls = []; this.queued = []; }
  async connect() { this.calls.push(['connect']); }
  async listThreads() { this.calls.push(['listThreads']); return this.threads; }
  async startThread(args) { this.calls.push(['startThread', args]); const thread = { id: 'new-thread', cwd: args.cwd, status: { type: 'idle' } }; this.threads.push({ ...thread, name: null }); return thread; }
  async setThreadName(args) { this.calls.push(['setThreadName', args]); const thread = this.threads.find(x => x.id === args.threadId); if (thread) thread.name = args.name; }
  async resumeThread(args) { this.calls.push(['resumeThread', args]); const thread = this.threads.find(x => x.id === args.threadId); if (!thread) throw Object.assign(new Error('thread not found'), { code: -32001 }); if (this.statusValue.type === 'notLoaded') this.statusValue = { type: 'idle' }; return { ...thread, status: this.statusValue }; }
  async readThread(args) { this.calls.push(['readThread', args]); const thread = this.threads.find(x => x.id === args.threadId); if (!thread) throw Object.assign(new Error('thread not found'), { code: -32001 }); return { ...thread, status: this.statusValue }; }
  async startTurn(args) { this.calls.push(['startTurn', args]); this.statusValue = { type: 'active', activeFlags: [] }; return { id: 'turn-1' }; }
  async addQueuedMessage(args) { this.calls.push(['addQueuedMessage', args]); const item = { id: `queue-${this.queued.length + 1}`, threadId: args.threadId, input: [{ type: 'text', text: args.text }], clientUserMessageId: args.clientUserMessageId }; this.queued.push(item); return item; }
  async listQueuedMessages(args) { this.calls.push(['listQueuedMessages', args]); return this.queued; }
  async deleteQueuedMessage(args) { this.calls.push(['deleteQueuedMessage', args]); const index = this.queued.findIndex(item => item.id === args.queuedSubmissionId); if (index < 0) return false; this.queued.splice(index, 1); return true; }
  async close() { this.calls.push(['close']); }
}

function fixture(overrides = {}) {
  const client = overrides.client ?? new FakeCodex();
  const state = overrides.state ?? { threadId: overrides.threadId ?? null };
  let saves = 0;
  const host = new DirectorHost({
    client, cwd: 'C:\\repo', repository: 'owner/repo', model: 'gpt-6.1-sol',
    reasoningEffort: 'medium', skillPath: 'C:\\plugin\\skills\\director\\SKILL.md',
    state, save: async () => { saves++; }, ...overrides,
  });
  return { host, client, state, saves: () => saves };
}

function desktopFixture(overrides = {}) {
  const client = overrides.client ?? new FakeCodex();
  const threadId = overrides.threadId ?? 'desktop-thread';
  const state = overrides.state ?? { threadId, threadHostOwnership: { threadId, host: 'codex-desktop' } };
  client.threads.push({ id: threadId, name: 'Conductor: owner/repo', cwd: 'C:\\repo', status: { type: 'notLoaded' } });
  let activityState = 'idle';
  const activity = overrides.activity ?? { read: async id => { assert.equal(id, threadId); return { state: activityState }; } };
  const f = fixture({ client, state, host: 'codex-desktop', activity, threadId, ...overrides });
  return { ...f, setActivity: value => { activityState = value; } };
}

test('creates, names, and durably binds one persistent director before its first turn', async () => {
  const f = fixture();
  await f.host.connect();
  assert.equal(await f.host.ensureThread(), 'new-thread');
  assert.equal(f.state.threadId, 'new-thread');
  assert.equal(f.state.threadCreationIntent, undefined);
  const started = await f.host.startRunner({ prompt: 'Inspect ready work', revision: 'r1' });
  assert.equal(started.id, 'turn-1');
  assert.ok(f.client.calls.findIndex(x => x[0] === 'setThreadName') < f.client.calls.findIndex(x => x[0] === 'startTurn'));
  const turn = f.client.calls.find(x => x[0] === 'startTurn')[1];
  assert.equal(turn.threadId, 'new-thread');
  assert.equal(turn.skillPath, 'C:\\plugin\\skills\\director\\SKILL.md');
  assert.ok(f.saves() >= 2);
  await f.host.close();
});

test('reuses an exact named repository director and preserves its identity', async () => {
  const client = new FakeCodex();
  client.threads.push({ id: 'existing', name: 'Conductor: owner/repo', cwd: 'C:\\repo', status: { type: 'idle' } });
  const f = fixture({ client });
  await f.host.connect();
  assert.equal(await f.host.ensureThread(), 'existing');
  assert.equal(client.calls.some(x => x[0] === 'startThread'), false);
  assert.equal(f.state.threadId, 'existing');
});

test('retains uncertain thread creation intent and never blindly creates a duplicate', async () => {
  const state = { threadId: null, threadCreationIntent: { id: 'intent', name: 'Conductor: owner/repo', cwd: 'C:\\repo' } };
  const f = fixture({ state });
  await f.host.connect();
  await assert.rejects(f.host.ensureThread(), /outcome is uncertain/);
  assert.equal(f.client.calls.some(x => x[0] === 'startThread'), false);
  assert.equal(state.threadCreationIntent.id, 'intent');
});

test('replaces a confirmed missing director while preserving unrelated recovery state', async () => {
  const state = { threadId: 'deleted-thread', retainedWorker: 'original-worker', threadHostOwnership: { threadId: 'deleted-thread' } };
  const f = fixture({ state });
  await f.host.connect();
  assert.equal(await f.host.ensureThread(), 'new-thread');
  assert.equal(state.threadId, 'new-thread');
  assert.equal(state.retainedWorker, 'original-worker');
  assert.equal(f.client.calls.filter(call => call[0] === 'startThread').length, 1);
});

test('only starts while idle and clears its wake latch when the host completes the turn', async () => {
  const client = new FakeCodex();
  client.threads.push({ id: 'existing', name: 'Conductor: owner/repo', cwd: 'C:\\repo', status: { type: 'idle' } });
  const f = fixture({ client, threadId: 'existing' });
  await f.host.connect();
  client.statusValue = { type: 'active', activeFlags: ['waitingOnUserInput'] };
  await assert.rejects(f.host.startRunner({ revision: 'r1' }), error => error.code === 'DIRECTOR_BUSY');
  assert.equal(client.calls.some(x => x[0] === 'startTurn'), false);

  client.statusValue = { type: 'idle' };
  const started = await f.host.startRunner({ revision: 'r2' });
  assert.equal(started.id, 'turn-1');
  client.emit('notification', { method: 'turn/completed', params: { threadId: 'existing', turn: { id: 'turn-1' } } });
  client.statusValue = { type: 'idle' };
  client.emit('notification', { method: 'thread/status/changed', params: { threadId: 'existing', status: { type: 'idle' } } });
  assert.equal(f.host.inflightRevision, null);
});

test('maps unknown status conservatively and refuses to replace non-missing threads', async () => {
  const client = new FakeCodex();
  client.threads.push({ id: 'existing', name: 'Conductor: owner/repo', cwd: 'C:\\repo', status: { type: 'idle' } });
  const f = fixture({ client, threadId: 'existing' });
  await f.host.connect();
  client.readThread = async () => { throw new Error('connection lost'); };
  assert.equal((await f.host.status()).type, 'unknown');
  client.resumeThread = async () => { throw new Error('connection lost'); };
  await assert.rejects(f.host.ensureThread(), /connection lost/);
  assert.equal(client.calls.some(x => x[0] === 'startThread'), false);
});

test('records interrupted director turns and exposes inspection without auto-retrying them', async () => {
  const client = new FakeCodex();
  client.threads.push({ id: 'existing', name: 'Conductor: owner/repo', cwd: 'C:\\repo', turns: [{ id: 'turn-old', status: 'interrupted' }], status: { type: 'idle' } });
  const f = fixture({ client, threadId: 'existing' });
  await f.host.connect();
  await f.host.ensureThread();
  assert.equal(f.state.recoveryRequired.turnId, 'turn-old');
  assert.equal((await f.host.inspectTurn('turn-old')).status, 'interrupted');
  await assert.rejects(f.host.startRunner(), error => error.code === 'DIRECTOR_RECOVERY_REQUIRED');
  assert.equal(client.calls.some(x => x[0] === 'startTurn'), false);
  await f.host.markTurnReconciled('turn-old', 'operator-reviewed');
  client.statusValue = { type: 'idle' };
  await f.host.startRunner({ revision: 'reconciled' });
  assert.equal(f.state.recoveryRequired.outcome, 'operator-reviewed');
});

test('refuses to adopt an unowned notLoaded thread from another app-server', async () => {
  const client = new FakeCodex();
  client.threads.push({ id: 'desktop', name: 'Conductor: owner/repo', cwd: 'C:\\repo', status: { type: 'notLoaded' } });
  client.statusValue = { type: 'notLoaded' };
  const f = fixture({ client, threadId: 'desktop' });
  await f.host.connect();
  await assert.rejects(f.host.ensureThread(), /not loaded in Conductor's shared Codex daemon/);
  assert.equal(client.calls.some(x => x[0] === 'resumeThread'), false);
  assert.equal(client.calls.some(x => x[0] === 'startThread'), false);
  assert.equal(f.state.threadId, 'desktop');
});

test('resumes a notLoaded thread with a saved shared-daemon ownership marker', async () => {
  const client = new FakeCodex();
  client.threads.push({ id: 'conductor', name: 'Conductor: owner/repo', cwd: 'C:\\repo', status: { type: 'notLoaded' } });
  client.statusValue = { type: 'notLoaded' };
  const f = fixture({ client, threadId: 'conductor' });
  f.state.threadHostOwnership = { threadId: 'conductor', host: 'codex-app-server-daemon', codexHome: f.host.codexHome, kind: 'created' };
  await f.host.connect();
  assert.equal(await f.host.ensureThread(), 'conductor');
  assert.equal(client.calls.some(x => x[0] === 'resumeThread'), true);
  assert.equal(f.host.currentStatus.type, 'idle');
});

test('binds an explicitly owned Desktop thread read-only without resume or creation', async () => {
  const f = desktopFixture();
  await f.host.connect();
  assert.equal(await f.host.ensureThread(), 'desktop-thread');
  assert.equal(f.client.calls.some(x => x[0] === 'readThread'), true);
  assert.equal(f.client.calls.some(x => x[0] === 'listQueuedMessages'), true);
  assert.equal(f.client.calls.some(x => ['resumeThread', 'startThread', 'listThreads'].includes(x[0])), false);
  assert.equal(f.state.threadId, 'desktop-thread');
  f.client.emit('notification', { method: 'turn/completed', params: { threadId: 'desktop-thread', turn: { id: 'daemon-false-positive' } } });
  assert.notEqual(f.host.currentStatus.type, 'idle');
});

test('fails closed for an unbound Desktop host and for a mismatched repository cwd', async () => {
  assert.throws(() => fixture({ state: { threadId: null, threadHostOwnership: { host: 'codex-desktop' } }, host: 'codex-desktop' }), /explicit codex-desktop thread ownership receipt/);

  const f = desktopFixture();
  f.client.readThread = async () => ({ id: 'desktop-thread', cwd: 'C:\\other-repo', status: { type: 'notLoaded' } });
  await f.host.connect();
  await assert.rejects(f.host.ensureThread(), /belongs to C:\\other-repo/);
  assert.equal(f.client.calls.some(x => ['resumeThread', 'startThread'].includes(x[0])), false);
});

test('Desktop queue sends a stable marker and skill invocation only when activity says idle', async () => {
  const f = desktopFixture();
  await f.host.connect();
  await f.host.ensureThread();
  f.setActivity('active');
  await assert.rejects(f.host.startRunner({ prompt: 'Reconcile events', revision: 'batch-a' }), error => error.code === 'DIRECTOR_BUSY');
  assert.equal(f.client.calls.some(x => x[0] === 'addQueuedMessage'), false);

  f.setActivity('idle');
  const queued = await f.host.startRunner({ prompt: 'Reconcile events', revision: 'batch-a' });
  assert.deepEqual(queued, { queued: true, id: 'queue-1', clientMessageId: 'conductor-director-batch-a', marker: '<!-- conductor:director-wakeup:batch-a -->' });
  const request = f.client.calls.find(x => x[0] === 'addQueuedMessage')[1];
  assert.equal(request.threadId, 'desktop-thread');
  assert.equal(request.clientUserMessageId, 'conductor-director-batch-a');
  assert.match(request.text, /^\$conductor:director\n\n/);
  assert.match(request.text, /<!-- conductor:director-wakeup:batch-a -->/);
  assert.equal(f.client.calls.some(x => x[0] === 'startTurn'), false);
  assert.equal((await f.host.findQueuedWakeup(queued.marker)).id, 'queue-1');
  assert.equal(await f.host.cancelQueuedWakeup(queued.id), true);
  assert.equal(await f.host.cancelQueuedWakeup(queued.id), false);
  assert.equal(f.client.calls.some(x => x[0] === 'deleteQueuedMessage' && x[1].threadId === 'desktop-thread'), true);
});

test('Desktop activity unknown and interrupted states do not queue input', async () => {
  const f = desktopFixture({ activity: { read: async () => ({ state: 'idle', nativeTurnId: 'native-turn-5', wakeupMarker: '<!-- marker -->' }) } });
  await f.host.connect();
  await f.host.ensureThread();
  const observed = await f.host.status();
  assert.equal(observed.type, 'idle');
  assert.equal(observed.nativeTurnId, 'native-turn-5');
  assert.equal(observed.wakeupMarker, '<!-- marker -->');

  f.host.activity = { read: async () => ({ state: 'unknown' }) };
  assert.equal((await f.host.status()).type, 'unknown');
  await assert.rejects(f.host.startRunner({ prompt: 'x', revision: 'batch-b' }), error => error.code === 'DIRECTOR_UNAVAILABLE');
  assert.equal(f.client.calls.some(x => x[0] === 'addQueuedMessage'), false);

  f.host.activity = { read: async () => ({ state: 'interrupted' }) };
  await assert.rejects(f.host.startRunner({ prompt: 'x', revision: 'batch-c' }), error => error.code === 'DIRECTOR_BUSY');
  assert.equal(f.client.calls.some(x => x[0] === 'addQueuedMessage'), false);
});
