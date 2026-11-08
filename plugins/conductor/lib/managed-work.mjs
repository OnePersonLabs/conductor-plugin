import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { CodexClient } from './codex.mjs';
import { ManagedState } from './managed-state.mjs';

const clone = value => structuredClone(value);
const sameSettings = (actual, wanted) => actual?.mode === wanted.mode && actual.model === wanted.model && actual.effort === wanted.effort;
function settingsOf(value) {
  return { mode: value.collaborationMode?.mode, model: value.model, effort: value.effort ?? value.reasoningEffort };
}
function publicRequest(request) {
  // Authentication notifications are never forwarded. Pending answers are neither
  // persisted nor echoed; redact explicit credential fields in server requests.
  return JSON.parse(JSON.stringify(request, (key, value) => /^(?:authorization|password|accessToken|refreshToken|apiKey|secret)$/i.test(key) ? '[redacted]' : value));
}

export class ManagedWork extends EventEmitter {
  constructor({ commonDir, cwd, sessionId, store, client } = {}) {
    super();
    this.store = store ?? new ManagedState({ commonDir, cwd, sessionId });
    this.client = client ?? new CodexClient({ cwd, experimentalApi: true });
    this.loaded = false; this.closing = false; this.waiters = new Set(); this.ids = new Set();
    this.events = Promise.resolve(); this.busy = null;
    this.client.on('notification', event => this.enqueue(() => this.notification(event)));
    this.client.on('request', request => this.enqueue(() => this.request(request)));
    this.client.on('error', error => this.enqueue(() => this.lost(error.message)));
    this.client.on('exit', () => { if (!this.closing) this.enqueue(() => this.lost('Managed App Server transport exited.')); });
  }
  async open() { this.state = await this.store.acquire(); return this.snapshot(); }
  snapshot() { return clone({ ...this.state, connected: this.client.connected && !this.client._exit, loaded: this.loaded, busy: this.busy }); }
  emitEvent(event, values = {}) { this.emit('event', { event, sessionId: this.state.sessionId, ...values }); }
  enqueue(action) {
    this.events = this.events.then(action).catch(error => {
      this.fatal = error; this.rejectWaiters(error); this.emitEvent('error', { message: error.message });
    });
  }
  async save() { await this.store.save(this.state); this.checkWaiters(); }
  checkWaiters() {
    for (const waiter of this.waiters) if (waiter.predicate()) { this.waiters.delete(waiter); waiter.resolve(); }
  }
  rejectWaiters(error) { for (const waiter of this.waiters) waiter.reject(error); this.waiters.clear(); }
  waitUntil(predicate) {
    if (predicate()) return Promise.resolve();
    if (this.fatal || this.closing) return Promise.reject(this.fatal ?? new Error('Bridge is closing.'));
    return new Promise((resolve, reject) => this.waiters.add({ predicate, resolve, reject }));
  }
  async connect() {
    if (this.client._exit) throw new Error('Transport was lost. Close this bridge and reconcile the saved session in a new process.');
    if (!this.client.connected) { await this.client.connect(); this.state.clientPid = this.client.pid; await this.save(); }
  }
  async lost(message) {
    if (this.closing) return;
    this.state.needsReconcile = true; this.loaded = false;
    this.fatal = new Error(message); await this.save(); this.rejectWaiters(this.fatal);
    this.emitEvent('transport-lost', { message, success: false });
  }
  async request(request) {
    if (request.params?.threadId && request.params.threadId !== this.state.threadId) throw new Error('App Server requested input for an unowned thread.');
    const record = { id: request.id, method: request.method, turnId: request.params?.turnId ?? this.state.activeTurn?.id, itemId: request.params?.itemId, status: 'pending' };
    this.state.requests.push(record); await this.save();
    this.emitEvent('request', { commandId: this.state.activeTurn?.commandId, request: publicRequest(request) });
  }
  async notification({ method, params }) {
    if (params?.threadId !== this.state.threadId) return;
    const operation = this.state.operation;
    if (method === 'thread/settings/updated') {
      this.state.settings = settingsOf(params.threadSettings);
      if (operation?.kind === 'configure' && operation.stage === 'settings') operation.applied = clone(this.state.settings);
      await this.save(); this.emitEvent('settings-applied', { commandId: operation?.commandId, settings: this.state.settings });
    } else if (method === 'turn/started') {
      const kind = operation?.kind === 'configure' && operation.stage === 'compact' ? 'compact' : 'work';
      this.state.activeTurn = { id: params.turn.id, kind, commandId: operation?.commandId, status: params.turn.status };
      if (operation && ['turn', 'configure'].includes(operation.kind)) operation.turnId = params.turn.id;
      await this.save(); this.emitEvent('turn-started', { ...this.state.activeTurn });
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = params.item;
      if (item.type === 'contextCompaction') {
        if (operation?.kind === 'configure' && operation.stage === 'compact') {
          if (method === 'item/started') { operation.compactItemId = item.id; operation.turnId = params.turnId; }
          else if (operation.compactItemId === item.id && operation.turnId === params.turnId) operation.compactComplete = true;
        }
        await this.save(); this.emitEvent(method === 'item/started' ? 'compact-started' : 'compact-completed', { commandId: operation?.commandId, turnId: params.turnId, itemId: item.id });
      }
      if (method === 'item/completed') {
        // Writing a response is not proof that the host consumed it. The matching
        // item or terminal turn is the first usable consumption evidence.
        this.state.requests = this.state.requests.filter(request => !(request.status === 'sent' && request.itemId === item.id && request.turnId === params.turnId));
        await this.save();
        if (item.type === 'agentMessage') this.emitEvent('message', { commandId: this.state.activeTurn?.commandId, turnId: params.turnId, text: item.text });
        if (item.type === 'plan') {
          // Codex's completed native plan is authoritative; streamed plan deltas
          // can differ. Preserve its full text for the coordinator to save after
          // the matching turn succeeds, even when no agentMessage accompanies it.
          const owner = [this.state.activeTurn, this.state.lastTurn].find(turn => turn?.id === params.turnId);
          this.emitEvent('plan', { commandId: owner?.commandId, turnId: params.turnId, itemId: item.id, text: item.text });
        }
      }
    } else if (method === 'turn/completed') {
      const active = this.state.activeTurn;
      if (!active || active.id !== params.turn.id) return;
      this.state.lastTurn = { id: active.id, kind: active.kind, commandId: active.commandId, status: params.turn.status };
      this.state.activeTurn = null;
      this.state.requests = this.state.requests.filter(request => request.turnId !== params.turn.id);
      await this.save();
      this.emitEvent('turn-completed', { ...this.state.lastTurn, success: params.turn.status === 'completed', error: params.turn.error?.message ?? null });
    } else if (method === 'error') {
      this.emitEvent('host-error', { message: params.error?.message ?? params.message ?? 'App Server reported an error.', success: false });
    }
  }
  assertReady() {
    if (!this.state.threadId || !this.loaded) throw new Error('Start or explicitly reconcile and resume this owned session first.');
    if (this.state.needsReconcile || this.fatal) throw new Error('Session requires reconciliation; do not replay the previous operation.');
  }
  assertBoundary({ successful = false } = {}) {
    this.assertReady();
    if (this.state.activeTurn || this.state.operation || this.state.requests.length || this.client.pendingRequests.length) throw new Error('A turn, operation or unconsumed input request is still pending.');
    if (successful && this.state.hasWork && this.state.lastTurn?.status !== 'completed') throw new Error('Changing mode/model/effort requires a successfully completed previous turn.');
  }
  async command(input) {
    if (!input || typeof input.id !== 'string' || !input.id.trim() || input.id.length > 160) throw new Error('Each command needs a unique nonempty string id (at most 160 characters).');
    if (this.ids.has(input.id) || this.state.lastCommandId === input.id) throw new Error('Command id was already used. Inspect status instead of replaying a command.');
    this.ids.add(input.id);
    await this.events;
    if (input.command === 'status') return this.snapshot();
    if (input.command === 'respond') return this.respond(input);
    if (input.command === 'interrupt') return this.interrupt(input);
    if (this.busy) throw new Error(`Command ${this.busy} is still pending; inspect status or interrupt its turn.`);
    this.busy = input.id;
    try {
      let result;
      switch (input.command) {
        case 'start': result = await this.start(input); break;
        case 'reconcile': result = await this.reconcile(input); break;
        case 'configure': result = await this.configure(input); break;
        case 'turn': result = await this.turn(input); break;
        case 'close': this.assertBoundary(); await this.shutdown({ clean: true }); result = { closed: true }; break;
        default: throw new Error(`Unknown managed command: ${input.command}`);
      }
      if (!this.closing) { this.state.lastCommandId = input.id; await this.save(); }
      return result;
    } finally { this.busy = null; }
  }
  async start({ id }) {
    if (this.loaded) throw new Error('This session is already loaded.');
    if (this.state.needsReconcile || this.state.operation) throw new Error('Saved operations must be reconciled before resuming. No replacement thread was created.');
    await this.connect();
    this.state.operation = { kind: this.state.threadId ? 'resume' : 'start', commandId: id }; await this.save();
    try {
      const resumed = this.state.threadId ? await this.client.resumeThread({ threadId: this.state.threadId, cwd: this.state.cwd, includeSettings: true }) : null;
      const thread = resumed?.thread ?? await this.client.startThread({ cwd: this.state.cwd });
      if (this.state.threadId && thread.id !== this.state.threadId) throw new Error('App Server returned a different thread during recovery.');
      if (resumed) {
        const settings = settingsOf(resumed);
        if (!['plan', 'default'].includes(settings.mode) || !settings.model || !settings.effort) throw new Error('The host did not return effective settings for the recovered thread. Preserve recovery instead of guessing.');
        this.state.settings = settings;
      }
      this.state.threadId = thread.id; this.state.operation = null; this.loaded = true;
      await this.save(); return { threadId: thread.id, resumed: this.state.hasWork };
    } catch (error) { this.state.needsReconcile = true; await this.save(); throw error; }
  }
  async reconcile({ expectedTurnId } = {}) {
    if (this.fatal) throw new Error('The live transport failed. Close this bridge and reconcile in a new process.');
    if (this.loaded && !this.state.needsReconcile) throw new Error('The live session owns its pending operations; use status/respond/interrupt.');
    if (!this.state.threadId) throw new Error('The initial thread creation has an unknown outcome. Locate and reconcile that host operation before starting another session; no thread was duplicated.');
    await this.connect();
    const thread = await this.client.readThread({ threadId: this.state.threadId });
    const turns = thread.turns ?? [];
    const last = turns.at(-1);
    if (last?.status === 'inProgress' || thread.status?.type === 'active') throw new Error('Host history still has active work. Reconcile its original owner before resume.');
    const known = this.state.activeTurn?.id ?? this.state.operation?.turnId;
    if (known && !turns.some(turn => turn.id === known && turn.status !== 'inProgress')) throw new Error('The uncertain turn has no terminal host receipt. Preserve recovery and inspect the original host.');
    if (this.state.operation?.kind === 'turn' && !known && (!expectedTurnId || expectedTurnId !== last?.id || expectedTurnId === this.state.operation.beforeTurnId)) {
      return { reconciled: false, reason: 'Turn submission outcome is uncertain. Inspect this host snapshot, then identify its terminal turn with expectedTurnId; never replay the prompt.', thread: { id: thread.id, status: thread.status, turns: turns.map(turn => ({ id: turn.id, status: turn.status })) } };
    }
    this.state.lastTurn = last ? { id: last.id, status: last.status, kind: 'work' } : this.state.lastTurn;
    this.state.hasWork ||= Boolean(last);
    this.state.activeTurn = null; this.state.operation = null; this.state.requests = []; this.state.needsReconcile = false;
    // Reconciliation never replays a prompt, question answer, compaction or setting
    // update. A subsequent explicit start resumes only this recorded thread.
    this.state.settings = null; await this.save();
    this.loaded = false;
    return { reconciled: true, threadId: thread.id, lastTurn: this.state.lastTurn, next: 'start' };
  }
  async configure({ id, mode, model, effort }) {
    this.assertBoundary({ successful: true });
    if (!['plan', 'default'].includes(mode) || typeof model !== 'string' || typeof effort !== 'string') throw new Error('configure requires mode (plan/default), model and effort.');
    const catalogue = await this.client.listModels();
    const selected = catalogue.find(item => item.id === model || item.model === model);
    if (!selected?.supportedReasoningEfforts?.some(item => item.reasoningEffort === effort)) throw new Error(`Requested model/effort is not advertised by this host: ${model}/${effort}. No replacement was selected.`);
    const target = { mode, model, effort };
    if (sameSettings(this.state.settings, target)) return { configured: true, unchanged: true, threadId: this.state.threadId, settings: this.state.settings };
    this.state.operation = { kind: 'configure', commandId: id, stage: this.state.hasWork ? 'compact' : 'settings', target }; await this.save();
    try {
      if (this.state.hasWork) {
        await this.client.compactThread({ threadId: this.state.threadId });
        await this.waitUntil(() => this.state.lastTurn?.id === this.state.operation?.turnId && !this.state.activeTurn);
        if (this.state.lastTurn.status !== 'completed' || !this.state.operation.compactComplete) throw new Error('Compaction did not produce its matching completed item and successful terminal turn. Settings were not changed.');
        this.state.operation.stage = 'settings'; await this.save();
      }
      await this.client.updateThreadSettings({ threadId: this.state.threadId, ...target });
      await this.waitUntil(() => Boolean(this.state.operation?.applied));
      if (!sameSettings(this.state.operation.applied, target)) throw new Error('Applied host settings do not match the requested mode/model/effort.');
      this.state.operation = null; await this.save(); return { configured: true, threadId: this.state.threadId, settings: this.state.settings };
    } catch (error) { this.state.needsReconcile = true; await this.save(); throw error; }
  }
  async turn({ id, prompt, skillPath, outputSchema }) {
    this.assertBoundary();
    if (!this.state.settings) throw new Error('Configure and verify native mode/model/effort before starting work.');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('turn requires a nonempty prompt.');
    this.state.operation = { kind: 'turn', commandId: id, beforeTurnId: this.state.lastTurn?.id ?? null }; await this.save();
    try {
      const turn = await this.client.startTurn({ threadId: this.state.threadId, cwd: this.state.cwd, prompt, skillPath, outputSchema });
      await this.events;
      if (this.state.lastTurn?.id !== turn.id) this.state.activeTurn = { id: turn.id, commandId: id, kind: 'work', status: turn.status };
      this.state.hasWork = true; this.state.operation = null; await this.save();
      return { threadId: this.state.threadId, turnId: turn.id, submitted: true, success: false };
    } catch (error) { this.state.needsReconcile = true; await this.save(); throw error; }
  }
  async respond({ requestId, response }) {
    this.assertReady();
    if (this.state.operation) throw new Error('Wait for the pending control acknowledgement before answering.');
    const record = this.state.requests.find(item => item.id === requestId && item.status === 'pending');
    if (!record) throw new Error('No unanswered request with this ID belongs to this live client. Do not replay an earlier answer.');
    if (response === undefined) throw new Error('respond requires the explicit server response object.');
    record.status = 'sent'; await this.save();
    try { await this.client.respond(requestId, response); }
    catch (error) { this.state.needsReconcile = true; await this.save(); throw error; }
    return { requestId, written: true, consumed: false, success: false };
  }
  async interrupt() {
    this.assertReady();
    if (!this.state.activeTurn) throw new Error('No owned active turn can be interrupted.');
    const turnId = this.state.activeTurn.id;
    await this.client.interrupt({ threadId: this.state.threadId, turnId });
    return { turnId, requested: true, completed: false };
  }
  async shutdown({ clean = false, beforeRelease } = {}) {
    this.closing = true; this.rejectWaiters(new Error('Bridge closed before pending operation completed.'));
    if (!clean) { this.state.needsReconcile = true; await this.save(); }
    await this.client.close(); await this.events;
    if (beforeRelease) await beforeRelease();
    this.state.clientPid = null;
    if (!clean) await this.save();
    await this.store.release({ discard: clean || (!this.state.threadId && !this.state.operation) });
  }
}

