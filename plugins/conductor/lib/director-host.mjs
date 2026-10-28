import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { CodexClient } from './codex.mjs';
import { run } from './process.mjs';

function mappedStatus(status) {
  const type = status?.type;
  if (!['idle', 'active', 'interrupted', 'notLoaded', 'systemError'].includes(type)) return { type: 'unknown', activeFlags: [] };
  return { type, activeFlags: Array.isArray(status.activeFlags) ? [...status.activeFlags] : [] };
}

function isMissingThread(error) {
  return /thread.{0,30}(not found|does not exist)|(?:not found|does not exist).{0,30}thread/i.test(error?.message ?? '');
}

export class DirectorHost extends EventEmitter {
  constructor({ client, cwd, repository, model, reasoningEffort = 'medium', skillPath = fileURLToPath(new URL('../skills/director/SKILL.md', import.meta.url)), threadId, state, save, execute = run, activity, host } = {}) {
    super();
    if (typeof cwd !== 'string' || !cwd) throw new TypeError('cwd is required.');
    if (typeof repository !== 'string' || !/^[^/]+\/[^/]+$/.test(repository)) throw new TypeError('repository must be owner/name.');
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('director state is required.');
    if (typeof save !== 'function') throw new TypeError('save callback is required.');
    if (client && typeof client.connect !== 'function') throw new TypeError('client must support connect().');
    const hostMode = host ?? state.threadHostOwnership?.host ?? 'codex-app-server-daemon';
    if (!['codex-app-server-daemon', 'codex-desktop'].includes(hostMode)) throw new TypeError('host must be codex-app-server-daemon or codex-desktop.');
    if (hostMode === 'codex-desktop' && (state.threadHostOwnership?.host !== 'codex-desktop' || !state.threadHostOwnership?.threadId)) {
      throw new Error('Desktop host mode requires an explicit codex-desktop thread ownership receipt.');
    }
    Object.assign(this, { client: client ?? new CodexClient({ cwd, transport: 'proxy', experimentalApi: hostMode === 'codex-desktop' }), cwd: resolve(cwd), repository, model, reasoningEffort, skillPath, state, save, execute, activity, hostMode });
    this.threadId = threadId ?? state.threadId ?? null;
    this.codexHome = resolve(process.env.CODEX_HOME ?? `${homedir()}/.codex`);
    this.threadEnsured = false;
    this.currentStatus = { type: 'unknown', activeFlags: [] };
    this.inflightRevision = null;
    this._onNotification = ({ method, params }) => this._notification(method, params);
    this._onClientError = error => this.emit('hostError', error);
  }

  async connect() {
    try { await this.client.connect(); }
    catch (firstError) {
      if (!(this.client instanceof CodexClient) || this.client.transport !== 'proxy') throw firstError;
      await this.client.close();
      const version = await this.execute('codex', ['app-server', 'daemon', 'version'], { cwd: this.cwd, allowFailure: true });
      let running = false;
      if (version.code === 0) {
        try { running = JSON.parse(version.stdout).status === 'running'; } catch { throw new Error('Codex daemon version returned malformed status; refusing to start a second server.'); }
      }
      if (running) throw new Error(`Cannot attach to the running shared Codex App Server proxy: ${firstError.message}`);
      const started = await this.execute('codex', ['app-server', 'daemon', 'start'], { cwd: this.cwd });
      if (started.code !== 0) throw new Error(`Could not start the Codex App Server daemon: ${started.stderr || started.stdout || started.code}`);
      await this.client.close();
      this.client = new CodexClient({ cwd: this.cwd, transport: 'proxy', experimentalApi: this.hostMode === 'codex-desktop' });
      await this.client.connect();
    }
    this.client.on('notification', this._onNotification);
    this.client.on('error', this._onClientError);
    return this;
  }

  get directorName() { return `Conductor: ${this.repository}`; }

