import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDirectorConfig, loadConfig } from '../plugins/conductor/lib/config.mjs';
import { Store, prepareServiceLog } from '../plugins/conductor/lib/state.mjs';
import { applyMigration, previewMigration } from '../plugins/conductor/lib/migration.mjs';
import { parseArgs } from '../plugins/conductor/bin/conductor.mjs';

const config = overrides => ({ version: 2, repository: 'example/project', baseBranch: 'main', authorized: true, checks: [{ command: 'node', args: ['--version'] }], ...overrides });

test('director config has stable defaults and rejects colliding workflow labels', () => {
  const valid = validateDirectorConfig(config());
  assert.equal(valid.pollMs, 30 * 60_000);
  assert.equal(valid.directorModel, 'gpt-6.1-sol');
  assert.equal(valid.plannerModel, 'gpt-6-astra');
  assert.equal(valid.labels.ready, 'ready');
  assert.throws(() => validateDirectorConfig(config({ labels: { triage: 'READY' } })), /must be distinct/);
  assert.throws(() => validateDirectorConfig(config({ labels: { hold: false } })), /nonempty string/);
});

test('loadConfig refuses a legacy execution config until explicit migration', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-config-v1-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'conductor.json'), JSON.stringify({ ...config(), version: undefined, readyLabel: 'conductor:ready' }));
  await assert.rejects(() => loadConfig(dir), /conductor migrate/);
});

test('migration requires an explicit state and the exact preview revision for every issue', async () => {
  const issue = { number: 7, title: 'Bug', body: 'details', state: 'open', labels: [{ name: 'conductor:ready' }], updated_at: 'rev-a' };
  const records = previewMigration([issue]);
  assert.deepEqual(records.map(item => [item.number, item.proposedState, item.needsExplicitReview]), [[7, 'ready', false]]);
  const changes = [];
  const github = { issue: async () => issue, gh: async () => '', setWorkflowState: async (...args) => { changes.push(args); return { number: args[0] }; } };
  await assert.rejects(() => applyMigration(github, records, {}), /Explicit classifications/);
  await assert.rejects(() => applyMigration(github, records, { 7: { state: 'ready', revision: 'stale' } }), /exact preview revision/);
  await applyMigration(github, records, { 7: { state: 'ready', revision: 'rev-a' } });
  assert.deepEqual(changes[0].slice(0, 2), [7, 'ready']);
});

test('recovery retains an admission pause and active jobs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-controls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  await store.initialize();
  await store.save({ version: 1, admissionPaused: true, jobs: [{ issue: 9, phase: 'building', threadId: 'original' }] });
  const restored = await store.read();
  assert.equal(restored.admissionPaused, true);
  assert.equal(restored.jobs[0].threadId, 'original');
});

test('control requests are idempotent after acknowledgement and do not replay after restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-request-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = new Store(dir); await first.acquire();
  const payload = { op: 'signal', repository: 'example/project', threadId: 'director-thread' };
  const request = await first.sendRequest(payload);
  assert.match(request.id, /^v1\./);
  assert.equal(Date.parse(request.retryExpiresAt) - Date.now() <= 7 * 24 * 60 * 60_000, true);
  assert.equal((await first.drain()).length, 1);
  await first.acknowledge(request, null, { signaled: true });
  const duplicate = await first.sendRequest({ ...payload, id: request.id });
  assert.equal(duplicate.completed, true);
  assert.equal((await first.drain()).length, 0);
  await assert.rejects(() => first.sendRequest({ ...payload, id: request.id, op: 'stop' }), /different completed operation/);
  await first.release();
});

test('control IDs are rejected when they could escape the local receipt directory', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-control-path-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir); await store.acquire();
  await assert.rejects(() => store.sendRequest({ id: '../escape', op: 'signal' }), /versioned Conductor retry handle/);
  await store.release();
});

test('known legacy control receipts and pending requests remain readable within their original window', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-legacy-controls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir); await store.acquire();
  await mkdir(join(store.dir, 'control-results'), { recursive: true });
  const oldReceipt = { id: '7f8a09c1-d5b7-4f01-84f2-71cf2e7524d8', op: 'wakeup', repository: 'example/project', threadId: 'director-thread', at: new Date().toISOString(), completedAt: new Date().toISOString(), result: { ok: true } };
  await writeFile(join(store.dir, 'control-results', `${oldReceipt.id}.json`), JSON.stringify(oldReceipt));
  assert.equal((await store.sendRequest({ id: oldReceipt.id, op: 'wakeup', repository: 'example/project', threadId: 'director-thread' })).completed, true);
  const pending = { id: '7f8a09c1-d5b7-4f01-84f2-71cf2e7524d9', op: 'wakeup', repository: 'example/project', threadId: 'director-thread', owner: store.token, at: new Date().toISOString() };
  await writeFile(join(store.controls, `${pending.id}.json`), JSON.stringify(pending));
  assert.equal((await store.sendRequest({ id: pending.id, op: pending.op, repository: pending.repository, threadId: pending.threadId })).owner, store.token);
  assert.deepEqual(await store.drain(), []);
  assert.match((await store.results())[0].error, /Legacy control request/);
  await assert.rejects(() => store.sendRequest({ id: '7f8a09c1-d5b7-4f01-84f2-71cf2e7524da', op: 'wakeup' }), /Unknown legacy/);
  await store.release();
});

