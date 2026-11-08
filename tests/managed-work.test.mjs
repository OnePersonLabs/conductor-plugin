import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { ManagedWork, runManagedBridge } from '../plugins/conductor/lib/managed-work.mjs';
import { ManagedState } from '../plugins/conductor/lib/managed-state.mjs';
import { parseArgs } from '../plugins/conductor/bin/conductor.mjs';

class MemoryStore {
  constructor(state = {}) {
    this.value = { version: 1, sessionId: 'test', cwd: process.cwd(), commonDir: process.cwd(), threadId: null, hasWork: false, settings: null, lastTurn: null, activeTurn: null, operation: null, requests: [], needsReconcile: false, ...state };
  }
  async acquire() { return structuredClone(this.value); }
  async save(value) { this.value = structuredClone(value); }
  async release(value) { this.released = value; }
}
class Client extends EventEmitter {
  constructor() { super(); this.pendingRequests = []; this.calls = []; this.settings = { mode: 'plan', model: 'small', effort: 'low' }; this.turns = []; }
  async connect() { this.connected = true; this.pid = 123; }
  async close() { this.connected = false; this._exit = { code: 0 }; }
  notice(method, params) { this.emit('notification', { method, params: { threadId: 'owned', ...params } }); }
  async startThread(options) { this.calls.push(['start', options]); return { id: 'owned' }; }
  async resumeThread(options) { this.calls.push(['resume', options]); return { thread: { id: 'owned' }, model: this.settings.model, reasoningEffort: this.settings.effort, collaborationMode: { mode: this.settings.mode } }; }
  async readThread() { this.calls.push(['read']); return { id: 'owned', status: { type: 'idle' }, turns: structuredClone(this.turns) }; }
  async listModels() { return ['small', 'large'].map(id => ({ id, supportedReasoningEfforts: ['low', 'high'].map(reasoningEffort => ({ reasoningEffort })) })); }
  async updateThreadSettings(options) {
    this.calls.push(['settings', options]);
    this.settings = { mode: options.mode, model: options.model, effort: this.wrongSettings ? 'low' : options.effort };
    this.notice('thread/settings/updated', { threadSettings: { ...this.settings, collaborationMode: { mode: this.settings.mode } } });
  }
  async startTurn(options) {
    this.calls.push(['turn', options]);
    const turn = { id: `turn-${this.turns.length + 1}`, status: 'inProgress' }; this.turns.push(turn);
    this.notice('turn/started', { turn }); return turn;
  }
  finish(id, status = 'completed') {
    const turn = this.turns.find(turn => turn.id === id); turn.status = status;
    this.pendingRequests = this.pendingRequests.filter(request => request.params.turnId !== id);
    this.notice('turn/completed', { turn });
  }
  ask(turnId) {
    const request = { id: 0, method: 'item/tool/requestUserInput', params: { threadId: 'owned', turnId, itemId: 'question', questions: [{ id: 'color', question: 'Which color?' }] } };
    this.pendingRequests.push(request); this.emit('request', request);
  }
  async respond(id, response) { this.calls.push(['respond', id, response]); this.pendingRequests = this.pendingRequests.filter(request => request.id !== id); }
  async interrupt({ turnId }) { this.calls.push(['interrupt', turnId]); this.finish(turnId, 'interrupted'); }
  async compactThread() {
    this.calls.push(['compact']);
    const turn = { id: `compact-${this.turns.length + 1}`, status: 'inProgress' }; this.turns.push(turn);
    this.notice('turn/started', { turn });
    this.notice('item/started', { turnId: turn.id, item: { id: 'compact-item', type: 'contextCompaction' } });
    if (!this.missingCompactItem) this.notice('item/completed', { turnId: turn.id, item: { id: 'compact-item', type: 'contextCompaction' } });
    this.finish(turn.id, this.failedCompact ? 'failed' : 'completed');
  }
}
async function fixture(t, state) {
  const client = new Client(), store = new MemoryStore(state), managed = new ManagedWork({ client, store });
  await managed.open(); t.after(async () => { if (!managed.closing) await managed.shutdown(); });
  return { client, store, managed, command: (id, command, values) => managed.command({ id, command, ...values }) };
}
async function configured(f) {
  await f.command('start', 'start');
  await f.command('plan', 'configure', { mode: 'plan', model: 'small', effort: 'low' });
}
async function complete(f, id = 'work', status = 'completed') {
  const turn = await f.command(id, 'turn', { prompt: 'Do the bounded assignment.' });
  f.client.finish(turn.turnId, status); await f.managed.events; return turn.turnId;
}