  async ensureThread() {
    if (this.hostMode === 'codex-desktop') return this._ensureDesktopThread();
    if (this.threadId) {
      const savedId = this.threadId;
      try {
        const existing = await this.client.readThread({ threadId: savedId, includeTurns: false });
        if (existing.cwd && resolve(existing.cwd) !== this.cwd) throw new Error(`Bound director thread ${savedId} belongs to ${existing.cwd}, not ${this.cwd}.`);
        if (existing.status?.type === 'notLoaded' && !this._hasOwnership(savedId)) {
          throw new Error(`Bound director thread ${savedId} is not loaded in Conductor's shared Codex daemon, and Conductor has no ownership receipt for it. This can happen when the chat belongs to Codex Desktop's separate app-server; refusing to treat it as idle or resume it. Bind a director created through Conductor's daemon.`);
        }
        if (!['idle','active','notLoaded'].includes(existing.status?.type)) throw new Error('Cannot establish the saved director runtime status; no session was resumed.');
        const thread = await this.client.resumeThread({ threadId: this.threadId, cwd: this.cwd });
        if (thread.cwd && resolve(thread.cwd) !== this.cwd) throw new Error(`Bound director thread ${this.threadId} belongs to ${thread.cwd}, not ${this.cwd}.`);
        this._recordOwnership(savedId, this._hasOwnership(savedId) ? 'created' : 'verified-loaded');
        this._setStatus(thread.status);
        await this._recordInterruptedTurn(thread);
        this.threadEnsured = true;
        return this.threadId;
      } catch (error) {
        if (!isMissingThread(error)) throw error;
        this.threadId = null;
        this.state.threadId = null;
        if (this.state.threadHostOwnership?.threadId === savedId) delete this.state.threadHostOwnership;
        await this.save();
      }
    }

    const intent = this.state.threadCreationIntent;
    if (intent) {
      if (intent.name !== this.directorName || intent.cwd !== this.cwd) throw new Error('A different director-thread creation intent is pending; inspect saved state before retrying.');
      const matches = (await this.client.listThreads({ cwd: this.cwd })).filter(thread => thread.name === intent.name && thread.cwd && resolve(thread.cwd) === this.cwd);
      if (matches.length === 1) return this._bind(matches[0]);
      if (matches.length > 1) throw new Error(`Found multiple threads named ${intent.name} in this repository: ${matches.map(thread => thread.id).join(', ')}. Resolve the duplicate before retrying.`);
      throw new Error(`Director creation outcome is uncertain for ${intent.name}. No matching thread is visible; inspect Codex sessions before retrying to avoid a duplicate.`);
    }

    const existing = (await this.client.listThreads({ cwd: this.cwd })).filter(thread => thread.name === this.directorName && thread.cwd && resolve(thread.cwd) === this.cwd);
    if (existing.length > 1) throw new Error(`Found multiple threads named ${this.directorName} in this repository: ${existing.map(thread => thread.id).join(', ')}.`);
    if (existing.length === 1) return this._bind(existing[0]);

    this.state.threadCreationIntent = { id: randomUUID(), name: this.directorName, cwd: this.cwd, createdAt: new Date().toISOString() };
    await this.save();
    const thread = await this.client.startThread({ cwd: this.cwd, model: this.model, reasoningEffort: this.reasoningEffort });
    if (!thread?.id) throw new Error('Codex App Server did not return an id for the new director thread. The creation intent is retained for reconciliation.');
    this.threadId = thread.id;
    this.state.threadId = thread.id;
    this._recordOwnership(thread.id, 'created');
    await this.save();
    await this.client.setThreadName({ threadId: thread.id, name: this.directorName });
    return this._bind({ ...thread, name: this.directorName, cwd: thread.cwd ?? this.cwd });
  }

