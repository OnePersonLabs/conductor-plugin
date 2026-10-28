import { mkdir, readFile, writeFile, rename, unlink, readdir, stat, lstat, realpath } from 'node:fs/promises';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { appendFileSync, statSync, renameSync, unlinkSync } from 'node:fs';

export function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

export async function atomicJSON(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try {
    // Windows readers that omit FILE_SHARE_DELETE temporarily prevent replacement.
    // Keep the previous snapshot intact and retry only that platform's sharing
    // errors. A persistent lock/permission failure still reaches the caller.
    const deadline = performance.now() + 2000;
    for (;;) {
      try { await rename(temp, path); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || performance.now() >= deadline) throw error;
        await delay(25);
      }
    }
  } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

export async function prepareServiceLog(path, now = Date.now()) {
  const maxAge = 7 * 24 * 60 * 60_000;
  for (const suffix of [1, 2]) {
    const rotated = `${path}.${suffix}`;
    try { if (now - (await stat(rotated)).mtimeMs > maxAge) await unlink(rotated); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let size = 0;
  try { size = (await stat(path)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (size < 5 * 1024 * 1024) return;
  try { await unlink(`${path}.2`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await rename(`${path}.1`, `${path}.2`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rename(path, `${path}.1`);
}

export function appendServiceLog(path, message, now = Date.now()) {
  const text = `${new Date(now).toISOString()} ${String(message).slice(0, 16 * 1024)}\n`;
  const max = 5 * 1024 * 1024;
  try { if (statSync(path).size + Buffer.byteLength(text) > max) {
    try { unlinkSync(`${path}.2`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { renameSync(`${path}.1`, `${path}.2`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    renameSync(path, `${path}.1`);
  } } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const suffix of [1, 2]) {
    const rotated = `${path}.${suffix}`;
    try { if (now - statSync(rotated).mtimeMs > 7 * 24 * 60 * 60_000) unlinkSync(rotated); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  appendFileSync(path, text, { mode: 0o600 });
}

export class Store {
  constructor(commonDir) { this.dir = join(commonDir, 'conductor'); this.controls = join(this.dir, 'commands'); this.lockPath = join(this.dir, 'coordinator.lock'); this.token = randomUUID(); this.pending = Promise.resolve(); }
  async initialize() { await mkdir(this.controls, { recursive: true }); }
  async issueRetryId(now = Date.now()) {
    const expires = now + 7 * 24 * 60 * 60_000;
    const nonce = randomUUID().replaceAll('-', '');
    return `v1.${expires}.${nonce}`;
  }
  async validateRetryId(id, now = Date.now()) {
    const match = /^v1\.(\d{13})\.([0-9a-f]{32})$/.exec(id ?? '');
    if (!match) throw new Error('Control request retry ID is invalid or legacy; create a new request after reconciling the prior result.');
    const expires = Number(match[1]);
    if (now >= expires) throw new Error('Control request retry ID expired; reconcile its outcome and issue a new request.');
    return expires;
  }
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
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).filter(([key]) => !['owner','at','retryExpiresAt','completedAt','error','result'].includes(key)).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => [key,stable(item)]))
      : value;
    if (input.id && uuid.test(input.id)) {
      for (const [path, completed] of [[join(this.dir, 'control-results', `${input.id}.json`), true], [join(this.controls, `${input.id}.json`), false]]) {
        try {
          const existing = JSON.parse(await readFile(path, 'utf8'));
          if (JSON.stringify(stable(existing)) !== JSON.stringify(stable(input))) throw new Error(`Legacy request ID ${input.id} belongs to a different operation.`);
          const issuedAt = Date.parse(existing.completedAt ?? existing.at);
          if (!Number.isFinite(issuedAt) || Date.now() >= issuedAt + 7 * 24 * 60 * 60_000) throw new Error('Legacy control request retry window expired; reconcile outcome and submit a new request.');
          return completed ? { ...existing, completed: true } : existing;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      throw new Error('Unknown legacy control request ID; reconcile its outcome before submitting a new request.');
    }
    if (input.id && !/^v1\./.test(input.id)) throw new Error('Request id must be a versioned Conductor retry handle.');
    const requestId = input.id ?? await this.issueRetryId();
    const expiresAt = await this.validateRetryId(requestId);
    const request = { ...input, id: requestId, retryExpiresAt: new Date(expiresAt).toISOString(), owner: owner.token, at: new Date().toISOString() };
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
      if (request.id?.startsWith('v1.') && Date.now() >= Number(/^v1\.(\d{13})\./.exec(request.id)?.[1])) {
        await this.acknowledge(request, 'Control request retry window expired before execution; reconcile outcome and submit a new request.');
        continue;
      }
      if (request.op && /^[0-9a-f-]{36}$/i.test(request.id ?? '')) {
        await this.acknowledge(request, 'Legacy control request has no expiring retry handle; inspect and resubmit explicitly.');
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
    await this.cleanupOwned();
  }
  async results() {
    const dir = join(this.dir, 'control-results');
    try {
      const files = await readdir(dir);
      const values = await Promise.all(files.filter(x => x.endsWith('.json')).map(x => readFile(join(dir, x), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; })));
      return values.filter(Boolean).filter(item => {
        const expires = item.id?.startsWith('v1.') ? Number(/^v1\.(\d{13})\.[0-9a-f]{32}$/.exec(item.id)?.[1]) : Date.parse(item.completedAt) + 7 * 24 * 60 * 60_000;
        return Number.isFinite(expires) && Date.now() < expires;
      }).sort((a,b) => b.completedAt.localeCompare(a.completedAt)).slice(0, 10);
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  async previewCleanup(now = Date.now()) {
    const candidates = [], retained = [];
    const activeOwner = await this.owner();
    try {
      const info = await lstat(this.dir);
      if (!info.isDirectory() || info.isSymbolicLink()) return { candidates, retained: [{ path: this.dir, reason: 'Conductor state root is not a real directory' }] };
      const actualRoot = await realpath(this.dir), actualCommon = await realpath(dirname(this.dir));
      if (relative(actualCommon, actualRoot) !== 'conductor') return { candidates, retained: [{ path: this.dir, reason: 'Conductor state root resolves outside its Git common directory' }] };
    } catch (error) { if (error.code === 'ENOENT') return { candidates, retained }; throw error; }
    for (const [name, legacyGrace] of [['commands', 7], ['control-results', 7]]) {
      const dir = join(this.dir, name);
      let files;
      try { files = await readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const dirInfo = await lstat(dir);
      if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) { retained.push({ path: dir, reason: 'cleanup directory is not a real directory' }); continue; }
      const actualDir = await realpath(dir);
      const actualRoot = await realpath(this.dir);
      const relDir = relative(actualRoot, actualDir);
      if (relDir.startsWith('..') || isAbsolute(relDir)) { retained.push({ path: dir, reason: 'cleanup directory resolves outside Conductor state' }); continue; }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue;
        const path = join(dir, file.name);
        try {
          const value = JSON.parse(await readFile(path, 'utf8'));
          if (file.name !== `${value.id}.json`) { retained.push({ path, reason: 'filename does not match record identity' }); continue; }
          // Pending commands must pass through drain() so stale/expired work is
          // acknowledged as a recovery outcome, never silently discarded.
          if (name === 'commands') { retained.push({ path, reason: activeOwner?.token === value.owner ? 'pending request awaits owner drain' : 'pending request requires owner reconciliation' }); continue; }
          const signed = /^v1\.(\d{13})\.([0-9a-f]{32})$/.exec(value.id ?? '');
          const expiry = signed ? Number(signed[1]) : Date.parse(value.completedAt ?? value.at) + legacyGrace * 24 * 60 * 60_000;
          if (!Number.isFinite(expiry)) { retained.push({ path, reason: 'record has no valid original expiry timestamp' }); continue; }
          if (expiry <= now) candidates.push({ path, kind: name, id: value.id, expiry: new Date(expiry).toISOString() });
        } catch (error) { retained.push({ path, reason: `record cannot be validated: ${error.message}` }); }
      }
    }
    return { candidates, retained };
  }

  async previewMigrationBackups(repoRoot, now = Date.now(), configVerified = false) {
    if (!repoRoot) return { candidates: [], retained: [] };
    const candidates = [], retained = [];
    for (const item of await readdir(repoRoot, { withFileTypes: true })) {
      if (!item.name.startsWith('conductor.json.legacy-') || !item.name.endsWith('.bak')) continue;
      const path = join(repoRoot, item.name);
      if (!item.isFile() || item.isSymbolicLink()) { retained.push({ path, reason: 'migration backup is not a regular file' }); continue; }
      if (!configVerified) { retained.push({ path, reason: 'migration backup remains until the current v2 configuration is validated' }); continue; }
      const stamp = item.name.slice('conductor.json.legacy-'.length, -4).replace(/T(\d{2})-(\d{2})-(\d{2})(\.\d+Z)$/, 'T$1:$2:$3$4');
      const created = Date.parse(stamp);
      if (!Number.isFinite(created)) { retained.push({ path, reason: 'migration backup timestamp cannot be validated' }); continue; }
      const expiry = created + 7 * 24 * 60 * 60_000;
      if (expiry <= now) candidates.push({ path, expiry: new Date(expiry).toISOString(), kind: 'migration-backup' });
    }
    return { candidates, retained };
  }

  async cleanupMigrationBackups(repoRoot, now = Date.now(), configVerified = false) {
    if ((await this.owner())?.token !== this.token) throw new Error('This process does not own the coordinator lock.');
    const preview = await this.previewMigrationBackups(repoRoot, now, configVerified);
    const removed = [];
    for (const item of preview.candidates) {
      try {
        const info = await lstat(item.path);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('backup path is not a regular file');
        await unlink(item.path); removed.push(item);
      } catch (error) { if (error.code !== 'ENOENT') throw new Error(`Could not remove expired migration backup ${item.path}: ${error.message}. Retry cleanup after resolving the file lock.`); }
    }
    return { removed, exceptions: preview.retained };
  }

  async cleanupOwned(now = Date.now()) {
    if ((await this.owner())?.token !== this.token) throw new Error('This process does not own the coordinator lock.');
    const preview = await this.previewCleanup(now);
    const candidates = preview.candidates;
    const removed = [];
    for (const candidate of candidates) {
      const expectedDir = join(this.dir, candidate.kind);
      const remainder = relative(expectedDir, candidate.path);
      if (!remainder || remainder.startsWith('..') || isAbsolute(remainder)) continue;
      try {
        const info = await lstat(candidate.path);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('record path is not a regular file');
        if (await realpath(expectedDir) !== await realpath(join(candidate.path, '..'))) throw new Error('record path parent changed during cleanup');
        await unlink(candidate.path); removed.push(candidate);
      }
      catch (error) { if (error.code !== 'ENOENT') throw new Error(`Could not remove expired Conductor ${candidate.kind} record ${candidate.path}: ${error.message}. Retry cleanup while no control operation is in flight.`); }
    }
    const after = await this.previewCleanup(now);
    return { removed, retained: [...after.retained, ...after.candidates].length, exceptions: after.retained };
  }

  async cleanupStopped(now = Date.now(), repoRoot = null, configVerified = false) {
    const owner = await this.owner();
    if (owner && (owner.hostname !== hostname() || owner.platform !== process.platform || processExists(owner.pid))) throw new Error('Conductor is running or owned by another environment; cleanup must run under the active owner.');
    await this.acquire();
    try {
      const result = await this.cleanupOwned(now);
      const backups = repoRoot ? await this.cleanupMigrationBackups(repoRoot, now, configVerified) : { removed: [], exceptions: [] };
      return { ...result, removedBackups: backups.removed, exceptions: [...result.exceptions, ...backups.exceptions] };
    } finally { await this.release(); }
  }
}