test('one owned client answers a question, verifies compaction, changes native settings and continues', async t => {
  const f = await fixture(t); const events = []; f.managed.on('event', event => events.push(event));
  await configured(f);
  assert.deepEqual(f.client.calls[0], ['start', { cwd: process.cwd() }]); // tools and permissions inherit
  assert.equal(f.client.calls.some(([name]) => name === 'compact'), false);
  const first = await f.command('work', 'turn', { prompt: 'Ask a question and plan.' });
  f.client.ask(first.turnId); await f.managed.events;
  assert.equal(events.find(event => event.event === 'request').request.id, 0);
  await assert.rejects(f.command('blocked-config', 'configure', { mode: 'default', model: 'large', effort: 'high' }), /pending/);
  const answer = { answers: { color: { answers: ['Blue'] } } };
  assert.deepEqual(await f.command('answer', 'respond', { requestId: 0, response: answer }), { requestId: 0, written: true, consumed: false, success: false });
  assert.equal(f.store.value.requests[0].status, 'sent');
  assert.equal(JSON.stringify(f.store.value).includes('Blue'), false);
  await assert.rejects(f.command('duplicate-answer', 'respond', { requestId: 0, response: answer }), /No unanswered/);
  f.client.notice('item/completed', { turnId: first.turnId, item: { id: 'question', type: 'toolCall' } });
  f.client.finish(first.turnId); await f.managed.events;
  await f.command('apply', 'configure', { mode: 'default', model: 'large', effort: 'high' });
  assert.deepEqual(f.client.calls.filter(([name]) => ['compact', 'settings'].includes(name)).map(([name]) => name), ['settings', 'compact', 'settings']);
  assert.deepEqual(f.managed.state.settings, { mode: 'default', model: 'large', effort: 'high' });
  await complete(f, 'apply-work');
  await f.command('close', 'close'); assert.deepEqual(f.store.released, { discard: true });
  assert.equal(f.client._exit.code, 0);
});

test('unsupported models and failed previous turns cannot buy compaction or change settings', async t => {
  const f = await fixture(t); await configured(f);
  await assert.rejects(f.command('unknown', 'configure', { mode: 'plan', model: 'missing', effort: 'high' }), /not advertised/);
  await complete(f, 'failed-work', 'failed');
  await assert.rejects(f.command('change', 'configure', { mode: 'default', model: 'large', effort: 'high' }), /successfully completed/);
  assert.equal(f.client.calls.some(([name]) => name === 'compact'), false);
});

for (const scenario of ['missingCompactItem', 'failedCompact', 'wrongSettings']) test(`configuration fails closed for ${scenario}`, async t => {
  const f = await fixture(t); await configured(f); await complete(f);
  f.client[scenario] = true;
  await assert.rejects(f.command('change', 'configure', { mode: 'default', model: 'large', effort: 'high' }), /Compaction|Applied host/);
  assert.equal(f.store.value.needsReconcile, true);
  if (scenario !== 'wrongSettings') assert.equal(f.client.calls.filter(([name]) => name === 'settings').length, 1);
  await assert.rejects(f.command('forbidden', 'turn', { prompt: 'Do not launch.' }), /reconciliation/);
});

test('a lost question answer is retained as uncertain and is never replayed on recovery', async t => {
  const first = await fixture(t); await configured(first);
  const turn = await first.command('work', 'turn', { prompt: 'Ask.' }); first.client.ask(turn.turnId); await first.managed.events;
  await first.command('answer', 'respond', { requestId: 0, response: { answers: { color: { answers: ['Blue'] } } } });
  first.client.emit('error', new Error('Transport lost')); await first.managed.events;
  assert.equal(first.store.value.needsReconcile, true); assert.equal(first.store.value.requests[0].status, 'sent');
  await first.managed.shutdown();
  const recovered = await fixture(t, first.store.value); recovered.client.turns = [{ id: turn.turnId, status: 'interrupted' }];
  await assert.rejects(recovered.command('premature', 'start'), /must be reconciled/);
  await recovered.command('inspect', 'reconcile'); await recovered.command('resume', 'start');
  assert.equal(recovered.client.calls.some(([name]) => name === 'start'), false);
  assert.equal(recovered.client.calls.some(([name]) => name === 'respond'), false);
  assert.deepEqual(recovered.managed.state.requests, []);
  await complete(recovered, 'repair'); // same verified settings; no model switch after interrupted work
});

