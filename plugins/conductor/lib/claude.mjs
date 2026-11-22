import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { processExists } from './process.mjs';

/**
 * Claude Code adapter with the CodexClient interface.
 *
 * Codex App Server keeps threads in a long-lived server. Claude Code has no such
 * server, so each turn is one `claude -p` process resumed by session id, and
 * this adapter keeps the per-thread facts Codex would own (name, settings, turn
 * history, the running turn's pid, and the wake queue) in small JSON records
 * under `<claude home>/conductor/`. Notifications are emitted with the Codex
 * method names and shapes the coordinator, director host and managed bridge
 * already consume:
 *
 *   turn/started, item/started, item/completed (agentMessage | plan |
 *   contextCompaction), turn/completed, thread/settings/updated.
 *
 * Headless Claude turns cannot raise interactive approval or question prompts,
 * so this client never emits `request`; workers run under the configured
 * permissions, and a worker that needs a decision ends its turn with it.
 */

export const CLAUDE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
// Aliases resolve to the newest model of each family in the installed CLI.
const CLAUDE_MODELS = Object.freeze(['fable', 'opus', 'sonnet', 'haiku', 'claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Prepended to every headless turn. The model would otherwise try tools that
// need a person at a terminal and stall the turn on a denial.
const HEADLESS_NOTE = 'You are running as a non-interactive Conductor worker. Nobody can answer AskUserQuestion or approve prompts during this turn. When a consequential decision is missing, end the turn and state the exact question and options in your final message.';
const PLAN_NOTE = 'This turn is in plan mode. Investigate without editing files. Do not call ExitPlanMode. Return the complete plan as your final message.';

export function claudeHome(env = process.env) {
  return resolve(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'));
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${name} must be a nonempty string.`);
}

function requireThreadId(threadId) {
  requireString(threadId, 'threadId');
  // Session ids become file names; never let one address another directory.
  if (!UUID.test(threadId)) throw new TypeError('threadId must be a Claude session UUID.');
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

/**
 * Cross-process mutual exclusion for one record. The service, the
 * `director-wait` command and the Stop hook all mutate the same queue.
 */
function withLock(file, action, { attempts = 200 } = {}) {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try { mkdirSync(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A lock older than 30s belongs to a crashed process; every holder
      // finishes in milliseconds.
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) { rmSync(lock, { recursive: true, force: true }); continue; } } catch {}
      if (attempt >= attempts) throw new Error(`Timed out waiting for ${lock}.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return action(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

/** Per-session records Conductor keeps beside Claude Code's own transcripts. */
export class ClaudeStore {
  constructor({ home = claudeHome() } = {}) {
    this.home = home;
    this.root = join(home, 'conductor');
  }
  threadFile(id) { requireThreadId(id); return join(this.root, 'threads', `${id}.json`); }
  queueFile(id) { requireThreadId(id); return join(this.root, 'queues', `${id}.json`); }
  waiterFile(id) { requireThreadId(id); return join(this.root, 'waiters', `${id}.json`); }

  readThread(id) { return readJson(this.threadFile(id), null); }
  updateThread(id, change) {
    const file = this.threadFile(id);
    return withLock(file, () => {
      const next = change(readJson(file, null));
      if (next) writeJson(file, next);
      return next;
    });
  }
  listThreads() {
    const dir = join(this.root, 'threads');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(name => name.endsWith('.json')).map(name => readJson(join(dir, name), null)).filter(Boolean);
  }

  /** Locate Claude Code's own transcript for a session, in any project directory. */
  transcriptPath(id) {
    requireThreadId(id);
    const projects = join(this.home, 'projects');
    if (!existsSync(projects)) return null;
    for (const project of readdirSync(projects)) {
      const candidate = join(projects, project, `${id}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  /** Facts Conductor needs from a transcript it did not write: cwd, title and user turns. */
  readTranscript(id) {
    const file = this.transcriptPath(id);
    if (!file) return null;
    let cwd = null, name = null; const turns = [];
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let entry; try { entry = JSON.parse(line); } catch { continue; }
      if (!cwd && typeof entry.cwd === 'string') cwd = entry.cwd;
      if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') name = entry.customTitle;
      if (entry.type !== 'user' || entry.isMeta || entry.isSynthetic || entry.isSidechain) continue;
      const content = entry.message?.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) && content.every(part => part?.type === 'text') ? content.map(part => part.text).join('\n') : null;
      if (text === null) continue;
      const id = entry.promptId ?? entry.uuid;
      if (turns.at(-1)?.id === id) continue;
      turns.push({ id, status: /\[Request interrupted by user/.test(text) ? 'interrupted' : 'completed' });
    }
    return { path: file, cwd, name, turns };
  }

  queue(id) { return readJson(this.queueFile(id), []); }
  enqueue(id, { text, clientUserMessageId }) {
    const file = this.queueFile(id);
    return withLock(file, () => {
      const items = readJson(file, []);
      const existing = items.find(item => item.clientUserMessageId === clientUserMessageId);
      if (existing) return existing;
      const item = { id: randomUUID(), clientUserMessageId, text, createdAt: new Date().toISOString() };
      writeJson(file, [...items, item]);
      return item;
    });
  }
  dequeue(id, itemId) {
    const file = this.queueFile(id);
    return withLock(file, () => {
      const items = readJson(file, []);
      const kept = items.filter(item => item.id !== itemId);
      if (kept.length === items.length) return false;
      writeJson(file, kept);
      return true;
    });
  }
  /** Remove and return every queued item atomically, so each wake is delivered once. */
  drain(id) {
    const file = this.queueFile(id);
    return withLock(file, () => {
      const items = readJson(file, []);
      if (items.length) writeJson(file, []);
      return items;
    });
  }

  waiter(id) {
    const record = readJson(this.waiterFile(id), null);
    return record && processExists(record.pid) ? record : null;
  }
  setWaiter(id, pid) { writeJson(this.waiterFile(id), { pid, startedAt: new Date().toISOString() }); }
  clearWaiter(id, pid) {
    const file = this.waiterFile(id);
    withLock(file, () => { if (readJson(file, null)?.pid === pid) rmSync(file, { force: true }); });
  }
}

function resolveClaude(command, env) {
  // CLAUDE_BIN may name a JavaScript entrypoint; run it with this Node binary.
  if (/\.[cm]?js$/i.test(command)) return { file: process.execPath, prefix: [resolve(command)] };
  // On Windows the npm shim is a .cmd that spawn() cannot run without a shell.
  // Prefer the native executable that the shim wraps.
  if (process.platform !== 'win32' || /[\\/]/.test(command)) return { file: command, prefix: [] };
  for (const dir of (env.PATH ?? env.Path ?? '').split(';')) {
    const candidate = join(dir, `${command}.exe`);
    if (existsSync(candidate)) return { file: candidate, prefix: [] };
  }
  return { file: command, prefix: [] };
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGTERM');
}

export class ClaudeClient extends EventEmitter {
  constructor({ cwd = process.cwd(), env = process.env, command, args = [], settings = {}, home } = {}) {
    super();
    this.cwd = resolve(cwd);
    this.env = { ...env };
    this.command = command ?? env.CLAUDE_BIN ?? 'claude';
    this.extraArgs = [...args];
    // Repository `claude` settings apply to Default-mode turns only. Plan mode
    // stays plan mode regardless of how permissive implementation turns are.
    this.settings = { permissionMode: settings.permissionMode, allowedTools: settings.allowedTools ?? [] };
    this.store = new ClaudeStore({ home: home ?? claudeHome(this.env) });
    this.connected = false;
    this.turns = new Map();
    this._exit = undefined;
  }

  get pendingRequests() { return []; }
  get pendingServerRequests() { return []; }
  /** The adapter is in-process; a running turn's pid is recorded per thread instead. */
  get pid() { return undefined; }

  async connect() {
    if (this.connected) return this;
    const executable = resolveClaude(this.command, this.env);
    const probe = spawnSync(executable.file, [...executable.prefix, '--version'], { cwd: this.cwd, env: this.env, encoding: 'utf8', windowsHide: true });
    if (probe.error || probe.status !== 0) throw new Error(`Claude Code CLI is unavailable (${this.command}):${probe.error?.message ?? probe.stderr?.trim() ?? probe.status}. Install it or set CLAUDE_BIN.`);
    this.executable = executable;
    this.version = probe.stdout.trim();
    this.connected = true;
    return this;
  }

  async readConfig() { this._assertConnected(); return { config: { runtime: 'claude', version: this.version } }; }

  async startThread({ cwd = this.cwd, model, reasoningEffort, config } = {}) {
    this._assertConnected();
    const id = randomUUID();
    const record = {
      id, cwd: resolve(cwd), name: null, createdAt: new Date().toISOString(),
      model: model ?? null, effort: reasoningEffort ?? config?.model_reasoning_effort ?? null, mode: 'default',
      turns: [], activeTurn: null,
    };
    this.store.updateThread(id, () => record);
    return this._thread(record, null);
  }

  async setThreadName({ threadId, name } = {}) {
    this._assertConnected(); requireThreadId(threadId); requireString(name, 'name');
    this._ensureRecord(threadId);
    this.store.updateThread(threadId, record => ({ ...record, name }));
    return {};
  }

  async resumeThread({ threadId, cwd = this.cwd, includeSettings = false } = {}) {
    this._assertConnected(); requireThreadId(threadId);
    const record = this._ensureRecord(threadId, cwd);
    const thread = this._thread(record, this.store.readTranscript(threadId));
    if (!includeSettings) return thread;
    return { thread, model: record.model ?? 'opus', reasoningEffort: record.effort ?? 'high', collaborationMode: { mode: record.mode ?? 'default' } };
  }

  async readThread({ threadId, includeTurns = true } = {}) {
    this._assertConnected(); requireThreadId(threadId);
    const record = this.store.readThread(threadId);
    const transcript = this.store.readTranscript(threadId);
    if (!record && !transcript) throw new Error(`Claude session ${threadId} not found.`);
    const thread = this._thread(record, transcript);
    return includeTurns ? thread : { ...thread, turns: [] };
  }

  async listThreads({ cwd = this.cwd } = {}) {
    this._assertConnected();
    const wanted = resolve(cwd);
    return this.store.listThreads().filter(record => record.cwd && resolve(record.cwd) === wanted).map(record => this._thread(record, null));
  }

  async listModels() {
    return CLAUDE_MODELS.map(id => ({ id, model: id, supportedReasoningEfforts: CLAUDE_EFFORTS.map(reasoningEffort => ({ reasoningEffort })) }));
  }

  async updateThreadSettings({ threadId, mode, model, effort } = {}) {
    this._assertConnected(); requireThreadId(threadId);
    if (!['plan', 'default'].includes(mode)) throw new Error('mode must be plan or default.');
    requireString(model, 'model'); requireString(effort, 'effort');
    if (!CLAUDE_EFFORTS.includes(effort)) throw new Error(`Claude effort must be one of ${CLAUDE_EFFORTS.join(', ')}.`);
    this._ensureRecord(threadId);
    this.store.updateThread(threadId, record => ({ ...record, mode, model, effort }));
    queueMicrotask(() => this._emit('thread/settings/updated', { threadId, threadSettings: { collaborationMode: { mode }, model, effort } }));
    return {};
  }

  async startTurn({ threadId, cwd = this.cwd, prompt, skillPath, outputSchema } = {}) {
    this._assertConnected(); requireThreadId(threadId); requireString(prompt, 'prompt');
    const text = skillPath === undefined ? prompt : `Read and follow the skill at ${resolve(skillPath)} for this turn.\n\n${prompt}`;
    return this._run({ threadId, cwd, prompt: text, outputSchema, kind: 'work' });
  }

  async compactThread({ threadId } = {}) {
    this._assertConnected(); requireThreadId(threadId);
    // `/compact` is Claude Code's native compaction; it runs as its own turn.
    return this._run({ threadId, cwd: this.store.readThread(threadId)?.cwd ?? this.cwd, prompt: '/compact', kind: 'compact' });
  }

  async interrupt({ threadId, turnId } = {}) {
    this._assertConnected(); requireThreadId(threadId); requireString(turnId, 'turnId');
    const turn = this.turns.get(turnId);
    if (turn) { turn.interrupted = true; killTree(turn.child); return {}; }
    // A turn started by an earlier process can still be running; its pid is recorded.
    const active = this.store.readThread(threadId)?.activeTurn;
    if (active?.id === turnId && processExists(active.pid)) { killTree({ pid: active.pid }); return {}; }
    throw new Error(`Claude turn ${turnId} is not running.`);
  }

  async respond(requestId) {
    throw new Error(`No pending Claude request with id ${String(requestId)}: headless Claude turns do not raise interactive requests.`);
  }

  async addQueuedMessage({ threadId, text, clientUserMessageId } = {}) {
    this._assertConnected(); requireThreadId(threadId); requireString(text, 'text'); requireString(clientUserMessageId, 'clientUserMessageId');
    return this.store.enqueue(threadId, { text, clientUserMessageId });
  }
  async listQueuedMessages({ threadId } = {}) { this._assertConnected(); requireThreadId(threadId); return this.store.queue(threadId); }
  async deleteQueuedMessage({ threadId, queuedSubmissionId } = {}) {
    this._assertConnected(); requireThreadId(threadId); requireString(queuedSubmissionId, 'queuedSubmissionId');
    return this.store.dequeue(threadId, queuedSubmissionId);
  }

  async close() {
    this._closing = true;
    for (const turn of this.turns.values()) { turn.interrupted = true; killTree(turn.child); }
    await Promise.allSettled([...this.turns.values()].map(turn => turn.done));
    if (!this._exit) { this._exit = { code: 0, signal: null }; this.connected = false; this.emit('exit', this._exit); }
  }

  _assertConnected() {
    if (!this.connected || this._exit) throw new Error('Claude Code client is not connected');
  }

  _ensureRecord(threadId, cwd = this.cwd) {
    const existing = this.store.readThread(threadId);
    if (existing) return existing;
    // Adopting a session Conductor did not create (for example the user's own
    // Claude Code chat) requires Claude Code to know it.
    const transcript = this.store.readTranscript(threadId);
    if (!transcript) throw new Error(`Claude session ${threadId} not found.`);
    const record = { id: threadId, cwd: resolve(transcript.cwd ?? cwd), name: transcript.name, createdAt: new Date().toISOString(), model: null, effort: null, mode: 'default', turns: [], activeTurn: null, adopted: true };
    this.store.updateThread(threadId, current => current ?? record);
    return this.store.readThread(threadId);
  }

  _thread(record, transcript) {
    const active = record?.activeTurn && processExists(record.activeTurn.pid) ? record.activeTurn : null;
    const turns = record?.turns?.length ? record.turns.map(turn => ({ ...turn })) : (transcript?.turns ?? []);
    // A recorded turn whose process vanished without a terminal record is
    // uncertain, not running: report it as failed so recovery inspects it.
    if (record?.activeTurn && !active) {
      const lost = turns.find(turn => turn.id === record.activeTurn.id);
      if (lost && lost.status === 'inProgress') lost.status = 'failed';
    }
    const status = active ? 'active' : record && !record.adopted ? 'idle' : 'notLoaded';
    return {
      id: record?.id ?? basename(transcript?.path ?? '', '.jsonl'),
      cwd: record?.cwd ?? transcript?.cwd ?? null,
      name: record?.name ?? transcript?.name ?? null,
      status: { type: status, activeFlags: [] },
      turns,
    };
  }

  _emit(method, params) {
    try { this.emit('notification', { method, params }); }
    catch (error) { queueMicrotask(() => this.emit('error', error)); }
  }

  _args({ record, transcriptExists, outputSchema }) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    args.push(...(transcriptExists ? ['--resume', record.id] : ['--session-id', record.id]));
    if (record.name) args.push('--name', record.name);
    if (record.model) args.push('--model', record.model);
    if (record.effort && CLAUDE_EFFORTS.includes(record.effort)) args.push('--effort', record.effort);
    const disallowed = ['AskUserQuestion'];
    if (record.mode === 'plan') {
      args.push('--permission-mode', 'plan');
      disallowed.push('ExitPlanMode');
    } else {
      if (this.settings.permissionMode) args.push('--permission-mode', this.settings.permissionMode);
      if (this.settings.allowedTools.length) args.push('--allowedTools', ...this.settings.allowedTools);
    }
    args.push('--disallowedTools', ...disallowed);
    args.push('--append-system-prompt', record.mode === 'plan' ? `${HEADLESS_NOTE}\n${PLAN_NOTE}` : HEADLESS_NOTE);
    if (outputSchema !== undefined) args.push('--json-schema', JSON.stringify(outputSchema));
    return [...args, ...this.extraArgs];
  }

  async _run({ threadId, cwd, prompt, outputSchema, kind }) {
    const record = this._ensureRecord(threadId, cwd);
    if (record.activeTurn && processExists(record.activeTurn.pid)) throw new Error(`Claude session ${threadId} already has a running turn ${record.activeTurn.id}.`);
    const turnId = randomUUID();
    const transcriptExists = Boolean(this.store.transcriptPath(threadId));
    const child = spawn(this.executable.file, [...this.executable.prefix, ...this._args({ record, transcriptExists, outputSchema })], {
      cwd: resolve(cwd), env: this.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
    });
    const turn = { id: turnId, child, interrupted: false, lastText: '', plan: null, result: null, stderr: '' };
    this.turns.set(turnId, turn);
    this.store.updateThread(threadId, current => ({
      ...current,
      activeTurn: { id: turnId, pid: child.pid, kind, startedAt: new Date().toISOString() },
      turns: [...(current.turns ?? []), { id: turnId, status: 'inProgress', kind }],
    }));

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (line) this._frame(turn, line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { turn.stderr = (turn.stderr + chunk).slice(-4000); });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);

    turn.done = new Promise(resolveDone => {
      const finish = (code, signal, spawnError) => {
        if (turn.finished) return; turn.finished = true;
        if (buffer.trim()) this._frame(turn, buffer.trim());
        const result = turn.result;
        const status = turn.interrupted ? 'interrupted'
          : !spawnError && code === 0 && result && !result.is_error ? 'completed' : 'failed';
        const error = status === 'failed' ? { message: spawnError?.message ?? result?.result ?? result?.errors?.join('; ') ?? (turn.stderr.trim() || `claude exited with ${code ?? signal}`) } : null;
        const params = { threadId, turnId };
        if (status === 'completed') {
          if (kind === 'compact') this._emit('item/completed', { ...params, item: { type: 'contextCompaction', id: `${turnId}:compact` } });
          if (kind === 'work' && record.mode === 'plan') {
            const plan = turn.plan ?? (typeof result.result === 'string' ? result.result : turn.lastText);
            this._emit('item/completed', { ...params, item: { type: 'plan', id: `${turnId}:plan`, text: plan } });
          }
          const text = result.structured_output !== undefined ? JSON.stringify(result.structured_output)
            : typeof result.result === 'string' && result.result ? result.result : turn.lastText;
          if (kind === 'work') this._emit('item/completed', { ...params, item: { type: 'agentMessage', id: `${turnId}:message`, text } });
        }
        this.store.updateThread(threadId, current => ({
          ...current,
          activeTurn: current.activeTurn?.id === turnId ? null : current.activeTurn,
          turns: (current.turns ?? []).map(item => item.id === turnId ? { ...item, status, ...(error ? { error } : {}), completedAt: new Date().toISOString() } : item),
        }));
        this.turns.delete(turnId);
        this._emit('turn/completed', { threadId, turn: { id: turnId, status, error } });
        resolveDone();
      };
      child.once('error', error => finish(null, null, error));
      child.once('close', (code, signal) => finish(code, signal));
    });

    // Codex announces a turn after acknowledging turn/start; keep that order.
    queueMicrotask(() => {
      this._emit('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
      if (kind === 'compact') this._emit('item/started', { threadId, turnId, item: { type: 'contextCompaction', id: `${turnId}:compact` } });
    });
    return { id: turnId, status: 'inProgress' };
  }

  _frame(turn, line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.type === 'assistant' && !message.parent_tool_use_id) {
      for (const part of message.message?.content ?? []) {
        if (part.type === 'text' && part.text) turn.lastText = part.text;
        if (part.type === 'tool_use' && part.name === 'ExitPlanMode' && typeof part.input?.plan === 'string') turn.plan = part.input.plan;
      }
    } else if (message.type === 'result') {
      turn.result = message;
    }
  }
}
