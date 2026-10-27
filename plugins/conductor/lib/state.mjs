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
  constructor(commonDir) { this.dir = join(commonDir, 'conductor'); this.controls = join(this.dir, 'commands'); this.lockPath = join(this.dir, 'coordinator.lock'); this.token = randomUUID(); this.pending = Promise.resolve(); }
  async initialize() { await mkdir(this.controls, { recursive: true }); }
  async read() {
    try {
      const state = JSON.parse(await readFile(join(this.dir, 'state.json'), 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.jobs)) throw new Error('Unsupported or invalid recovery state; preserve it for inspection.');
      state.director ??= { threadId: null, enabled: false, snapshots: {}, events: [], batches: [], acknowledged: [] };
      return state;
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, jobs: [], director: { threadId: null, enabled: false, snapshots: {}, events: [], batches: [], acknowledged: [] } }; throw error; }
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
    if (owner.hostname === hostname() && owner.platform === process.platform && !processExists(owner.pid)) throw new Error('The recorded coordinator has stopped. Start conductor to reconcile recovery state.');
    const request = { id: randomUUID(), owner: owner.token, command, issue, threadId, role, at: new Date().toISOString() };
    await atomicJSON(join(this.controls, `${request.id}.json`), request);
    return request;
  }
  async sendRequest(input) {
    const owner = await this.owner();
    if (!owner) throw new Error('Conductor is not running. Start it explicitly before sending a control request.');
    if (owner.hostname === hostname() && owner.platform === process.platform && !processExists(owner.pid)) throw new Error('The recorded director service has stopped. Resume it to reconcile recovery state.');
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.op !== 'string') throw new Error('Request must be an object with an op.');
    if (input.id !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id)) throw new Error('Request id must be a UUID.');
    const request = { ...input, id: input.id ?? randomUUID(), owner: owner.token, at: new Date().toISOString() };
    const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).filter(([key]) => !['owner','at','completedAt','error','result'].includes(key)).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => [key,stable(item)]))
      : value;
    const same = value => JSON.stringify(stable(value)) === JSON.stringify(stable(request));
    const receiptPath = join(this.dir, 'control-results', `${request.id}.json`);
    try {
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
      if (!same(receipt)) throw new Error(`Request ID ${request.id} already has a different completed operation.`);
      return { ...receipt, completed: true };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const requestPath = join(this.controls, `${request.id}.json`);
    try {
      const existing = JSON.parse(await readFile(requestPath, 'utf8'));
      if (!same(existing)) throw new Error(`Request ID ${request.id} already has a different pending operation.`);
      return existing;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await this.initialize();
    try { await writeFile(requestPath, JSON.stringify(request, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = JSON.parse(await readFile(requestPath, 'utf8'));
      if (!same(existing)) throw new Error(`Request ID ${request.id} already has a different pending operation.`);
      return existing;
    }
    return request;
  }
  async drain() {
    if ((await this.owner())?.token !== this.token) throw new Error('This process does not own the coordinator lock.');
    const requests = [];
    for (const file of (await readdir(this.controls)).filter(x => x.endsWith('.json')).sort()) {
      const path = join(this.controls, file);
      const request = JSON.parse(await readFile(path, 'utf8'));
      const receiptPath = join(this.dir, 'control-results', `${request.id}.json`);
      try { await readFile(receiptPath, 'utf8'); await unlink(path); continue; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (request.owner !== this.token) {
        await this.acknowledge(request, 'Control request belongs to a previous Conductor owner; inspect and resubmit against the current owner.');
        continue;
      }
      requests.push(request);
    }
    return requests.sort((a,b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }
  async acknowledge(request, error, result) {
    if ((await this.owner())?.token !== this.token) throw new Error('Coordinator ownership ended before control acknowledgement.');
    const receipts = join(this.dir, 'control-results'); await mkdir(receipts, { recursive: true });
    await atomicJSON(join(receipts, `${request.id}.json`), { ...request, completedAt: new Date().toISOString(), error: error ?? null, result: result ?? null });
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
