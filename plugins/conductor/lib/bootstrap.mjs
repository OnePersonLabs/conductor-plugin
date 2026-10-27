import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { processExists } from './state.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readJSON(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function acquire(store, timeoutMs = 15_000) {
  await store.initialize();
  const path = join(store.dir, 'bootstrap.lock');
  const started = Date.now();
  while (true) {
    const lock = { pid: process.pid, hostname: hostname(), platform: process.platform, at: new Date().toISOString() };
    try { await writeFile(path, JSON.stringify(lock), { flag: 'wx', mode: 0o600 }); return async () => unlink(path).catch(() => {}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const current = await readJSON(path);
    if (current && current.hostname === hostname() && current.platform === process.platform && !processExists(current.pid)) {
      await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
      continue;
    }
    if (Date.now() - started >= timeoutMs) throw new Error('Another Conductor start is still being reconciled; inspect status and retry.');
    await delay(100);
  }
}

export async function runnerEnabled(store) {
  const state = await store.read();
  return state.runtimeEnabled === undefined
    ? Boolean(state.director?.threadId && state.director.enabled !== false)
    : state.runtimeEnabled === true;
}

export async function ensureService({ store, root, threadId, enable = false, manualWake = false,
  execute, cliPath, timeoutMs = 30_000 }) {
  let saved = await store.read();
  let enabled = await runnerEnabled(store);
  if (!enabled && !enable) return { status: 'disabled' };
  if (!enable && !manualWake && saved.director?.enabled === false) return { status: 'stopped', threadId: saved.director?.threadId ?? null };

  const release = await acquire(store, timeoutMs);
  try {
    const state = saved = await store.read();
    enabled = await runnerEnabled(store);
    if (!enabled && !enable) return { status: 'disabled', threadId: state.director?.threadId ?? null };
    if (!enable && !manualWake && state.director?.enabled === false) return { status: 'stopped', threadId: state.director?.threadId ?? null };
    if (threadId && state.director?.threadId && state.director.threadId !== threadId) {
      throw new Error(`Repository is bound to director thread ${state.director.threadId}; rebind explicitly before changing it.`);
    }
    const owner = await store.owner();
    const isLive = owner?.hostname === hostname() && owner.platform === process.platform && processExists(owner.pid);
    if (owner && isLive) {
      if (enable) {
        const request = await store.sendRequest({ op: 'enable', repository: state.repository, threadId: state.director?.threadId });
        return { status: 'enable-requested', threadId: state.director?.threadId ?? null, requestId: request.id, pid: owner.pid };
      }
      if (!manualWake) return { status: 'already-running', threadId: state.director?.threadId ?? null, pid: owner.pid };
      if (!enabled) return { status: 'disabled', threadId: state.director?.threadId ?? null };
      const request = await store.sendRequest({ op: 'wakeup', repository: state.repository, threadId: state.director?.threadId });
      return { status: 'wake-requested', threadId: state.director?.threadId ?? null, requestId: request.id, pid: owner.pid };
    }
    if (owner && (owner.hostname !== hostname() || owner.platform !== process.platform)) {
      throw new Error('A foreign Conductor owner exists; inspect it in its environment before starting here.');
    }
    const args = [cliPath, 'serve'];
    if (threadId) args.push('--thread', threadId);
    if (enable) args.push('--enable');
    if (manualWake) args.push('--manual-wake');
    const child = await execute(process.execPath, args, { cwd: root, detached: true, windowsHide: true, stdio: 'ignore' });
    child.unref?.();
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const current = await store.owner();
      if (current?.hostname === hostname() && current.platform === process.platform && processExists(current.pid)) {
        const liveState = await store.read();
        if (liveState.serviceReady === true && liveState.ownerToken === current.token) return { status: 'started', threadId: liveState.director?.threadId ?? threadId ?? null, pid: current.pid };
      }
      await delay(100);
    }
    throw new Error('Conductor was launched but did not acquire repository ownership before the startup timeout. Check `conductor status` and the service log.');
  } finally { await release(); }
}

export async function signalIfEnabled({ store, root, execute, cliPath }) {
  const state = await store.read();
  if (!await runnerEnabled(store)) return { status: 'disabled' };
  if (state.director?.enabled === false) return { status: 'stopped', threadId: state.director.threadId ?? null };
  return ensureService({ store, root, execute, cliPath });
}
