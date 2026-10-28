import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../plugins/conductor/lib/state.mjs';
import { Coordinator } from '../plugins/conductor/lib/coordinator.mjs';

async function reader(t, path) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$f=[IO.File]::Open($env:CONDUCTOR_LOCK_TARGET,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [Console]::WriteLine("locked"); [Console]::ReadLine() | Out-Null; $f.Dispose()'],
  { env: { ...process.env, CONDUCTOR_LOCK_TARGET: path }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const [data] = await once(child.stdout, 'data');
  assert.match(data.toString(), /locked/);
  return child;
}

test('Windows sharing lock retries shutdown persistence, releases ownership, and recovers the same director', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-win-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  await store.acquire();
  const state = { version: 1, jobs: [], running: true, serviceReady: true, director: { threadId: 'saved-director', enabled: true } };
  await store.save(state);
  const path = join(store.dir, 'state.json');
  const child = await reader(t, path);
  const replacement = join(dir, 'replacement');
  await writeFile(replacement, '{}');
  await assert.rejects(rename(replacement, path), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
  const c = new Coordinator({ repo: { root: dir }, config: { repository: 'example/repo' }, store, github: {} });
  c.state = state;
  const stopped = once(c, 'stopped');
  const stopping = c.stop();
  assert.equal(JSON.parse(await readFile(path)).running, true);
  setTimeout(() => child.stdin.end('\n'), 150);
  await stopping;
  await stopped;
  assert.equal(await store.owner(), null);
  assert.equal((await store.read()).running, false);
  assert.equal((await store.read()).serviceReady, false);
  const recovered = new Store(dir);
  await recovered.acquire();
  assert.equal((await recovered.read()).director.threadId, 'saved-director');
  await recovered.release();
  await child.exited;
});

test('persistent Windows sharing lock preserves old state, reports failure, and permits retry after release', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-win-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  await store.acquire();
  const c = new Coordinator({ repo: { root: dir }, config: { repository: 'example/repo' }, store, github: {} });
  c.state = { version: 1, jobs: [], running: true, serviceReady: true, director: { threadId: 'original-director' } };
  await store.save(c.state);
  const statePath = join(store.dir, 'state.json');
  const child = await reader(t, statePath);
  await assert.rejects(c.stop(), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
  assert.equal((await store.read()).running, true);
  assert.ok(await store.owner());
  assert.equal((await readdir(store.dir)).some(name => name.endsWith('.tmp')), false);
  const exited = once(child, 'exit'); child.stdin.end('\n'); await exited;
  await c.stop();
  assert.equal((await store.read()).running, false);
  assert.equal((await store.read()).director.threadId, 'original-director');
  assert.equal(await store.owner(), null);
});