test('uncertain submission needs an inspected terminal turn and never creates a second thread', async t => {
  const f = await fixture(t, { threadId: 'owned', needsReconcile: true, hasWork: false, operation: { kind: 'turn', commandId: 'lost', beforeTurnId: 'before' } });
  f.client.turns = [{ id: 'before', status: 'completed' }, { id: 'actual', status: 'completed' }];
  const preview = await f.command('inspect', 'reconcile'); assert.equal(preview.reconciled, false);
  await f.command('confirm', 'reconcile', { expectedTurnId: 'actual' }); await f.command('resume', 'start');
  assert.equal(f.managed.state.hasWork, true);
  assert.equal(f.client.calls.some(([name]) => name === 'start' || name === 'turn'), false);
  const unknown = await fixture(t, { needsReconcile: true, operation: { kind: 'start', commandId: 'lost-create' } });
  await assert.rejects(unknown.command('inspect', 'reconcile'), /unknown outcome/);
});

test('JSONL transport correlates control replies and EOF retains unfinished recovery', async t => {
  const f = await fixture(t); // runManagedBridge owns open/shutdown for the second wrapper
  const input = new PassThrough(), output = new PassThrough(), signals = new EventEmitter(); const lines = [];
  output.on('data', chunk => lines.push(...chunk.toString().trim().split('\n').map(line => JSON.parse(line))));
  const run = runManagedBridge({ managed: f.managed, input, output, signals });
  await new Promise(resolve => setImmediate(resolve));
  input.write('{"id":"start-jsonl","command":"start"}\n');
  await new Promise(resolve => setImmediate(resolve));
  input.write('{"id":"status","command":"status"}\n');
  await new Promise(resolve => setImmediate(resolve)); input.end(); await run;
  assert.ok(lines.some(line => line.id === 'status' && line.ok));
  assert.equal(f.store.value.needsReconcile, true); assert.deepEqual(f.store.released, { discard: false });
});

test('foreground JSONL consumer remains alive across question reply and phase transition', async t => {
  const f = await fixture(t), input = new PassThrough(), output = new PassThrough(), signals = new EventEmitter();
  const replies = new Map(); let buffer = '';
  output.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (message.id) { const resolve = replies.get(message.id); replies.delete(message.id); resolve?.(message); }
    }
  });
  const send = command => new Promise(resolve => { replies.set(command.id, resolve); input.write(JSON.stringify(command) + '\n'); });
  const run = runManagedBridge({ managed: f.managed, input, output, signals });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await send({ id: 's', command: 'start' })).ok, true);
  assert.equal((await send({ id: 'c', command: 'configure', mode: 'plan', model: 'small', effort: 'low' })).ok, true);
  const first = await send({ id: 'p', command: 'turn', prompt: 'Plan.' });
  f.client.ask(first.result.turnId); await f.managed.events;
  assert.equal((await send({ id: 'r', command: 'respond', requestId: 0, response: { answers: { color: { answers: ['Blue'] } } } })).ok, true);
  f.client.finish(first.result.turnId); await f.managed.events;
  assert.equal((await send({ id: 'next', command: 'configure', mode: 'default', model: 'large', effort: 'high' })).ok, true);
  assert.equal((await send({ id: 'end', command: 'close' })).ok, true);
  await run; assert.deepEqual(f.store.released, { discard: true });
});

test('Git-private session lock excludes another writer and preserves unresolved recovery', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-managed-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const commonDir = join(dir, 'git'); await mkdir(commonDir);
  const a = new ManagedState({ commonDir, cwd: dir, sessionId: 'one' }); const state = await a.acquire();
  const b = new ManagedState({ commonDir, cwd: dir, sessionId: 'one' }); await assert.rejects(b.acquire(), /writer owns/);
  state.threadId = 'owned'; await a.save(state); await a.release();
  const recovered = await b.acquire(); assert.equal(recovered.needsReconcile, true); assert.equal(recovered.threadId, 'owned');
  await b.release({ discard: true });
  await assert.rejects(readFile(b.path), /ENOENT/);
  // A dead bridge cannot adopt while its original App Server is still alive.
  await mkdir(a.dir, { recursive: true });
  await writeFile(a.path, JSON.stringify({ ...state, clientPid: process.pid }));
  await writeFile(a.lock, JSON.stringify({ token: 'old', pid: 9999999, hostname: hostname(), platform: process.platform }));
  await assert.rejects(a.acquire(), /App Server process is still alive/);
});

test('CLI parses explicit managed sessions and read-only scope checks', () => {
  assert.equal(parseArgs(['managed', '--session', 'phase-1']).sessionId, 'phase-1');
  assert.equal(parseArgs(['check-scope']).scope, 'local');
  assert.equal(parseArgs(['check-scope', 'issues']).scope, 'issues');
  assert.equal(parseArgs(['hold', '--request-file', 'hold.json']).requestFile, 'hold.json');
  assert.throws(() => parseArgs(['hold']), /requires --request-file/);
  assert.throws(() => parseArgs(['check-scope', 'all']), /only local/);
  assert.throws(() => parseArgs(['managed', '--session', '../escape']), /session ID/);
});
