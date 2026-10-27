import { mkdir, readFile, writeFile, rename, unlink, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

export function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

export async function atomicJSON(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try { await rename(temp, path); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

export class Store {
  constructor(commonDir) { this.dir = join(commonDir, 'symphony-lite'); this.controls = join(this.dir, 'commands'); this.lockPath = join(this.dir, 'coordinator.lock'); this.token = randomUUID(); this.pending = Promise.resolve(); }
  async initialize() { await mkdir(this.controls, { recursive: true }); }
  async read() {
    try {
      const state = JSON.parse(await readFile(join(this.dir, 'state.json'), 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.jobs)) throw new Error('Unsupported or invalid recovery state; preserve it for inspection.');
      return state;
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, jobs: [] }; throw error; }
  }
  save(state) {
    // Snapshot before queueing; concurrent terminal outcomes cannot mutate an older write.
    const snapshot = structuredClone({ ...state, updatedAt: new Date().toISOString() });
    this.pending = this.pending.catch(() => {}).then(() => atomicJSON(join(this.dir, 'state.json'), snapshot));
    return this.pending;
  }
  async owner() { try { return JSON.parse(await readFile(this.lockPath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
  async acquire() {
    await this.initialize();
    const owner = { token: this.token, pid: process.pid, hostname: hostname(), platform: process.platform, startedAt: new Date().toISOString() };
    try { await writeFile(this.lockPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const recovery = join(this.dir, 'recovery.lock');
      try { await writeFile(recovery, this.token, { flag: 'wx', mode: 0o600 }); }
      catch { throw new Error('Another recovery attempt owns the repository. Resolve its recovery.lock before retrying.'); }
      try {
        const previous = await this.owner();
        if (previous && (previous.hostname !== hostname() || previous.platform !== process.platform || processExists(previous.pid))) throw new Error(`A coordinator owns this repository (${previous.platform} PID ${previous.pid}). Use its environment or resolve the owner; no duplicate was started.`);
        if (previous) await unlink(this.lockPath);
        await writeFile(this.lockPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      } finally { await unlink(recovery); }
    }
    return owner;
  }
  async release() { if ((await this.owner())?.token === this.token) await unlink(this.lockPath); }
  async send(command, issue, threadId, role) {
    const owner = await this.owner();
    if (!owner) throw new Error('No coordinator is running for this repository.');
    if (owner.hostname === hostname() && owner.platform === process.platform && !processExists(owner.pid)) throw new Error('The recorded coordinator has stopped. Start symphony-lite to reconcile recovery state.');
    const request = { id: randomUUID(), owner: owner.token, command, issue, threadId, role, at: new Date().toISOString() };
    await atomicJSON(join(this.controls, `${request.id}.json`), request);
    return request;
  }
  async drain() {
    if ((await this.owner())?.token !== this.token) throw new Error('This process does not own the coordinator lock.');
    const requests = [];
    for (const file of (await readdir(this.controls)).filter(x => x.endsWith('.json')).sort()) {
      const path = join(this.controls, file);
      const request = JSON.parse(await readFile(path, 'utf8'));
      requests.push(request);
    }
    return requests.sort((a,b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }
  async acknowledge(request, error) {
    if ((await this.owner())?.token !== this.token) throw new Error('Coordinator ownership ended before control acknowledgement.');
    const receipts = join(this.dir, 'control-results'); await mkdir(receipts, { recursive: true });
    await atomicJSON(join(receipts, `${request.id}.json`), { ...request, completedAt: new Date().toISOString(), error: error ?? null });
    await unlink(join(this.controls, `${request.id}.json`));
  }
  async results() {
    const dir = join(this.dir, 'control-results');
    try {
      const files = await readdir(dir);
      const values = await Promise.all(files.filter(x => x.endsWith('.json')).map(x => readFile(join(dir, x), 'utf8').then(JSON.parse)));
      return values.sort((a,b) => b.completedAt.localeCompare(a.completedAt)).slice(0, 10);
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
}