  async _bind(thread) {
    if (!thread?.id) throw new Error('Cannot bind a director thread without its id.');
    const existing = await this.client.readThread({ threadId: thread.id, includeTurns: false });
    if (existing.cwd && resolve(existing.cwd) !== this.cwd) throw new Error(`Director thread ${thread.id} belongs to ${existing.cwd}, not ${this.cwd}.`);
    const hasOwnership = this._hasOwnership(thread.id);
    if (existing.status?.type === 'notLoaded' && !hasOwnership) throw new Error(`Thread ${thread.id} is not loaded in Conductor's shared Codex daemon and has no Conductor ownership receipt. Refusing to adopt it as an idle runner.`);
    if (!['idle','active','notLoaded'].includes(existing.status?.type)) throw new Error('Cannot establish the discovered director runtime status; no session was adopted.');
    this.threadId = thread.id;
    this.state.threadId = thread.id;
    this._recordOwnership(thread.id, hasOwnership ? 'created' : 'verified-loaded');
    await this.save();
    const resumed = await this.client.resumeThread({ threadId: this.threadId, cwd: this.cwd });
    if (resumed.cwd && resolve(resumed.cwd) !== this.cwd) throw new Error(`Director thread ${this.threadId} belongs to ${resumed.cwd}, not ${this.cwd}.`);
    delete this.state.threadCreationIntent;
    this._setStatus(resumed.status ?? thread.status);
    await this._recordInterruptedTurn(resumed);
    await this.save();
    this.threadEnsured = true;
    return this.threadId;
  }

  _hasOwnership(threadId) {
    const marker = this.state.threadHostOwnership;
    return marker?.threadId === threadId && marker.host === 'codex-app-server-daemon' && resolve(marker.codexHome ?? '') === this.codexHome;
  }

  _recordOwnership(threadId, kind) {
    this.state.threadHostOwnership = { threadId, host: 'codex-app-server-daemon', codexHome: this.codexHome, kind, establishedAt: this.state.threadHostOwnership?.threadId === threadId ? this.state.threadHostOwnership.establishedAt : new Date().toISOString() };
  }

  async status() {
    if (!this.threadId) return { type: 'notLoaded', activeFlags: [] };
    if (this.hostMode === 'codex-desktop') {
      if (!this.activity || typeof this.activity.read !== 'function') {
        const unknown = { type: 'unknown', activeFlags: [], error: 'Desktop activity adapter is unavailable.' };
        this._publishStatus(unknown);
        return unknown;
      }
      try {
        const observed = await this.activity.read(this.threadId);
        const type = observed?.state;
        if (!['active', 'idle', 'interrupted'].includes(type)) {
          const unknown = { type: 'unknown', activeFlags: [] };
          this._publishStatus(unknown);
          return unknown;
        }
        const next = {
          type,
          activeFlags: [],
          nativeTurnId: observed.nativeTurnId ?? observed.turnId ?? null,
          wakeupMarker: observed.wakeupMarker ?? null,
        };
        this._publishStatus(next);
        return { ...next };
      } catch (error) {
        const unknown = { type: 'unknown', activeFlags: [], error: error.message };
        this._publishStatus(unknown);
        return unknown;
      }
    }
    try {
      const thread = await this.client.readThread({ threadId: this.threadId, includeTurns: false });
      if (thread.cwd && resolve(thread.cwd) !== this.cwd) return { type: 'unknown', activeFlags: [] };
      this._setStatus(thread.status);
      return { ...this.currentStatus };
    } catch (error) {
      if (isMissingThread(error)) return { type: 'notLoaded', activeFlags: [] };
      return { type: 'unknown', activeFlags: [], error: error.message };
    }
  }

  async inspectTurn(turnId) {
    if (!this.threadId) throw new Error('No director thread is bound.');
    if (typeof turnId !== 'string' || !turnId) throw new TypeError('turnId is required.');
    const thread = await this.client.readThread({ threadId: this.threadId, includeTurns: true });
    const turn = (thread.turns ?? []).find(item => item.id === turnId);
    return turn ? structuredClone(turn) : null;
  }

  async markTurnReconciled(turnId, outcome = 'inspected') {
    const recovery = this.state.recoveryRequired;
    if (!recovery || recovery.turnId !== turnId) throw new Error('The requested turn does not match the saved director recovery marker.');
    recovery.resolvedAt = new Date().toISOString();
    recovery.outcome = outcome;
    await this.save();
    return structuredClone(recovery);
  }

