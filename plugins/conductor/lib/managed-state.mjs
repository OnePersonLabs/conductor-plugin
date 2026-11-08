import { mkdir, readFile, writeFile, unlink, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { atomicJSON } from './state.mjs';
import { processExists } from './process.mjs';

export function managedSessionId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) throw new Error('Managed session ID must contain 1--80 letters, digits, underscores or hyphens and start with a letter or digit.');
  return value;
}

// This lock and snapshot belong only to the foreground bridge. Never open the
// automation Store or infer that a managed worker owns an automated issue.
export class ManagedState {
  constructor({ commonDir, cwd, sessionId, alive = processExists }) {
    this.commonDir = commonDir; this.cwd = cwd; this.sessionId = managedSessionId(sessionId); this.alive = alive;
    this.dir = join(commonDir, 'conductor', 'managed', this.sessionId);
    this.lock = join(this.dir, 'writer.lock'); this.path = join(this.dir, 'session.json'); this.token = randomUUID();
    this.tail = Promise.resolve();
  }
  async acquire() {
    this.commonDir = await realpath(this.commonDir); this.cwd = await realpath(this.cwd);
    await mkdir(this.dir, { recursive: true });
    const owner = { token: this.token, pid: process.pid, hostname: hostname(), platform: process.platform };
    try { await writeFile(this.lock, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const recovery = join(this.dir, 'recovery.lock');
      await writeFile(recovery, this.token, { flag: 'wx', mode: 0o600 }).catch(() => { throw new Error('Another managed-session recovery owns this session.'); });
      try {
        const previous = JSON.parse(await readFile(this.lock, 'utf8'));
        if (previous.hostname !== hostname() || previous.platform !== process.platform || this.alive(previous.pid)) throw new Error('A live or foreign managed-session writer owns this session.');
        await unlink(this.lock); await writeFile(this.lock, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      } finally { await unlink(recovery); }
    }
    try {
      let state;
      try { state = JSON.parse(await readFile(this.path, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (state) {
        if (state.version !== 1 || state.sessionId !== this.sessionId || state.cwd !== this.cwd || state.commonDir !== this.commonDir) throw new Error('Managed recovery belongs to another checkout or has an unsupported format.');
        if (state.clientPid && this.alive(state.clientPid)) throw new Error('The previous managed App Server process is still alive. Reconcile its ownership before recovery.');
        state.needsReconcile = Boolean(state.threadId || state.operation);
      } else state = { version: 1, sessionId: this.sessionId, cwd: this.cwd, commonDir: this.commonDir, threadId: null, hasWork: false, settings: null, lastTurn: null, activeTurn: null, operation: null, requests: [], needsReconcile: false };
      await this.save(state); return state;
    } catch (error) { await this.release(); throw error; }
  }
  save(state) {
    const copy = structuredClone(state);
    this.tail = this.tail.then(() => atomicJSON(this.path, copy));
    return this.tail;
  }
  async release({ discard = false } = {}) {
    await this.tail.catch(() => {});
    let owner;
    try { owner = JSON.parse(await readFile(this.lock, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (owner?.token !== this.token) return;
    if (discard) await rm(this.dir, { recursive: true });
    else await unlink(this.lock);
  }
}