test('cleanup rejects unknown options without running a mutating command', () => {
  assert.throws(() => parseArgs(['cleanup', '--bogus']), /cleanup accepts only/);
  assert.throws(() => parseArgs(['cleanup', '--preview', 'extra']), /cleanup accepts only/);
  assert.equal(parseArgs(['cleanup', '--preview']).preview, true);
});

test('recovery records stale-owner requests without returning them for execution', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-stale-control-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = new Store(dir); await previous.acquire();
  await previous.sendRequest({ op: 'stop', repository: 'example/project', threadId: 'director-thread' });
  await previous.release();
  const resumed = new Store(dir); await resumed.acquire();
  assert.deepEqual(await resumed.drain(), []);
  const receipts = await resumed.results();
  assert.match(receipts[0].error, /previous Conductor owner/);
  await resumed.release();
});

test('expired retry handles remain rejected after receipt cleanup', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-expired-retry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir); await store.acquire();
  const id = await store.issueRetryId(Date.now() - 8 * 24 * 60 * 60_000);
  await assert.rejects(() => store.validateRetryId(id), /expired/);
  await assert.rejects(() => store.sendRequest({ id, op: 'stop' }), /expired/);
  await assert.rejects(() => store.sendRequest({ id: '7f8a09c1-d5b7-4f01-84f2-71cf2e7524d8', op: 'stop' }), /Unknown legacy/);
  await store.release();
});

test('cleanup preview is read-only and stopped cleanup deletes only expired owned receipts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-cleanup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir); await store.acquire();
  const request = await store.sendRequest({ op: 'signal', repository: 'example/project', threadId: 'director-thread' });
  await store.acknowledge(request, null, { signaled: true });
  const receipt = join(store.dir, 'control-results', `${request.id}.json`);
  const expiredId = await store.issueRetryId(Date.now() - 8 * 24 * 60 * 60_000);
  const expiredReceipt = join(store.dir, 'control-results', `${expiredId}.json`);
  await writeFile(expiredReceipt, JSON.stringify({ id: expiredId, completedAt: new Date().toISOString(), retryExpiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() }));
  assert.equal((await store.previewCleanup()).candidates.length, 1);
  await assert.rejects(() => store.cleanupStopped(), /running or owned/);
  await store.release();
  const result = await store.cleanupStopped();
  assert.equal(result.removed.length, 1);
  await assert.rejects(() => readFile(expiredReceipt), { code: 'ENOENT' });
  assert.equal(await readFile(receipt, 'utf8').then(Boolean), true);
  await assert.rejects(() => store.validateRetryId(expiredId), /expired/);
  await store.acquire();
  await assert.rejects(() => store.sendRequest({ id: expiredId, op: 'signal' }), /expired/);
  await store.release();
});

test('cleanup derives receipt expiry from the immutable request handle, not mutable receipt metadata', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-cleanup-expiry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir); await store.acquire();
  const request = await store.sendRequest({ op: 'signal' });
  await store.acknowledge(request);
  const receipt = join(store.dir, 'control-results', `${request.id}.json`);
  const value = JSON.parse(await readFile(receipt, 'utf8'));
  value.retryExpiresAt = new Date(0).toISOString();
  await writeFile(receipt, JSON.stringify(value));
  assert.equal((await store.previewCleanup()).candidates.length, 0);
  assert.equal((await store.previewCleanup(Date.parse(request.retryExpiresAt) + 1)).candidates.length, 1);
  await store.release();
});

test('service log rotation bounds size, number of copies and age', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-log-retention-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'service.log');
  await writeFile(path, Buffer.alloc(5 * 1024 * 1024));
  await prepareServiceLog(path);
  assert.equal((await readdir(dir)).sort().join(','), 'service.log.1');
  await writeFile(path, 'current');
  await writeFile(`${path}.1`, 'older');
  await writeFile(`${path}.2`, 'oldest');
  await prepareServiceLog(path, Date.now() + 8 * 24 * 60 * 60_000);
  assert.deepEqual((await readdir(dir)).sort(), ['service.log']);
});

test('migration backups expire only after validated v2 configuration is loaded', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-migration-backup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, '.git')); await store.acquire();
  await writeFile(join(dir, 'conductor.json'), JSON.stringify({ version: 2, repository: 'example/project' }));
  const name = 'conductor.json.legacy-2026-10-01T12-30-15.000Z.bak';
  const path = join(dir, name); await writeFile(path, 'legacy config');
  assert.equal((await store.previewMigrationBackups(dir, Date.now(), false)).retained.length, 1);
  assert.equal((await store.cleanupMigrationBackups(dir, Date.now(), false)).removed.length, 0);
  const cleaned = await store.cleanupMigrationBackups(dir, Date.parse('2026-10-09T00:00:00.000Z'), true);
  assert.equal(cleaned.removed.length, 1);
  await assert.rejects(() => readFile(path), { code: 'ENOENT' });
  await store.release();
});
