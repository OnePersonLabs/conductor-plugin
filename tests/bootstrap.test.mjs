import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readdir, readFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { Store, atomicJSON } from '../plugins/conductor/lib/state.mjs';
import { ensureService, runnerEnabled, signalIfEnabled } from '../plugins/conductor/lib/bootstrap.mjs';
import { parseArgs } from '../plugins/conductor/bin/conductor.mjs';

const THREAD = '710b9ed9-7291-49a1-9030-3bdcc9d3c640';

async function fixture(t, state = {}) {
  const base = await mkdtemp(join(tmpdir(), 'conductor-bootstrap-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const store = new Store(join(base, '.git'));
  await mkdir(store.dir, { recursive: true });
  await atomicJSON(join(store.dir, 'state.json'), { version: 1, jobs: [], director: { threadId: null, enabled: false }, ...state });
  return { base, store };
}

test('passive signal does not start an explicitly disabled repository', async t => {
  const { base, store } = await fixture(t, { runtimeEnabled: false, director: { threadId: THREAD, enabled: true } });
  let launches = 0;
  const result = await signalIfEnabled({ store, root: base, cliPath: 'conductor.mjs', execute: async () => {
    launches++;
    await atomicJSON(store.lockPath, { token: 'live', pid: process.pid, hostname: hostname(), platform: process.platform });
    await atomicJSON(join(store.dir, 'state.json'), { version: 1, jobs: [], ownerToken: 'live', serviceReady: true, director: { threadId: THREAD, enabled: true } });
    return { unref() {} };
  } });
  assert.equal(result.status, 'disabled');
  assert.equal(launches, 0);
});

test('a deliberate stop ignores passive signals but permits explicit observation wakeup', async t => {
  const { base, store } = await fixture(t, { runtimeEnabled: true, admissionPaused: true, director: { threadId: THREAD, enabled: false } });
  let launches = 0;
  const passive = await signalIfEnabled({ store, root: base, cliPath: 'conductor.mjs', execute: async () => { launches++; return { unref() {} }; } });
  assert.equal(passive.status, 'stopped');
  assert.equal(launches, 0);
  const explicit = await ensureService({ store, root: base, manualWake: true, cliPath: 'conductor.mjs', timeoutMs: 500, execute: async () => {
    launches++;
    await atomicJSON(store.lockPath, { token: 'live', pid: process.pid, hostname: hostname(), platform: process.platform });
    await atomicJSON(join(store.dir, 'state.json'), { version: 1, jobs: [], runtimeEnabled: true, admissionPaused: true, ownerToken: 'live', serviceReady: true, director: { threadId: THREAD, enabled: true } });
    return { unref() {} };
  } });
  assert.equal(explicit.status, 'started');
  assert.equal(launches, 1);
});

test('passive signal recognizes a saved enabled binding', async t => {
  const { base, store } = await fixture(t, { director: { threadId: THREAD, enabled: true } });
  let launches = 0;
  const result = await signalIfEnabled({ store, root: base, cliPath: 'conductor.mjs', execute: async () => {
    launches++;
    await atomicJSON(store.lockPath, { token: 'live', pid: process.pid, hostname: hostname(), platform: process.platform });
    await atomicJSON(join(store.dir, 'state.json'), { version: 1, jobs: [], ownerToken: 'live', serviceReady: true, director: { threadId: THREAD, enabled: true } });
    return { unref() {} };
  } });
  assert.equal(result.status, 'started');
  assert.equal(launches, 1);
  assert.equal(await runnerEnabled(store), true);
});

test('an enabled repository reuses the live owner and makes one wake request', async t => {
  const { base, store } = await fixture(t, { runtimeEnabled: true, director: { threadId: THREAD, enabled: true } });
  await atomicJSON(store.lockPath, { token: 'live', pid: process.pid, hostname: (await import('node:os')).hostname(), platform: process.platform });
  const result = await ensureService({ store, root: base, manualWake: true, cliPath: 'conductor.mjs', execute: async () => { throw new Error('should not launch'); } });
  assert.equal(result.status, 'wake-requested');
  const commands = (await readdir(store.controls)).filter(x => x.endsWith('.json'));
  assert.equal(commands.length, 1);
  assert.equal(JSON.parse(await readFile(join(store.controls, commands[0]), 'utf8')).op, 'wakeup');
});

test('enable starts a threadless service and waits for owned readiness', async t => {
  const { base, store } = await fixture(t);
  let argv;
  const result = await ensureService({ store, root: base, enable: true, manualWake: true, cliPath: 'conductor.mjs', timeoutMs: 500,
    execute: async (_command, args) => {
      argv = args;
      await atomicJSON(store.lockPath, { token: 'live', pid: process.pid, hostname: (await import('node:os')).hostname(), platform: process.platform });
      await atomicJSON(join(store.dir, 'state.json'), { version: 1, jobs: [], runtimeEnabled: true, ownerToken: 'live', serviceReady: true, director: { threadId: THREAD, enabled: true } });
      return { unref() {} };
    } });
  assert.deepEqual(argv.slice(1), ['serve', '--enable', '--manual-wake']);
  assert.equal(result.status, 'started');
  assert.equal(result.threadId, THREAD);
});

test('CLI accepts lifecycle commands and preserves explicit existing binding syntax', () => {
  assert.deepEqual(parseArgs(['enable']), { command: 'enable', overrides: {} });
  assert.deepEqual(parseArgs(['wakeup']), { command: 'wakeup', overrides: {} });
  assert.deepEqual(parseArgs(['enable', '--host', 'desktop', '--thread', THREAD]), { command: 'enable', overrides: {}, host: 'desktop', threadId: THREAD });
  assert.deepEqual(parseArgs(['attach', '--host', 'desktop', '--thread', THREAD]), { command: 'attach', overrides: {}, host: 'desktop', threadId: THREAD });
  assert.deepEqual(parseArgs(['serve', '--handoff-thread', THREAD, '--host', 'desktop', '--enable']), { command: 'serve', overrides: {}, handoffThreadId: THREAD, host: 'desktop', enable: true });
  assert.throws(() => parseArgs(['attach', '--host', 'daemon', '--thread', THREAD]), /requires --host desktop/);
  assert.throws(() => parseArgs(['enable', '--host', 'desktop']), /requires --thread/);
  assert.throws(() => parseArgs(['enable', '--host', 'remote']), /desktop or daemon/);
  assert.deepEqual(parseArgs(['serve', '--enable', '--manual-wake']), { command: 'serve', overrides: {}, enable: true, manualWake: true });
  assert.deepEqual(parseArgs(['serve', '--host', 'daemon']), { command: 'serve', overrides: {}, host: 'daemon' });
  assert.equal(parseArgs(['start', '--thread', THREAD]).threadId, THREAD);
});

test('attach refuses an old live service before enqueueing an unsupported control', async t => {
  const { base, store } = await fixture(t, { runtimeEnabled: true, repository: 'owner/repo', director: { threadId: THREAD, enabled: true } });
  await atomicJSON(store.lockPath, { token: 'live', pid: process.pid, hostname: hostname(), platform: process.platform });
  await assert.rejects(ensureService({ store, root: base, attachThreadId: '019c6e27-e55b-73d1-87d8-4e01f1f75044', host: 'desktop', cliPath: 'conductor.mjs' }), /does not support chat handoff/);
  assert.equal((await readdir(store.controls)).filter(x => x.endsWith('.json')).length, 0);
});

test('attach reuses a capable live service through one native control request', async t => {
  const target = '019c6e27-e55b-73d1-87d8-4e01f1f75044';
  const { base, store } = await fixture(t, { runtimeEnabled: true, repository: 'owner/repo', director: { threadId: THREAD, enabled: true, attachProtocol: 1 } });
  await atomicJSON(store.lockPath, { token: 'live', pid: process.pid, hostname: hostname(), platform: process.platform });
  const sendRequest = store.sendRequest.bind(store);
  store.sendRequest = async input => {
    const request = await sendRequest(input);
    await mkdir(join(store.dir, 'control-results'), { recursive: true });
    await atomicJSON(join(store.dir, 'control-results', `${request.id}.json`), { ...request, completedAt: new Date().toISOString(), error: null, result: { status: 'handoff-pending', fromThreadId: THREAD, toThreadId: target, turnId: 'native-turn', blocker: 'Waiting for its terminal receipt.' } });
    return request;
  };
  const result = await ensureService({ store, root: base, attachThreadId: target, host: 'desktop', cliPath: 'conductor.mjs', timeoutMs: 500 });
  assert.equal(result.status, 'handoff-pending');
  assert.equal(result.turnId, 'native-turn');
  assert.equal(result.blocker, 'Waiting for its terminal receipt.');
  const files = (await readdir(store.controls)).filter(x => x.endsWith('.json'));
  assert.equal(files.length, 1);
  const request = JSON.parse(await readFile(join(store.controls, files[0]), 'utf8'));
  assert.equal(request.op, 'attach');
  assert.equal(request.threadId, THREAD);
  assert.equal(request.targetThreadId, target);
});

test('attach restart launches against the saved director and returns pending native blocker', async t => {
  const target = '019c6e27-e55b-73d1-87d8-4e01f1f75044';
  const { base, store } = await fixture(t, { runtimeEnabled: true, repository: 'owner/repo', director: { threadId: THREAD, enabled: true, threadHostOwnership: { threadId: THREAD, host: 'codex-desktop' } } });
  let argv;
  const result = await ensureService({ store, root: base, attachThreadId: target, host: 'desktop', cliPath: 'conductor.mjs', timeoutMs: 500, execute: async (_command, args) => {
    argv = args;
    await atomicJSON(store.lockPath, { token: 'live', pid: process.pid, hostname: hostname(), platform: process.platform });
    await atomicJSON(join(store.dir, 'state.json'), { version: 1, jobs: [], runtimeEnabled: true, ownerToken: 'live', serviceReady: true, director: { threadId: THREAD, enabled: true, attachProtocol: 1, nativeActivity: { state: 'active' }, handoff: { fromThreadId: THREAD, toThreadId: target, turnId: 'turn-1', status: 'waiting-turn', blocker: 'Waiting for the current native turn to end.' } } });
    return { unref() {} };
  } });
  assert.deepEqual(argv.slice(1), ['serve', '--handoff-thread', target, '--host', 'desktop', '--enable']);
  assert.equal(result.status, 'handoff-pending');
  assert.match(result.blocker, /current native turn/);
  assert.equal(result.threadId, undefined, 'a pending transfer must not claim the destination binding');
});

test('attach startup never reports ready as attached before the requested binding is persisted', async t => {
  const target = '019c6e27-e55b-73d1-87d8-4e01f1f75044';
  const { base, store } = await fixture(t, { runtimeEnabled: true, repository: 'owner/repo', director: { threadId: THREAD, enabled: true } });
  await assert.rejects(ensureService({ store, root: base, attachThreadId: target, host: 'desktop', cliPath: 'conductor.mjs', timeoutMs: 500,
    execute: async () => {
      await atomicJSON(store.lockPath, { token: 'live', pid: process.pid, hostname: hostname(), platform: process.platform });
      await atomicJSON(join(store.dir, 'state.json'), { version: 1, jobs: [], runtimeEnabled: true, ownerToken: 'live', serviceReady: true, director: { threadId: THREAD, enabled: true, attachProtocol: 1 } });
      return { unref() {} };
    } }), /ready without binding/);
});

test('host selection passes through to owned service startup', async t => {
  const { base, store } = await fixture(t);
  let argv;
  const result = await ensureService({ store, root: base, enable: true, manualWake: true, host: 'desktop', threadId: THREAD,
    cliPath: 'conductor.mjs', timeoutMs: 500, execute: async (_command, args) => {
      argv = args;
      await atomicJSON(store.lockPath, { token: 'live', pid: process.pid, hostname: hostname(), platform: process.platform });
      await atomicJSON(join(store.dir, 'state.json'), { version: 1, jobs: [], runtimeEnabled: true, ownerToken: 'live', serviceReady: true, director: { threadId: THREAD, enabled: true }, threadHostOwnership: { threadId: THREAD, host: 'codex-desktop' } });
      return { unref() {} };
    } });
  assert.equal(result.status, 'started');
  assert.deepEqual(argv.slice(1), ['serve', '--thread', THREAD, '--host', 'desktop', '--enable', '--manual-wake']);
});

test('explicit host changes are rejected for an already bound director', async t => {
  const { base, store } = await fixture(t, { runtimeEnabled: true, director: { threadId: THREAD, enabled: true }, threadHostOwnership: { threadId: THREAD, host: 'codex-desktop' } });
  await assert.rejects(ensureService({ store, root: base, enable: true, host: 'daemon', threadId: THREAD,
    cliPath: 'conductor.mjs', execute: async () => { throw new Error('must reject before launch'); } }), /owned by codex-desktop/);
});

test('Desktop attach refuses to move a daemon-owned director between hosts', async t => {
  const { base, store } = await fixture(t, { runtimeEnabled: true, director: { threadId: THREAD, enabled: true, threadHostOwnership: { threadId: THREAD, host: 'codex-app-server-daemon' } } });
  await assert.rejects(ensureService({ store, root: base, attachThreadId: '019c6e27-e55b-73d1-87d8-4e01f1f75044', host: 'desktop', cliPath: 'conductor.mjs', execute: async () => { throw new Error('must reject before launch'); } }), /requires the Desktop native queue/);
});

test('simultaneous enable requests converge on one ready service', async t => {
  const { base, store } = await fixture(t);
  let launches = 0;
  const options = { store, root: base, enable: true, manualWake: true, cliPath: 'conductor.mjs', timeoutMs: 1000,
    execute: async () => {
      launches++;
      await new Promise(resolve => setTimeout(resolve, 20));
      await atomicJSON(store.lockPath, { token: 'live', pid: process.pid, hostname: hostname(), platform: process.platform });
      await atomicJSON(join(store.dir, 'state.json'), { version: 1, jobs: [], repository: 'owner/repo', runtimeEnabled: true, ownerToken: 'live', serviceReady: true, director: { threadId: THREAD, enabled: true } });
      return { unref() {} };
    } };
  const results = await Promise.all([ensureService(options), ensureService(options)]);
  assert.equal(launches, 1);
  assert.deepEqual(results.map(result => result.status).sort(), ['enable-requested','started']);
  assert.ok(results.every(result => result.threadId === THREAD));
});