  async startRunner({ prompt = 'Check the configured repository for actionable Conductor work. Reconcile current state, work only within existing authority, and go idle when there is nothing actionable.', revision = null } = {}) {
    if (!this.threadEnsured) await this.ensureThread();
    const threadId = this.threadId;
    if (this.state.recoveryRequired && !this.state.recoveryRequired.resolvedAt) throw Object.assign(new Error(`Director recovery is required for turn ${this.state.recoveryRequired.turnId ?? 'unknown'} (${this.state.recoveryRequired.status ?? 'uncertain'}). Inspect the saved turn before continuing.`), { code: 'DIRECTOR_RECOVERY_REQUIRED' });
    const status = await this.status();
    if (status.type !== 'idle') throw Object.assign(new Error(status.type === 'unknown' || status.type === 'systemError' ? 'Director status is unavailable; refusing to send a duplicate wakeup.' : `Director is ${status.type}; wakeup was suppressed.`), { code: status.type === 'unknown' || status.type === 'systemError' ? 'DIRECTOR_UNAVAILABLE' : 'DIRECTOR_BUSY' });
    if (this.inflightRevision !== null && this.inflightRevision === revision) throw Object.assign(new Error('This director wakeup revision is already in flight.'), { code: 'DIRECTOR_BUSY' });
    this.inflightRevision = revision ?? randomUUID();
    try {
      if (this.hostMode === 'codex-desktop') {
        if (typeof revision !== 'string' || !revision) throw Object.assign(new Error('Desktop wakeup requires the persisted batch ID as its revision so uncertain queue submissions can be reconciled.'), { code: 'DIRECTOR_UNAVAILABLE' });
        const marker = `<!-- conductor:director-wakeup:${revision} -->`;
        const clientMessageId = `conductor-director-${revision}`;
        const message = `$conductor:director\n\n${marker}\n${prompt}`;
        const queuedSubmission = await this.client.addQueuedMessage({ threadId, text: message, clientUserMessageId: clientMessageId });
        if (typeof queuedSubmission.id !== 'string' || !queuedSubmission.id) throw new Error('Codex accepted the Desktop wake request without returning its queue item ID; inspect the saved marker before retrying.');
        this.currentStatus = { type: 'active', activeFlags: [], nativeTurnId: null, wakeupMarker: marker };
        this.emit('status', { threadId, ...this.currentStatus });
        return { queued: true, id: queuedSubmission.id, clientMessageId, marker };
      }
      const turn = await this.client.startTurn({ threadId, cwd: this.cwd, prompt, skillPath: this.skillPath });
      if (!turn?.id) throw new Error('Codex App Server did not return a turn id; inspect the director thread before retrying.');
      this.currentStatus = { type: 'active', activeFlags: [] };
      this.emit('status', { threadId, ...this.currentStatus });
      return turn;
    } catch (error) {
      // A transport failure may have occurred after the daemon accepted turn/start.
      // Keep the revision latched until a status/reconciliation observation resolves it.
      if (error.code !== undefined) this.inflightRevision = null;
      throw error;
    }
  }

  async close() {
    this.client.off('notification', this._onNotification);
    this.client.off('error', this._onClientError);
    await this.client.close();
  }

  _notification(method, params) {
    if (this.hostMode === 'codex-desktop') return;
    if (!params || params.threadId !== this.threadId) return;
    if (method === 'thread/status/changed') this._setStatus(params.status);
    if (method === 'turn/completed') {
      this.inflightRevision = null;
      this.emit('completed', params.turn);
    }
  }

  async _recordInterruptedTurn(thread) {
    const turns = thread.turns?.length ? thread.turns : (await this.client.readThread({ threadId: this.threadId, includeTurns: true })).turns;
    const latest = turns?.at(-1);
    if (!latest || !['interrupted', 'failed', 'error'].includes(latest.status)) return;
    if (this.state.recoveryRequired?.turnId === latest.id) return;
    this.state.recoveryRequired = { threadId: this.threadId, turnId: latest.id, status: latest.status, detectedAt: new Date().toISOString() };
    await this.save();
  }

