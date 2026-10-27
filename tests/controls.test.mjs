import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDirectorConfig, loadConfig } from '../plugins/conductor/lib/config.mjs';
import { Store } from '../plugins/conductor/lib/state.mjs';
import { applyMigration, previewMigration } from '../plugins/conductor/lib/migration.mjs';

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
  const payload = { id: '7f8a09c1-d5b7-4f01-84f2-71cf2e7524d8', op: 'signal', repository: 'example/project', threadId: 'director-thread' };
  const request = await first.sendRequest(payload);
  assert.equal((await first.drain()).length, 1);
  await first.acknowledge(request, null, { signaled: true });
  const duplicate = await first.sendRequest(payload);
  assert.equal(duplicate.completed, true);
  assert.equal((await first.drain()).length, 0);
  await assert.rejects(() => first.sendRequest({ ...payload, op: 'stop' }), /different completed operation/);
  await first.release();
});

test('control IDs are rejected when they could escape the local receipt directory', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-control-path-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir); await store.acquire();
  await assert.rejects(() => store.sendRequest({ id: '../escape', op: 'signal' }), /must be a UUID/);
  await store.release();
});

test('recovery records stale-owner requests without returning them for execution', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-stale-control-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = new Store(dir); await previous.acquire();
  await previous.sendRequest({ id: '7f8a09c1-d5b7-4f01-84f2-71cf2e7524d8', op: 'stop', repository: 'example/project', threadId: 'director-thread' });
  await previous.release();
  const resumed = new Store(dir); await resumed.acquire();
  assert.deepEqual(await resumed.drain(), []);
  const receipts = await resumed.results();
  assert.match(receipts[0].error, /previous Conductor owner/);
  await resumed.release();
});