export async function runManagedBridge({ input = process.stdin, output = process.stdout, signals = process, ...options } = {}) {
  const managed = options.managed ?? new ManagedWork(options);
  const write = value => output.write(JSON.stringify(value) + '\n');
  managed.on('event', write);
  await managed.open(); write({ event: 'bridge-ready', sessionId: managed.state.sessionId, state: managed.snapshot() });
  const reader = createInterface({ input, terminal: false });
  const pending = new Set(); let stopped = false;
  await new Promise(resolveRun => {
    const stop = async clean => {
      if (stopped) return; stopped = true;
      reader.close(); signals.off('SIGINT', interrupted); signals.off('SIGTERM', interrupted);
      try { if (!clean) await managed.shutdown({ beforeRelease: () => Promise.allSettled([...pending]) }); }
      catch (error) { write({ event: 'error', message: error.message, success: false }); process.exitCode = 1; }
      await Promise.allSettled([...pending]); resolveRun();
    };
    const interrupted = () => { void stop(false); };
    signals.on('SIGINT', interrupted); signals.on('SIGTERM', interrupted);
    reader.on('line', line => {
      if (stopped) return;
      const operation = (async () => {
        let request;
        try {
          request = JSON.parse(line);
          const result = await managed.command(request); write({ id: request.id, ok: true, result });
          if (request.command === 'close') { pending.delete(operation); void stop(true); }
        } catch (error) { write({ id: request?.id ?? null, ok: false, error: error.message }); }
      })();
      pending.add(operation); operation.finally(() => pending.delete(operation));
    });
    reader.on('close', () => { if (!stopped) void stop(false); });
  });
}