  _setStatus(status) {
    const next = mappedStatus(status);
    this._publishStatus(next);
  }

  _publishStatus(next) {
    const prior = this.currentStatus;
    this.currentStatus = next;
    if (next.type === 'idle') this.inflightRevision = null;
    if (prior.type !== next.type || prior.activeFlags.join(',') !== next.activeFlags.join(',')) {
      this.emit('status', { threadId: this.threadId, ...next });
    }
  }

  async _ensureDesktopThread() {
    const ownership = this.state.threadHostOwnership;
    const threadId = this.threadId ?? ownership?.threadId;
    if (!threadId || ownership?.threadId !== threadId || ownership?.host !== 'codex-desktop') {
      throw new Error('No explicitly bound Codex Desktop director thread is saved. Create/open the director thread in Codex Desktop and bind its thread UUID before enabling Desktop wakeups.');
    }
    let existing;
    try {
      existing = await this.client.readThread({ threadId, includeTurns: false });
    } catch (error) {
      if (isMissingThread(error)) throw new Error(`Saved Codex Desktop director thread ${threadId} no longer exists. Create a new director in Codex Desktop and explicitly rebind it; Conductor will not create a replacement on the shared daemon.`);
      throw error;
    }
    if (typeof existing.cwd !== 'string' || resolve(existing.cwd) !== this.cwd) throw new Error(`Bound Codex Desktop director thread ${threadId} belongs to ${existing.cwd ?? 'an unknown working directory'}, not ${this.cwd}.`);
    if (!['idle', 'active', 'interrupted', 'notLoaded'].includes(existing.status?.type)) throw new Error('Cannot validate the Codex Desktop director thread metadata; refusing to queue input.');
    this.threadId = threadId;
    this.state.threadId = threadId;
    // Fail readiness if the shared daemon cannot access the native queue; the
    // Desktop thread itself remains unloaded and is never resumed here.
    await this.client.listQueuedMessages({ threadId });
    await this.save();
    this.threadEnsured = true;
    return threadId;
  }

  async findQueuedWakeup(marker) {
    if (this.hostMode !== 'codex-desktop') throw new Error('Queued wakeup inspection is available only for a Codex Desktop director.');
    if (!this.threadId) throw new Error('No Desktop director thread is bound.');
    if (typeof marker !== 'string' || !marker) throw new TypeError('marker is required.');
    const queued = await this.client.listQueuedMessages({ threadId: this.threadId });
    return queued.find(item => JSON.stringify(item).includes(marker)) ?? null;
  }

  async validateDesktopThread(threadId) {
    if (this.hostMode !== 'codex-desktop') throw new Error('Desktop chat validation is available only for a Desktop director.');
    if (typeof threadId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(threadId)) throw new TypeError('threadId must be an existing chat UUID.');
    const thread = await this.client.readThread({ threadId, includeTurns: false });
    if (typeof thread.cwd !== 'string' || resolve(thread.cwd) !== this.cwd) throw new Error(`Desktop chat ${threadId} belongs to ${thread.cwd ?? 'an unknown working directory'}, not ${this.cwd}.`);
    if (!['idle', 'active', 'interrupted', 'notLoaded'].includes(thread.status?.type)) throw new Error(`Desktop chat ${threadId} has an unknown native status; refusing to attach.`);
    await this.client.listQueuedMessages({ threadId });
    return { id: threadId, cwd: this.cwd, status: thread.status.type };
  }

  async cancelQueuedWakeup(queueItemId) {
    if (this.hostMode !== 'codex-desktop') throw new Error('Queued wakeup cancellation is available only for a Codex Desktop director.');
    if (!this.threadId) throw new Error('No Desktop director thread is bound.');
    if (typeof queueItemId !== 'string' || !queueItemId) throw new TypeError('queueItemId is required.');
    return this.client.deleteQueuedMessage({ threadId: this.threadId, queuedSubmissionId: queueItemId });
  }
}
