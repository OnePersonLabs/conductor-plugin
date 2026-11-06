import { EventEmitter } from 'node:events';
import { mkdir, access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hostname, homedir } from 'node:os';
import { CodexClient } from './codex.mjs';
import { GitHub, checkState, deliveryWaitReason } from './github.mjs';
import { git, run } from './process.mjs';
import { createWorktree, copyWorktreeIncludes, refreshBranch, inspectRepository } from './worktrees.mjs';
import { processExists } from './state.mjs';
import { WakeLoop, admission, occupied } from './scheduler.mjs';
import { Director } from './director.mjs';
import { DirectorHost } from './director-host.mjs';
import { watch } from 'node:fs';
import { builderPrompt, createRequestRevision, parseResult, parseReviewResult, reviewPrompt, resultSchema, reviewResultSchema } from './prompts.mjs';
import { validateDesignHandoff } from './design-handoff.mjs';
import { runnerPause, RUNNER_PAUSED_MESSAGE } from './runner-state.mjs';
import { cleanupWorktrees } from './cleanup.mjs';

const skillPath = fileURLToPath(new URL('../skills/implement/SKILL.md', import.meta.url));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const activePhases = new Set(['building','reviewing','launching','starting','preparing']);

export class Coordinator extends EventEmitter {
  constructor({ repo, config, store, github, Client = CodexClient, Host = DirectorHost, execute = run, workspace = { createWorktree, copyWorktreeIncludes, refreshBranch } }) {
    super(); Object.assign(this, { repo, config, store, Client, Host, execute, workspace });
    this.github = github ?? new GitHub(config.repository, { cwd: repo.root, beforeWrite: () => this.assertRunning() });
    this.clients = new Map(); this.tasks = new Map(); this.requests = new Map(); this.preparations = new Map();
    this.controls = new Set();
    this.handoffChecks = new Map();
    this.stopping = false; this.scanError = null;
    this.lastCleanupAt = 0;
    this.delivery = Promise.resolve(); this.ready = false;
    this.loop = new WakeLoop(() => this.scan(), error => {
      this.scanError = error.message; this.emit('notice', `Reconciliation failed: ${error.message}`);
      if (this.director) this.director.events.observe('service-error', error.message, { kind: 'service-error' })
        .then(() => this.director.events.flush()).catch(failure => this.emit('notice', failure.message));
    });
  }
  async save() { await this.store.save(this.state); this.emit('status', this.state); }
  async start({ beforeScan, threadId, enable = false, manualWake = false, host, attachOnly = false, handoffThreadId, resumeRunner = false } = {}) {
    const previousOwner = await this.store.owner?.() ?? null;
    await this.store.acquire();
    try {
      this.state = await this.store.read();
      const pause = runnerPause(this.state, previousOwner);
      if (pause) {
        this.state.runnerPause ??= { reason: pause.reason, at: new Date().toISOString() };
        if (this.state.director) this.state.director.enabled = false;
        this.state.serviceReady = false;
        this.recordInterruptedJobs();
        await this.save();
      }
      await this.store.cleanupOwned();
      await this.store.cleanupMigrationBackups(this.repo.root, Date.now(), this.config.version === 2);
      if (this.state.repository && this.state.repository !== this.config.repository) throw new Error('Recovery state belongs to another GitHub repository. Resolve configuration before proceeding.');
      const environment = { platform: process.platform, host: hostname(), codexHome: resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex')) };
      if (this.state.environment && JSON.stringify(this.state.environment) !== JSON.stringify(environment) && this.state.jobs.some(job => !['complete','cancelled'].includes(job.phase))) throw new Error('Unfinished builders belong to a different OS or Codex home. Resume in that environment; no replacement builder was started.');
      this.state.environment = environment;
      this.state.repository = this.config.repository; this.state.root = this.repo.root;
      await this.cleanupCompletedWorktrees();
      this.state.serviceReady = false;
      this.state.ownerToken = this.store.token;
      delete this.state.startupError;
      await this.preflight();
      if (this.stopping) return;
      if (this.config.version === 2) {
        this.state.director ??= {};
        this.state.director.attachProtocol = 1;
        if (threadId && this.state.director.threadId && threadId !== this.state.director.threadId && !handoffThreadId) throw new Error('Repository already has a different designated director.');
        const hostMode = host === 'desktop' ? 'codex-desktop' : host === 'daemon' ? 'codex-app-server-daemon' : this.state.director.threadHostOwnership?.host;
        if (hostMode && this.state.director.threadHostOwnership?.host && hostMode !== this.state.director.threadHostOwnership.host) throw new Error('A bound director cannot be moved between app-server hosts. Preserve the existing host.');
        this.state.runtimeEnabled ??= Boolean(this.state.director.threadId);
        if (enable) this.state.runtimeEnabled = true;
        if (!this.state.runtimeEnabled) throw new Error('Repository runtime is not enabled. Use conductor enable.');
        if (threadId && (!this.state.director.threadId || threadId === this.state.director.threadId)) this.state.director.threadId = threadId;
        if (hostMode === 'codex-desktop') {
          if (!this.state.director.threadId) throw new Error('Create the director with the native Desktop task tool, then enable with its thread UUID.');
          this.state.director.threadHostOwnership = { threadId: this.state.director.threadId, host: hostMode, codexHome: environment.codexHome };
          const { DirectorActivity } = await import('./director-activity.mjs');
          if (this.stopping) return;
          this.directorActivity = new DirectorActivity({ dir: this.store.dir });
        }
        if (this.stopping) return;
        await this.save();
        if (this.stopping) return;
        this.directorHost = new this.Host({ cwd: this.repo.root, repository: this.config.repository,
          model: this.config.directorModel, state: this.state.director, save: () => this.save(), execute: this.execute, activity: this.directorActivity });
        this.hostStartup = (async () => {
          await this.directorHost.connect();
          if (this.stopping) return null;
          return this.directorHost.ensureThread();
        })();
        const bound = await this.hostStartup;
        this.hostStartup = null;
        if (this.stopping) return;
        if (this.directorActivity) await this.directorActivity.pruneExcept([bound, ...(this.state.director.handoff?.toThreadId ? [this.state.director.handoff.toThreadId] : [])]);
        if (this.stopping) return;
        this.director = new Director(this, bound);
        await this.director.events.start();
        this.directorHost.on('completed', turn => {
          if (this.stopping) return;
          for (const batch of this.state.director.batches) if (batch.turnId === turn.id) {
            batch.turnStatus = turn.status; batch.terminalAt = new Date().toISOString();
            if (batch.observation) batch.acknowledgedAt = batch.terminalAt;
          }
          if (turn.status !== 'completed') this.state.director.recoveryRequired = { threadId: this.state.director.threadId, turnId: turn.id, status: turn.status, detectedAt: new Date().toISOString() };
          this.director.events.pruneSettled();
          this.save().then(() => this.director.events.flush()).catch(error => this.emit('notice', error.message));
        });
        this.directorHost.on('status', status => {
          if (!this.stopping && status.type === 'idle') this.director.events.flush().catch(error => this.emit('notice', error.message));
        });
      }
      if (this.stopping) return;
      this.state.running = true; this.state.pid = process.pid; this.state.pollMs = this.config.pollMs; this.state.agents = this.config.agents;
      for (const job of this.state.jobs) {
        job.intent = job.phase === 'cancelling' ? 'cancel' : job.phase === 'paused' || job.intent === 'pause' ? 'pause' : null;
        if (job.runnerInterrupted) {
          this.settleRunnerInterruption(job);
          continue;
        }
        if (activePhases.has(job.phase)) {
          job.recoveryPhase = job.phase;
          job.builderThreadId ??= job.threadId ?? null;
          job.activeRole ??= 'builder';
          const savedThread = job.activeRole === 'reviewer' ? job.reviewerThreadId : job.builderThreadId;
          if (!savedThread || (job.childPid && processExists(job.childPid))) {
            job.phase = 'uncertain'; job.summary = `Previous ${job.activeRole} launch/process ownership is uncertain; resolve it before starting another session.`;
          } else { job.phase = this.director ? 'paused' : 'stopped'; job.intent = this.director ? 'pause' : null; job.turnId = null; job.childPid = null; job.nextRole ??= job.activeRole; }
        }
      }
      await this.save();
      if (this.stopping) return;
      if (handoffThreadId) await this.attachThread(handoffThreadId);
      await beforeScan?.();
      if (this.stopping) return;
      this.ready = false;
      this.state.serviceReady = false; await this.save();
      if (this.stopping) return;
      if (this.directorActivity) {
        const refresh = () => this.refreshDirectorActivity().catch(error => this.emit('notice', `Director activity: ${error.message}`));
        this.activityWatcher = watch(this.store.dir, (_event, name) => { if (String(name).startsWith('director-activity.sqlite')) refresh(); });
        // Local receipt fallback covers missed filesystem notifications. It never
        // polls GitHub or invokes a model unless a native idle transition exists.
        this.activityTimer = setInterval(refresh, 1000);
      }
      if (this.directorActivity) await this.refreshDirectorActivity();
      if (this.stopping) return;
      this.ready = true;
      this.state.serviceReady = true; await this.save();
      if (this.stopping) return;
      this.timer = setInterval(() => this.wake(), this.config.pollMs);
      if (resumeRunner) await this.resumeRunner();
      else if (!attachOnly && !handoffThreadId) {
        if (manualWake && !runnerPause(this.state)) await this.director.releaseInteractionForWakeup();
        if (manualWake || (enable && !runnerPause(this.state))) await this.requestCheck({ manual: true });
        else await this.wake();
      }
    } catch (error) { if (this.stopping) return; clearInterval(this.timer); this.activityWatcher?.close(); clearInterval(this.activityTimer); this.directorActivity?.close(); await this.directorHost?.close().catch(() => {}); if (this.state) { this.state.running = false; this.state.serviceReady = false; this.state.startupError = error.message; await this.save().catch(() => {}); } await this.store.release(); throw error; }
  }
  async preflight() {
    const remote = await git(this.repo.root, 'remote', 'get-url', 'origin');
    const repoName = remote.replace(/\.git$/, '').match(/(?:github\.com[:/])([^/]+\/[^/]+)$/)?.[1];
    if (repoName?.toLowerCase() !== this.config.repository.toLowerCase()) throw new Error('origin does not match configured repository; no work started.');
    await this.github.gh(['auth', 'status']);
    await git(this.repo.root, 'check-ref-format', '--branch', this.config.baseBranch);
    await access(skillPath);
  }
  wake() {
    if (!this.ready || this.stopping || runnerPause(this.state) || this.state?.director?.handoff) return Promise.resolve();
    const now = Date.now();
    const cleanup = now - this.lastCleanupAt >= 60_000
      ? (this.lastCleanupAt = now, this.store.cleanupOwned().then(() => this.cleanupCompletedWorktrees()).catch(error => this.emit('notice', `Retention cleanup: ${error.message}`)))
      : Promise.resolve();
    return cleanup.then(() => this.loop.wake());
  }
  cleanupCompletedWorktrees() {
    if (this.worktreeCleanup) return this.worktreeCleanup;
    this.lastCleanupAt = Date.now();
    this.worktreeCleanup = cleanupWorktrees({ repoRoot: this.repo.root, jobs: this.state.jobs,
      busyIssues: new Set([...this.clients.keys(), ...this.tasks.keys(), ...this.preparations.keys()]),
      holds: this.state.holds, resolveParents: issue => this.github.parents(issue),
      save: () => this.save(), notice: message => this.emit('notice', message),
    }).catch(error => { this.emit('notice', `Worktree cleanup failed: ${error.message}`); })
      .finally(() => { this.worktreeCleanup = null; });
    return this.worktreeCleanup;
  }
  async refreshDirectorActivity() {
    if (!this.directorActivity || this.stopping || this.activityRefreshing) return;
    this.activityRefreshing = true;
    try {
      const threadId = this.state.director.threadId;
      const reconciled = await this.reconcileBlockedWakeups(threadId);
      const activity = await this.directorActivity.read(threadId);
      if (this.stopping) return;
      if (this.activityRevision === activity.revision) {
        if (this.state.director.handoff) await this.progressHandoff(activity);
        else if (reconciled && activity.state === 'idle') await this.director.events.flush();
        return;
      }
      this.activityRevision = activity.revision;
      if (this.state.director.threadHostOwnership?.lifecycleBaseline && activity.state !== 'unknown') delete this.state.director.threadHostOwnership.lifecycleBaseline;
      this.state.director.nativeActivity = activity;
      const recovery = this.state.director.recoveryRequired;
      if (activity.state === 'interrupted') this.state.director.recoveryRequired = { native: true, turnId: activity.turnId, status: 'interrupted' };
      else if (activity.state === 'active' && recovery?.native && activity.turnId !== recovery.turnId) {
        recovery.resolvedAt = new Date().toISOString(); recovery.outcome = 'A new native Desktop turn resumed the director.';
      }
      if (activity.wakeupMarker) {
        const batch = this.state.director.batches.find(item => item.id === activity.wakeupMarker);
        if (batch && ['submitting','uncertain','queued'].includes(batch.status)) {
          batch.status = 'queued'; batch.turnId = activity.turnId; batch.nativeConsumed = true;
          if (recovery?.status === 'lifecycle-receipt-missing' && recovery.batchId === batch.id) {
            recovery.resolvedAt = new Date().toISOString();
            recovery.outcome = 'Matching native lifecycle receipt arrived.';
          }
        }
      }
      if (activity.state === 'idle' && activity.turnId) {
        for (const batch of this.state.director.batches) if (batch.turnId === activity.turnId) {
          batch.turnStatus = 'completed'; batch.terminalAt = new Date().toISOString();
          if (batch.observation) batch.acknowledgedAt = batch.terminalAt;
        }
        this.director.events.pruneSettled();
      }
      await this.save();
      if (this.state.director.handoff) await this.progressHandoff(activity);
      if (activity.state === 'idle' && !this.state.director.handoff) await this.director.events.flush();
    } finally { this.activityRefreshing = false; }
  }
  async reconcileBlockedWakeups(threadId) {
    const receipts = this.directorActivity.blockedWakeups?.(threadId) ?? [];
    if (!receipts.length) return false;
    // A Desktop queue response can arrive after its prompt was rejected.
    // Reconcile only after submission has finished recording its outcome.
    await this.director.events.flushing;
    if (this.stopping) return false;
    const director = this.state.director;
    for (const receipt of receipts) {
      const batch = director.batches.find(item => item.id === receipt.batchId && item.threadId === threadId);
      if (!batch) continue;
      batch.status = 'reconciled-ended';
      batch.nativeConsumed = true;
      batch.blockedWakeup = { turnId: receipt.turnId, at: receipt.blockedAt };
      batch.terminalAt = receipt.blockedAt;
      if (batch.observation) batch.acknowledgedAt ??= receipt.blockedAt;
      delete batch.cancellationRequired;
      const recovery = director.recoveryRequired;
      if (recovery?.batchId === batch.id && !recovery.resolvedAt) {
        recovery.resolvedAt = receipt.blockedAt;
        recovery.outcome = 'The Desktop lifecycle hook blocked this queued wake before execution.';
      }
    }
    this.director.events.pruneSettled();
    await this.save();
    if (!this.stopping) for (const receipt of receipts) this.directorActivity.clearBlockedWakeup(threadId, receipt.batchId);
    return true;
  }
  async requestCheck({ manual = false, reason } = {}) {
    if (!this.director) throw new Error('Director is not bound.');
    if (this.stopping || this.runnerStopRequested) return { status: 'runner-paused' };
    const pause = runnerPause(this.state);
    if (pause && !manual) return { status: 'runner-paused' };
    if (this.state.director.handoff) return { status: 'handoff-pending', handoff: structuredClone(this.state.director.handoff) };
    if (manual) {
      await this.refreshDirectorActivity();
      // An explicit wake can continue a known ended director turn, but an
      // uncertain submission still needs its receipt reconciled before retry.
      if (this.directorHost && !this.directorActivity && (await this.directorHost.status()).type === 'idle') {
        for (const batch of this.state.director.batches) {
          if (batch.status !== 'queued' || !batch.turnId) continue;
          const turn = await this.directorHost.inspectTurn(batch.turnId);
          if (turn && ['completed','interrupted','failed'].includes(turn.status)) {
            batch.turnStatus = turn.status;
            batch.terminalAt = new Date().toISOString();
            batch.status = 'reconciled-ended';
            if (batch.observation) batch.acknowledgedAt = batch.terminalAt;
          }
        }
        this.director.events.pruneSettled();
        const recovery = this.state.director.recoveryRequired;
        if (recovery?.turnId && !recovery.resolvedAt) {
          const turn = await this.directorHost.inspectTurn(recovery.turnId);
          if (turn && ['completed','interrupted','failed','error'].includes(turn.status)) await this.directorHost.markTurnReconciled(turn.id, 'Explicit manual wake after inspecting terminal turn.');
        }
      }
      if (typeof this.state.director.recoveryRequired === 'string') this.state.director.recoveryRequired = null;
      await this.director.events.start();
    } else if (!this.state.runtimeEnabled || !this.state.director.enabled) return { status: 'disabled' };
    await this.director.events.emit({ kind: 'check-requested', reason });
    // Scan first so the director receives a current tracker snapshot.
    if (pause) await this.director.observe();
    else await this.wake();
    return this.director.events.flush({ observation: pause });
  }
  control(request) {
    const pending = this._control(request).finally(() => this.controls.delete(pending));
    this.controls.add(pending);
    return pending;
  }
  async _control(request) {
    if (!this.director) throw new Error('Migrate to version 2 and bind a director first.');
    if (request.op !== 'stop' && (this.stopping || this.runnerStopRequested)) throw new Error(RUNNER_PAUSED_MESSAGE);
    if (request.op === 'attach') return this.director.control(request);
    this.directorControlCount = (this.directorControlCount ?? 0) + 1;
    try {
      const result = await this.director.control(request);
      if (request.op !== 'stop') await this.director.events.flush();
      return result;
    } finally {
      this.directorControlCount--;
      if (!this.stopping && !this.directorControlCount && this.state.director.handoff) this.progressHandoff(await this.directorActivity.read(this.state.director.handoff.fromThreadId)).catch(error => this.emit('notice', `Director handoff: ${error.message}`));
    }
  }
  async attachThread(targetThreadId) {
    const director = this.state.director;
    if (!this.directorHost || this.directorHost.hostMode !== 'codex-desktop') throw new Error('Chat handoff requires the repository director to use the Desktop native queue.');
    if (typeof targetThreadId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetThreadId)) throw new TypeError('Destination must be an existing Desktop chat UUID.');
    if (director.handoff && director.handoff.toThreadId !== targetThreadId) throw new Error(`A handoff to ${director.handoff.toThreadId} is already pending; resolve it before choosing another chat.`);
    await this.directorHost.validateDesktopThread(targetThreadId);
    if (!director.threadId) {
      const target = await this.directorHost.validateDesktopThread(targetThreadId);
      director.threadId = targetThreadId; director.threadHostOwnership = { threadId: targetThreadId, host: 'codex-desktop', kind: 'attached', codexHome: resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex')), lifecycleBaseline: await this.directorActivity.read(targetThreadId) };
      this.state.threadId = targetThreadId; this.state.runtimeEnabled = true; this.directorHost.threadId = targetThreadId; this.directorHost.threadEnsured = true;
      director.nativeActivity = await this.directorActivity.read(targetThreadId);
      this.activityRevision = null;
      await this.save();
      await this.directorActivity.pruneExcept([targetThreadId]);
      return { status: 'attached', threadId: target.id, nativeStatus: director.nativeActivity.state };
    }
    if (director.threadId === targetThreadId && !director.handoff) {
      this.state.runtimeEnabled = true; await this.director.events.start(); await this.save();
      return { status: 'already-attached', threadId: targetThreadId };
    }
    if (!director.handoff) {
      const oldActivity = await this.directorActivity.read(director.threadId);
      director.handoff = { fromThreadId: director.threadId, toThreadId: targetThreadId, status: oldActivity.state === 'active' ? 'waiting-turn' : 'blocked', turnId: oldActivity.state === 'unknown' ? null : oldActivity.turnId, requestedAt: new Date().toISOString(), blocker: oldActivity.state === 'unknown' ? 'The old Desktop chat has no lifecycle receipt; inspect or recover its native activity before switching.' : null };
      await this.save();
    }
    const result = await this.progressHandoff(await this.directorActivity.read(director.threadId));
    return result;
  }
  async progressHandoff(activity) {
    if (this.stopping || this.handoffProgress) return { status: 'handoff-pending', handoff: structuredClone(this.state.director.handoff) };
    this.handoffProgress = this._progressHandoff(activity);
    try { return await this.handoffProgress; }
    finally { this.handoffProgress = null; }
  }
  async _progressHandoff(activity) {
    const director = this.state.director, handoff = director?.handoff;
    if (!handoff) return { status: 'unchanged' };
    const pending = async (blocker, status = handoff.status) => {
      if (handoff.status !== status || handoff.blocker !== blocker) {
        handoff.status = status; handoff.blocker = blocker; await this.save();
      }
      return { ...structuredClone(handoff), handoffStatus: handoff.status, status: 'handoff-pending' };
    };
    if (this.director?.events?.flushing) {
      await Promise.allSettled([this.director.events.flushing]);
      activity = await this.directorActivity.read(handoff.fromThreadId);
    }
    await this.reconcileBlockedWakeups(handoff.fromThreadId);
    if (this.directorControlCount > 0) {
      return pending('Waiting for the current director control operation to finish.');
    }
    if (handoff.status === 'waiting-turn') {
      if (activity.state === 'active' && activity.turnId === handoff.turnId) return { status: 'handoff-pending', fromThreadId: handoff.fromThreadId, toThreadId: handoff.toThreadId, turnId: handoff.turnId, blocker: 'Waiting for the current native turn to end.' };
      if (!['idle', 'interrupted'].includes(activity.state) || activity.turnId !== handoff.turnId) {
        return pending(`Expected terminal receipt for turn ${handoff.turnId}; observed ${activity.state} turn ${activity.turnId ?? 'unknown'}.`, 'blocked');
      }
    } else {
      if (activity.state === 'active') {
        if (!handoff.turnId && activity.turnId) handoff.turnId = activity.turnId;
        return pending(handoff.turnId ? `Waiting for matching terminal receipt for turn ${handoff.turnId}.` : 'Old chat activity is active without a turn ID; inspect its native lifecycle receipt.', handoff.turnId ? 'waiting-turn' : 'blocked');
      }
      if (activity.state === 'unknown') {
        return pending('The old Desktop chat has no native lifecycle receipt; switch remains pending until its actual terminal status is recorded.');
      }
      if (!activity.turnId || (handoff.turnId && activity.turnId !== handoff.turnId)) {
        return pending(`Expected terminal receipt for turn ${handoff.turnId ?? 'unknown'}; observed ${activity.state} turn ${activity.turnId ?? 'unknown'}.`);
      }
    }
    handoff.status = 'switching'; handoff.blocker = null; await this.save();
    let target, bindingCommitted = false;
    const originalOwnership = structuredClone(director.threadHostOwnership ?? null);
    const originalNativeActivity = structuredClone(director.nativeActivity ?? null);
    const originalActivityRevision = this.activityRevision;
    try {
      let queued = await this.directorHost.client.listQueuedMessages({ threadId: handoff.fromThreadId });
      for (const batch of director.batches.filter(item => item.threadId === handoff.fromThreadId && ['submitting','queued','uncertain'].includes(item.status))) {
        const marker = `<!-- conductor:director-wakeup:${batch.id} -->`;
        let item = queued.find(entry => JSON.stringify(entry).includes(marker));
        const consumed = batch.nativeConsumed === true && batch.turnId === handoff.turnId && activity.turnId === batch.turnId && ['idle','interrupted'].includes(activity.state);
        if (item && batch.queueCancellationConfirmed) throw new Error(`Old wake batch ${batch.id} was marked cancelled but is still visible in the queue.`);
        if (item) {
          batch.queueItemId = item.id;
          const cancelled = await this.director.events.cancelWake(batch);
          queued = await this.directorHost.client.listQueuedMessages({ threadId: handoff.fromThreadId });
          item = queued.find(entry => JSON.stringify(entry).includes(marker));
          const terminalConsumed = batch.nativeConsumed === true && batch.turnId === handoff.turnId && activity.turnId === batch.turnId && ['idle','interrupted'].includes(activity.state);
          if (item) throw new Error(`Obsolete wake batch ${batch.id} remains queued in the old chat.`);
          if (!cancelled && !terminalConsumed) throw new Error(`Cancellation of old wake batch ${batch.id} was not confirmed and no matching terminal consumption receipt exists.`);
          if (!cancelled && terminalConsumed && this.state.director.recoveryRequired?.batchId === batch.id) {
            this.state.director.recoveryRequired.resolvedAt = new Date().toISOString();
            this.state.director.recoveryRequired.outcome = 'The matching native terminal receipt confirmed the queued wake was consumed before handoff.';
          }
        } else if (!batch.queueCancellationConfirmed && !consumed) throw new Error(`Old wake batch ${batch.id} is absent from the queue without a matching terminal consumption receipt.`);
        batch.status = 'reconciled-not-queued'; batch.handoffAt = new Date().toISOString(); delete batch.queueItemId;
      }
      queued = await this.directorHost.client.listQueuedMessages({ threadId: handoff.fromThreadId });
      const orphanWake = queued.find(entry => JSON.stringify(entry).includes('<!-- conductor:director-wakeup:'));
      if (orphanWake) throw new Error(`Old chat has an unowned Conductor wake queue item ${orphanWake.id ?? 'with no queue ID'}; reconcile it before switching.`);

      target = await this.directorHost.validateDesktopThread(handoff.toThreadId);
      const baseline = await this.directorActivity.read(handoff.toThreadId);
      const attachKey = `director-attached:${handoff.fromThreadId}:${handoff.toThreadId}:${handoff.requestedAt}`;
      if (!director.events.some(item => item.dedupeKey === attachKey)) {
        await this.director.events.emit({ kind: 'director-attached', fromThreadId: handoff.fromThreadId, threadId: handoff.toThreadId, dedupeKey: attachKey });
      }
      const latestOld = await this.directorActivity.read(handoff.fromThreadId);
      if (!['idle', 'interrupted'].includes(latestOld.state) || latestOld.turnId !== handoff.turnId) {
        if (latestOld.state === 'active' && latestOld.turnId) handoff.turnId = latestOld.turnId;
        const status = latestOld.state === 'active' && latestOld.turnId ? 'waiting-turn' : 'blocked';
        return pending(`Old chat changed during queue reconciliation; expected terminal receipt for turn ${handoff.turnId ?? 'unknown'}, observed ${latestOld.state} turn ${latestOld.turnId ?? 'unknown'}.`, status);
      }
      if (director.recoveryRequired?.turnId && director.recoveryRequired.turnId === handoff.turnId && !director.recoveryRequired.resolvedAt) {
        director.recoveryRequired.resolvedAt = new Date().toISOString(); director.recoveryRequired.outcome = 'Director chat handed off after its native turn reached a terminal state.';
      }
      director.threadId = target.id; director.threadHostOwnership = { threadId: target.id, host: 'codex-desktop', kind: 'attached', codexHome: resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex')), lifecycleBaseline: baseline };
      this.state.runtimeEnabled = true;
      delete director.handoff; delete director.nativeActivity;
      this.state.threadId = target.id; this.directorHost.threadId = target.id; this.directorHost.threadEnsured = true; this.directorHost.currentStatus = { type: 'unknown', activeFlags: [] }; this.activityRevision = null;
      this.director = new Director(this, target.id);
      await this.director.events.start();
      bindingCommitted = true;
    } catch (error) {
      let persisted = null;
      if (!bindingCommitted) {
        try {
          persisted = await this.store.read();
          bindingCommitted = Boolean(target && persisted.director?.threadId === target.id && !persisted.director?.handoff);
        } catch { /* Preserve the pending handoff when commit state cannot be read. */ }
      }
      if (!bindingCommitted) {
        director.threadId = handoff.fromThreadId;
        director.threadHostOwnership = originalOwnership;
        director.handoff = handoff;
        if (originalNativeActivity) director.nativeActivity = originalNativeActivity;
        else delete director.nativeActivity;
        this.state.threadId = handoff.fromThreadId;
        this.directorHost.state = this.state.director;
        this.directorHost.threadId = handoff.fromThreadId;
        this.directorHost.threadEnsured = true;
        this.directorHost.currentStatus = { type: 'unknown', activeFlags: [] };
        this.activityRevision = originalActivityRevision;
        this.director = new Director(this, handoff.fromThreadId);
        handoff.status = 'blocked'; handoff.blocker = error.message;
        const saved = await this.save().then(() => true, () => false);
        const blocker = saved ? error.message : `Handoff is still pending, but the blocker could not be persisted: ${error.message}`;
        return { status: 'handoff-pending', fromThreadId: handoff.fromThreadId, toThreadId: handoff.toThreadId, turnId: handoff.turnId ?? null, blocker };
      }
      return { status: 'attached', fromThreadId: handoff.fromThreadId, threadId: target.id, warning: `Binding changed; recovery will retry on startup: ${error.message}` };
    }
    const warnings = [];
    try { await this.directorActivity.pruneExcept([target.id]); } catch (error) { warnings.push(`Attached; retired activity cleanup will retry at startup: ${error.message}`); }
    let native;
    try {
      native = await this.directorActivity.read(target.id);
      if (native.state === 'idle') {
        const flushed = await this.director.events.flush();
        if (['uncertain', 'unavailable', 'recovery-required'].includes(flushed.status)) warnings.push(`Attached; first native check needs reconciliation: ${flushed.status}.`);
      }
    } catch (error) { warnings.push(`Attached; first native check remains pending: ${error.message}`); }
    return { status: 'attached', fromThreadId: handoff.fromThreadId, threadId: target.id, nativeStatus: native?.state ?? 'unknown', ...(warnings.length ? { warning: warnings.join(' ') } : {}) };
  }
  async guard(job, options) {
    this.assertRunning();
    if (this.director) {
      try { await this.director.assertEligible(job.issue, job.eligibilityRevision, options); }
      catch (error) {
        this.assertRunning();
        job.intent = 'pause'; job.phase = 'paused'; job.summary = error.message; await this.save(); throw error;
      }
    }
    this.assertRunning();
    if (job.intent) throw new Error('Execution stopped or held before delivery.');
  }
  executionBlocked() {
    return this.stopping || this.runnerStopRequested || this.runnerResuming || Boolean(this.state && runnerPause(this.state));
  }
  assertRunning() {
    if (this.executionBlocked()) throw Object.assign(new Error(RUNNER_PAUSED_MESSAGE), { code: 'RUNNER_PAUSED' });
  }
  recordInterruptedJobs() {
    for (const job of this.state.jobs) {
      if (activePhases.has(job.phase) && !['pause', 'cancel'].includes(job.intent)) {
        job.runnerInterrupted ??= { phase: job.phase, role: job.activeRole ?? job.nextRole ?? 'builder', turnId: job.turnId ?? null };
      }
      if (job.mergeArmed && !['complete', 'cancelled'].includes(job.phase)) job.deliveryReconciliationRequired = true;
    }
  }
  settleRunnerInterruption(job) {
    if (!job.runnerInterrupted || job.intent || !activePhases.has(job.phase)) return;
    const { role } = job.runnerInterrupted;
    job.builderThreadId ??= job.threadId ?? null;
    const threadId = role === 'reviewer' ? job.reviewerThreadId : job.builderThreadId;
    if (!job.prepared || !threadId || (job.childPid && processExists(job.childPid))) {
      job.phase = 'uncertain';
      job.summary = `Interrupted ${role} preparation or thread ownership requires issue-specific recovery.`;
      return;
    }
    job.phase = 'stopped'; job.activeRole = role; job.nextRole = role;
    job.childPid = null; job.turnId = null;
  }
  async pauseRunner(reason = 'Stopped by the operator') {
    this.runnerStopRequested = true;
    this.state.runnerPause ??= { reason, at: new Date().toISOString() };
    if (this.state.director) this.state.director.enabled = false;
    this.state.serviceReady = false;
    this.recordInterruptedJobs();
    this.runnerPauseSave ??= this.save().catch(error => { this.runnerPauseSave = null; throw error; });
    await this.runnerPauseSave;
    return { stopping: true, runnerPause: structuredClone(this.state.runnerPause) };
  }
  async resumeRunner() {
    if (this.stopping || this.runnerStopRequested) throw new Error('Conductor is shutting down. Retry resume when it stops.');
    if (this.runnerResuming) return { status: 'resuming' };
    if (!runnerPause(this.state)) return { status: 'running' };
    const pause = this.state.runnerPause;
    this.runnerResuming = true;
    delete this.state.runnerPause;
    if (this.state.director) this.state.director.enabled = true;
    try { await this.save(); }
    catch (error) {
      this.state.runnerPause ??= pause;
      if (this.state.director) this.state.director.enabled = false;
      throw error;
    } finally { this.runnerResuming = false; }
    if (this.director) await this.requestCheck({ manual: true, reason: 'Runner resumed by the operator.' });
    else await this.wake();
    return { status: this.executionBlocked() ? 'runner-paused' : 'resumed' };
  }
  async recoverRunnerJob(job) {
    if (job.intent || ['complete', 'cancelled', 'paused', 'cancelling'].includes(job.phase) || this.tasks.has(job.issue)) return false;
    if (job.pullCreationPending && !job.pr) {
      const receipt = await this.github.pullForBranch(job.branch);
      this.assertRunning();
      if (!job.pullCreationPending) return false;
      if (!receipt) {
        job.phase = 'uncertain';
        job.summary = 'PR creation was interrupted without a GitHub receipt. Inspect the original branch before resuming the issue.';
        await this.save();
        return false;
      }
      this.recordPullReceipt(job, receipt);
      await this.save();
    }
    if (job.pr) {
      const pull = await this.github.pull(job.pr);
      this.assertRunning();
      if (pull.state === 'MERGED') {
        if (this.director) await this.director.assertEligible(job.issue, job.eligibilityRevision, { allowCompleted: true });
        job.deliveryReconciliationRequired = true;
        await this.save();
        await this.deliveryAction(() => this.reconcilePull(job));
        return false;
      }
      if (job.mergeArmed) await this.disarm(job);
      if (job.deliveryReconciliationRequired) {
        delete job.deliveryReconciliationRequired;
        await this.save();
      }
    }
    if (job.phase === 'uncertain' || job.phase === 'blocked') return false;
    if (job.runnerInterrupted && job.phase === 'stopped') {
      if (!this.hasResumeCapacity(job) || this.state.director?.interaction?.active) return false;
      // Retain the saved interruption while a hold, admission, or changed
      // revision blocks it. The normal checkJob failure would pause the issue.
      if (this.director) await this.director.assertEligible(job.issue, job.eligibilityRevision);
    } else if (job.runnerInterrupted) {
      delete job.runnerInterrupted;
      await this.save();
    }
    return true;
  }
  hasResumeCapacity(job) {
    const interrupted = candidate => candidate.runnerInterrupted && candidate.phase === 'stopped' && !this.tasks.has(candidate.issue);
    if (job.phase !== 'paused' && !interrupted(job)) return true;
    return occupied(this.state.jobs.filter(candidate => !interrupted(candidate))) < this.config.agents;
  }
  recordPullReceipt(job, pull) {
    job.pr = pull.number;
    job.phase = this.config.reviewEnabled ? 'review' : 'waiting';
    job.activeRole = null; job.nextRole = this.config.reviewEnabled ? 'reviewer' : null;
    delete job.pullCreationPending;
  }
  async progress(job) {
    if (!this.executionBlocked()) await this.github.progress(job);
  }
  deliveryAction(action) {
    const task = this.delivery.catch(() => {}).then(action);
    this.delivery = task; return task;
  }
  async base() {
    await git(this.repo.root, 'fetch', 'origin', this.config.baseBranch);
    return git(this.repo.root, 'rev-parse', `origin/${this.config.baseBranch}`);
  }
  reviewInstructionRevision() {
    return digest({ version: 2, defaultPolicy: 'actionable-findings-v2', instructions: this.config.reviewInstructions });
  }
  async scan() {
    if (this.executionBlocked()) return;
    this.scanError = null;
    if (this.director) {
      await this.director.observe();
      if (this.state.director.snapshots['service-error']) await this.director.events.observe('service-error', null, {kind:'service-recovered'});
    }
    if (this.executionBlocked()) return;
    const base = !this.director || this.state.jobs.some(j => !['paused','blocked','uncertain','complete','cancelled'].includes(j.phase)) ? await this.base() : null;
    for (const job of this.state.jobs) {
      if (this.executionBlocked()) return;
      try {
        if ((job.runnerInterrupted || job.deliveryReconciliationRequired || job.pullCreationPending) && !await this.recoverRunnerJob(job)) continue;
        if (this.director && !['complete','cancelled','cancelling'].includes(job.phase) && !await this.director.checkJob(job)) continue;
        if (job.phase === 'cancelling') await this.cancel(job.issue);
        else if (job.phase === 'stopped' || job.phase === 'repair') {
          const issue = await this.github.issue(job.issue);
          if (issue.state !== 'open') { job.phase = 'blocked'; job.summary = 'Issue closed before verified delivery; operator reconciliation required.'; await this.save(); continue; }
          const revision = createRequestRevision(issue);
          if (job.requestRevision && revision !== job.requestRevision) {
            if (job.mergeArmed) await this.disarm(job);
            await this.supersedeReviewIntent(job, revision, 'The accepted issue request changed. Reassess the revised request against current source and preserve useful work.');
          }
          job.sourceIdentity ??= issue.node_id ?? `${this.config.repository}#${issue.number}`;
          job.requestRevision ??= revision;
          this.launch(job, issue, job.repairReason ?? 'Resume the interrupted original task from current source and retained evidence.', job.pendingFeedback ?? [], job.nextRole ?? 'builder');
        } else if (job.phase === 'review') {
          const issue = await this.github.issue(job.issue);
          if (issue.state !== 'open') { job.phase = 'blocked'; job.summary = 'Issue closed before review and verified delivery; operator reconciliation required.'; await this.save(); continue; }
          const revision = createRequestRevision(issue);
          if (job.requestRevision && revision !== job.requestRevision) {
            await this.supersedeReviewIntent(job, revision, 'The issue request changed before review. Reassess the revised acceptance against the current branch.');
            this.launch(job, issue, job.repairReason, [], 'builder'); continue;
          }
          if (this.config.reviewEnabled) {
            try { await this.verify(job); }
            catch (error) { job.nextRole = 'builder'; await this.repair(job, error); continue; }
            const pull = await this.github.pull(job.pr);
            const head = await git(job.worktree, 'rev-parse', 'HEAD');
            if (head !== pull.headRefOid) {
              const ahead = await run('git', ['merge-base', '--is-ancestor', pull.headRefOid, head], { cwd: job.worktree, allowFailure: true });
              if (ahead.code !== 0) throw new Error('PR head differs from the local issue branch; reconcile publication before review.');
              if (this.director) await this.guard(job);
              if ((await this.designContext(job)).status === 'blocked') continue;
              this.assertRunning();
              await git(job.worktree, 'push', 'origin', job.branch);
              if ((await this.github.pull(job.pr)).headRefOid !== head) throw new Error('Could not confirm the issue branch push before review.');
            }
            if (job.reviewClearance?.head !== head || job.reviewClearance?.base !== job.checkBase || job.reviewClearance?.instructionRevision !== this.reviewInstructionRevision() || job.reviewClearance?.requestRevision !== job.requestRevision) {
              job.reviewStatus = null; job.reviewClearance = null; job.nextRole = 'reviewer'; await this.save();
              this.launch(job, issue, job.reviewReason ?? 'Review the current verified PR head independently.', [], 'reviewer');
            } else { job.phase = 'waiting'; job.nextRole = null; await this.save(); }
          }
          else { job.reviewStatus = 'skipped'; job.phase = 'waiting'; await this.save(); }
        } else if (job.phase === 'waiting') await this.deliveryAction(() => this.reconcilePull(job, base));
      } catch (error) { if (error.code !== 'RUNNER_PAUSED') { delete job.waitingFor; job.lastError = error.message; await this.save(); this.emit('notice', `Issue #${job.issue}: ${error.message}`); } }
    }
    if (this.executionBlocked()) return;
    // Version 2 never admits from a polling tick: the director supplies a fresh
    // revision-bound dispatch command. Legacy fixtures retain their old lane.
    if (this.director) { this.state.lastScan = new Date().toISOString(); await this.save(); return; }
    const ready = await this.github.ready(this.config.readyLabel);
    // Filter dependencies before the capacity slice so blocked candidates do not starve ready work.
    const eligible = [];
    for (const issue of ready) {
      if (this.state.jobs.some(job => job.issue === issue.number)) continue;
      if (!(await this.github.blockers(issue.number)).length) eligible.push(issue);
    }
    for (const issue of admission(eligible, this.state.jobs, this.config)) {
      await this.dispatchIssue(issue, base);
    }
    this.state.lastScan = new Date().toISOString(); await this.save();
  }
  async dispatchIssue(issue, base, eligibilityRevision, designHandoff) {
    this.director?.assertInteractionReleased();
      this.assertRunning();
      const branch = `conductor/issue-${issue.number}`;
      if (await this.github.pullForBranch(branch)) throw new Error(`Issue #${issue.number} already has a PR on ${branch}; recover its owner before adoption.`);
      this.assertRunning();
      // Ordinary worktrees stay outside all source checkouts; their explicit paths survive restart.
      const path = join(dirname(dirname(this.repo.commonDir)), '.conductor-worktrees', digest(this.repo.commonDir).slice(0, 16), `issue-${issue.number}`);
      const job = { issue: issue.number, sourceIdentity: issue.node_id ?? `${this.config.repository}#${issue.number}`, requestRevision: createRequestRevision(issue), branch, worktree: path, baseBranch: this.config.baseBranch, phase: 'preparing', activeRole: 'builder', nextRole: 'builder', builderThreadId: null, reviewerThreadId: null, threadId: null, turnId: null, childPid: null, acceptanceComplete: false, createdAt: new Date().toISOString() };
      if (eligibilityRevision) job.eligibilityRevision = eligibilityRevision;
      if (designHandoff !== undefined) job.designHandoff = structuredClone(designHandoff);
      this.state.jobs.push(job); await this.save();
      const prepareAndLaunch = async () => {
      try {
        if (this.director) await this.guard(job);
        await this.prepare(job, base);
        if (this.executionBlocked() || job.intent) { if (!job.runnerInterrupted) job.phase = job.intent === 'pause' ? 'paused' : job.intent === 'cancel' ? 'cancelled' : 'stopped'; await this.save(); }
        else this.launch(job, issue, 'Start the authorized issue. Read its acceptance and relevant project instructions before changing source.', [], 'builder');
      } catch (error) {
        if (this.executionBlocked()) return;
        if (job.intent !== 'cancel') job.phase = job.intent === 'pause' ? 'paused' : 'blocked';
        job.summary = `Workspace preparation failed: ${error.message}`; await this.save(); await this.progress(job);
      }
      };
      if (this.director) {
        const pending = prepareAndLaunch().catch(error => this.emit('notice', error.message)).finally(() => { this.preparations.delete(job.issue); if (!this.stopping) this.wake(); });
        this.preparations.set(job.issue, pending);
      } else await prepareAndLaunch();
      return { issue: job.issue, phase: job.phase, branch: job.branch };
  }
  async prepare(job, base) {
    this.assertRunning();
    if (!job.worktreeCreated) {
      await mkdir(dirname(job.worktree), { recursive: true });
      this.assertRunning();
      await this.workspace.createWorktree({ repoRoot: this.repo.root, path: job.worktree, branch: job.branch, baseRef: base });
      job.worktreeCreated = true; await this.save();
    }
    this.assertRunning();
    job.includes = await this.workspace.copyWorktreeIncludes({ repoRoot: this.repo.root, worktreePath: job.worktree });
    for (let i = job.preparedCommands ?? 0; i < this.config.prepare.length; i++) {
      if (this.executionBlocked() || job.intent) return;
      job.preparationInFlight = i; await this.save();
      this.assertRunning();
      await this.command(this.config.prepare[i], job.worktree);
      job.preparedCommands = i + 1; job.preparationInFlight = null; await this.save();
    }
    job.prepared = true; await this.save(); await this.progress(job);
  }
  async command(command, cwd) {
    let executable = command.command;
    let args = command.args;
    // npm.cmd cannot be spawned directly without a shell on Windows. Use its installed JS entrypoint.
    if (process.platform === 'win32' && ['npm','npm.cmd'].includes(executable)) {
      const npm = process.env.npm_execpath ?? join(resolve(process.execPath, '..'), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      await access(npm); executable = process.execPath; args = [npm, ...args];
    }
    this.assertRunning();
    return this.execute(executable, args, { cwd });
  }
  async designContext(job) {
    this.assertRunning();
    if (!this.config.designHandoff) return { status: 'disabled' };
    const abort = new AbortController();
    this.handoffChecks.set(job.issue, abort);
    try {
      const issue = await this.github.issue(job.issue);
      const result = await validateDesignHandoff({ config: this.config.designHandoff, payload: job.designHandoff,
        sourceIdentity: issue.node_id ?? `${this.config.repository}#${issue.number}`, requestRevision: createRequestRevision(issue),
        worktree: job.worktree, commonDir: this.repo.commonDir, execute: this.execute, signal: abort.signal });
      if (job.intent || this.executionBlocked()) return { status: 'blocked', reason: 'Execution stopped while validating the design handoff.' };
      if (this.director) await this.guard(job);
      job.designHandoffValidation = { bindings: result.bindings, reviewerId: result.review.reviewerId };
      job.designHandoffError = null; await this.save();
      return result;
    } catch (error) {
      job.designHandoffValidation = null; job.designHandoffError = error.message;
      if (!job.intent && !this.executionBlocked()) {
        // A prerequisite failure is known not to have launched a model turn.
        // Keep the durable original thread, so normal resume can recover it.
        if (job.mergeArmed) await this.disarm(job);
        job.phase = 'blocked'; job.activeRole = null; job.nextRole = 'builder';
        job.summary = `Design handoff blocked: ${error.message}`; job.lastError = job.summary;
        await this.save(); await this.progress(job);
      }
      return { status: 'blocked', reason: error.message };
    } finally { if (this.handoffChecks.get(job.issue) === abort) this.handoffChecks.delete(job.issue); }
  }
  launch(job, issue, reason, feedback = [], role = job.nextRole ?? 'builder') {
    if (this.tasks.has(job.issue) || this.executionBlocked() || !this.hasResumeCapacity(job)) return;
    delete job.waitingFor;
    const task = this.build(job, issue, reason, feedback, role).catch(async error => {
      if (job.runnerInterrupted && this.executionBlocked()) return;
      const threadId = role === 'reviewer' ? job.reviewerThreadId : job.builderThreadId ?? job.threadId;
      job.activeRole = role; job.nextRole = role;
      job.phase = job.intent === 'pause' ? 'paused' : job.intent === 'cancel' ? job.cancelConfirmed ? 'cancelled' : 'cancelling' : this.stopping ? 'stopped' : ['starting','launching'].includes(job.phase) || !threadId ? 'uncertain' : 'blocked'; job.summary = error.message; job.lastError = error.message;
      await this.save(); await this.progress(job).catch(e => this.emit('notice', e.message));
    }).finally(() => { this.tasks.delete(job.issue); if (!this.stopping) this.wake(); });
    this.tasks.set(job.issue, task);
  }
  async build(job, issue, reason, feedback, role = 'builder') {
    if (this.director) await this.guard(job);
    if (role === 'reviewer' && job.reviewPublicationStatus === 'pending') {
      await this.publishReviewResult(job);
      return;
    }
    const client = new this.Client({ cwd: job.worktree });
    this.clients.set(job.issue, client);
    let finalText = '';
    let threadId;
    let terminalResolve, terminalReject;
    const terminal = new Promise((resolve, reject) => { terminalResolve = resolve; terminalReject = reject; });
    // Rejection can arrive while startTurn's RPC is still pending.
    terminal.catch(() => {});
    client.on('notification', ({ method, params }) => {
      if (params?.threadId && threadId && params.threadId !== threadId) return;
      if (method === 'item/completed' && params?.item?.type === 'agentMessage') finalText = params.item.text;
      if (method === 'turn/completed') terminalResolve(params.turn);
      if (method === 'serverRequest/resolved') {
        for (const [key, request] of this.requests) if (request.issue === job.issue && request.id === params.requestId) this.requests.delete(key);
      }
    });
    client.on('request', request => {
      const key = `${job.issue}:${request.id}`;
      this.requests.set(key, { ...request, issue: job.issue, client });
      this.emit('request', { key, issue: job.issue, role, ...request });
      if (this.director) this.director.events.emit({ kind: 'worker-question', key, issue: job.issue, method: request.method }).then(() => this.director.events.flush()).catch(error => this.emit('notice', error.message));
    });
    client.on('exit', ({ code }) => terminalReject(new Error(`Codex process exited (${code}) before a terminal turn result.`)));
    client.on('error', terminalReject);
    try {
      if (job.intent || this.executionBlocked()) return;
      if (!job.prepared) throw new Error('Workspace preparation is incomplete; use explicit resume after inspecting preparation state.');
      job.activeRole = role; job.nextRole = role;
      const field = role === 'reviewer' ? 'reviewerThreadId' : 'builderThreadId';
      threadId = job[field] ?? (role === 'builder' ? job.threadId : null);
      job[field] = threadId;
      if (role === 'builder') job.threadId = threadId;
      job.phase = threadId ? role === 'reviewer' ? 'reviewing' : 'building' : 'starting';
      delete job.runnerInterrupted;
      await this.save();
      this.assertRunning();
      await client.connect(); job.childPid = client.pid; await this.save();
      if (job.intent || this.executionBlocked()) return;
      if (threadId) {
        const recovered = await client.readThread({ threadId });
        if (recovered.turns?.some(turn => turn.status === 'inProgress')) throw new Error(`Original ${role} thread still has an active turn; reconcile its owner before resuming.`);
        this.assertRunning();
        await client.resumeThread({ threadId, cwd: job.worktree });
      }
      else {
        this.assertRunning();
        const thread = await client.startThread({ cwd: job.worktree });
        threadId = thread.id; job[field] = threadId; if (role === 'builder') job.threadId = threadId; await this.save();
      }
      this.assertRunning();
      await client.setThreadName({ threadId, name: `${this.config.repository} #${issue.number} - ${role}` });
      if (this.executionBlocked() || job.intent) return;
      if (this.config.maxTurns && this.state.jobs.reduce((n, j) => n + (j.turnCount ?? 0), 0) >= this.config.maxTurns) throw new Error('Configured total Codex turn budget exhausted; work is retained.');
      const base = role === 'reviewer' ? await this.base() : null;
      const head = role === 'reviewer' ? await git(job.worktree, 'rev-parse', 'HEAD') : null;
      if (role === 'reviewer') {
        const pull = await this.github.pull(job.pr);
        if (head !== pull.headRefOid || head !== job.checkHead || base !== job.checkBase || await git(job.worktree, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Verified base/head changed or worktree is dirty before review; reconcile and re-verify before starting the reviewer.');
      }
      if (this.director) await this.guard(job);
      const designHandoff = role === 'builder' ? await this.designContext(job) : null;
      if (designHandoff?.status === 'blocked' || this.executionBlocked() || job.intent) return;
      job.phase = 'launching'; job.turnCount = (job.turnCount ?? 0) + 1; await this.save();
      this.assertRunning();
      const turn = role === 'reviewer'
        ? await client.startTurn({ threadId, cwd: job.worktree, prompt: reviewPrompt({ config: this.config, job, issue, base, head, previous: job.reviewFindings ?? [] }), outputSchema: reviewResultSchema })
        : await client.startTurn({ threadId, cwd: job.worktree, prompt: builderPrompt({ config: this.config, job, issue, reason, feedback, designHandoff: designHandoff?.status === 'ready' ? designHandoff : null }), skillPath, outputSchema: resultSchema });
      job.turnId = turn.id;
      if (this.executionBlocked() || job.intent) {
        if (job.runnerInterrupted) { job.runnerInterrupted.turnId = turn.id; await this.save(); }
        if (!this.stopping) await client.interrupt({ threadId, turnId: turn.id });
        return;
      }
      job.phase = role === 'reviewer' ? 'reviewing' : 'building'; await this.save();
      const done = await terminal;
      if (job.intent === 'cancel' || job.runnerInterrupted && this.executionBlocked()) return;
      if (done.status === 'interrupted' || this.stopping) { job.phase = 'stopped'; job.nextRole = role; await this.save(); return; }
      if (done.status !== 'completed') throw new Error(`${role === 'reviewer' ? 'Reviewer' : 'Builder'} turn ${done.status}: ${JSON.stringify(done.error ?? {})}`);
      const result = role === 'reviewer' ? parseReviewResult(finalText) : parseResult(finalText);
      if (role === 'reviewer') {
        if (!await this.revalidateReviewRequest(job)) return;
        const afterHead = await git(job.worktree, 'rev-parse', 'HEAD');
        const afterBase = await this.base();
        if (afterBase !== base) {
          job.phase = 'review'; job.activeRole = null; job.nextRole = 'reviewer'; job.reviewStatus = null; job.reviewClearance = null;
          job.reviewReason = 'The configured base advanced during review. Integrate it, rerun checks, and review the current branch.';
          job.lastError = null; await this.save(); return;
        }
        if (afterHead !== head || job.checkHead !== head || job.checkBase !== base) throw new Error('The issue head changed during review; its result is stale and must be reviewed again.');
        job.reviewResult = result; job.reviewHead = head; job.reviewBase = base; job.reviewInstructionRevision = this.reviewInstructionRevision(); job.reviewFindings = result.findings;
        job.reviewResultRevision = job.requestRevision;
        if (result.status === 'blocked') { job.phase = 'blocked'; job.nextRole = 'reviewer'; job.summary = result.summary; job.lastError = null; await this.save(); await this.progress(job); return; }
        job.reviewAttempt = (job.reviewAttempt ?? 0) + 1; job.reviewPublicationStatus = 'pending'; job.nextRole = 'reviewer'; await this.save();
        await this.publishReviewResult(job); return;
      }
      Object.assign(job, result); job.acceptanceComplete = result.acceptanceComplete;
      if (result.disposition === 'blocked' || !result.acceptanceComplete) { job.phase = 'blocked'; await this.save(); await this.progress(job); return; }
      if (await git(job.worktree, 'status', '--porcelain')) throw new Error('Builder left uncommitted or untracked work; finish the owned change before delivery.');
      try { await this.verify(job); }
      catch (error) { await this.repair(job, error); return; }
      if (this.executionBlocked() || job.intent) return;
      if (this.director) await this.guard(job);
      if ((await this.designContext(job)).status === 'blocked') return;
      this.assertRunning();
      await git(job.worktree, 'push', '-u', 'origin', job.branch);
      if (this.executionBlocked() || job.intent) return;
      if (this.director) await this.guard(job);
      if ((await this.designContext(job)).status === 'blocked') return;
      if (!job.pr) {
        job.pullCreationPending = true; await this.save();
        if (this.executionBlocked()) { delete job.pullCreationPending; await this.save(); return; }
      }
      let pull;
      try { pull = await this.github.createPull(job, issue); }
      catch (error) {
        if (error.code === 'RUNNER_PAUSED') delete job.pullCreationPending;
        throw error;
      }
      this.recordPullReceipt(job, pull);
      // Do not swallow feedback arriving while the builder was active: only evidence sent
      // to that turn is acknowledged by reconcilePull before launching it.
      job.lastError = null; job.repairReason = null; job.pendingFeedback = [];
      job.reviewStatus = this.config.reviewEnabled ? null : 'skipped'; job.reviewClearance = null;
      await this.save(); await this.progress(job);
    } finally {
      await client.close(); this.clients.delete(job.issue); job.childPid = null; job.turnId = null;
      if (job.intent === 'cancel') job.phase = job.cancelConfirmed ? 'cancelled' : 'cancelling';
      else if (job.intent === 'pause') job.phase = 'paused';
      else if (job.runnerInterrupted) this.settleRunnerInterruption(job);
      else if (this.stopping && activePhases.has(job.phase)) { job.phase = 'stopped'; job.nextRole = role; }
      for (const [key, request] of this.requests) if (request.issue === job.issue) this.requests.delete(key);
      await this.save();
    }
  }
  async repair(job, error) {
    this.assertRunning();
    const fingerprint = digest({ error: error.message, head: await git(job.worktree, 'rev-parse', 'HEAD') });
    this.assertRunning();
    job.repairAttempts = job.repairFingerprint === fingerprint ? (job.repairAttempts ?? 0) + 1 : 1;
    job.repairFingerprint = fingerprint;
    job.phase = job.repairAttempts >= 2 ? 'blocked' : 'repair';
    job.repairReason = `Repair local verification in this original issue: ${error.message}`;
    job.lastError = error.message; await this.save(); await this.progress(job);
  }
  async publishReviewResult(job) {
    this.assertRunning();
    if (this.director) await this.guard(job);
    if ((await this.designContext(job)).status === 'blocked') return;
    const result = job.reviewResult;
    if (!result || !['clear', 'findings'].includes(result.status) || !Number.isSafeInteger(job.reviewAttempt) || !job.reviewHead) throw new Error('Saved review publication intent is incomplete; no PR comment was sent.');
    if (!await this.revalidateReviewRequest(job)) return;
    if (!job.reviewResultRevision || job.reviewResultRevision !== job.requestRevision) {
      await this.supersedeReviewIntent(job, job.requestRevision, 'The saved review result does not match the current issue revision. Reassess the current request before publishing a review.');
      return;
    }
    const [currentHead, currentBase, pull] = await Promise.all([
      git(job.worktree, 'rev-parse', 'HEAD'), this.base(), this.github.pull(job.pr),
    ]);
    if (currentHead !== job.reviewHead || currentBase !== job.reviewBase || job.checkHead !== currentHead || job.checkBase !== currentBase || pull.headRefOid !== currentHead) {
      await this.supersedeReviewPublication(job, 'The checked base or PR head changed before review publication. Integrate, recheck, and review the current branch.');
      return;
    }
    this.assertRunning();
    const published = await this.github.submitReview(job.pr, { attempt: job.reviewAttempt, head: job.reviewHead, result });
    job.reviewPublication = published; job.reviewPublicationStatus = 'published'; job.reviewStatus = result.status; job.summary = result.summary; job.lastError = null;
    if (result.status === 'findings') {
      job.phase = 'repair'; job.activeRole = null; job.nextRole = 'builder'; job.repairReason = 'Address the independent PR review findings. The original reviewer will re-check each finding after your repair.';
      job.pendingFeedback = result.findings.map((finding, index) => ({ kind: 'reviewer-agent', id: `${job.reviewHead}:${index}`, ...finding, head: job.reviewHead }));
    } else {
      job.phase = 'waiting'; job.activeRole = null; job.nextRole = null;
      job.reviewClearance = { head: job.reviewHead, base: job.reviewBase, instructionRevision: job.reviewInstructionRevision, requestRevision: job.reviewResultRevision };
    }
    await this.save(); await this.progress(job);
  }
  async supersedeReviewPublication(job, reason) {
    // A saved pending intent may already have reached GitHub. Reconcile its marker
    // before superseding it; a failed read leaves the intent intact for recovery.
    const receipt = await this.findSavedReviewReceipt(job);
    if (receipt) job.reviewPublication = receipt;
    job.reviewPublicationStatus = receipt ? 'published' : 'superseded';
    job.reviewResultStatus = 'superseded'; job.reviewResult = null;
    job.reviewStatus = 'stale'; job.reviewClearance = null;
    job.phase = 'review'; job.activeRole = null; job.nextRole = 'reviewer'; job.reviewReason = reason;
    job.lastError = null; await this.save(); await this.progress(job);
  }
  async revalidateReviewRequest(job) {
    const issue = await this.github.issue(job.issue);
    if (issue.state !== 'open') {
      if (job.reviewPublicationStatus === 'pending') {
        const receipt = await this.findSavedReviewReceipt(job);
        if (receipt) job.reviewPublication = receipt;
        job.reviewPublicationStatus = 'superseded';
      }
      job.phase = 'blocked'; job.activeRole = null; job.nextRole = 'reviewer'; job.reviewStatus = 'stale'; job.reviewClearance = null;
      job.summary = 'The issue closed during review; the saved review result was not newly published.';
      await this.save(); await this.progress(job); return false;
    }
    const revision = createRequestRevision(issue);
    if (!job.requestRevision) { job.requestRevision = revision; return true; }
    if (revision !== job.requestRevision) {
      await this.supersedeReviewIntent(job, revision, 'The issue request changed during review or publication. Reassess its revised acceptance against current source before publishing another review.');
      return false;
    }
    return true;
  }
  async supersedeReviewIntent(job, revision, reason) {
    if (job.reviewPublicationStatus === 'pending') {
      // Resolve any uncertain write before changing the request it represents.
      const receipt = await this.findSavedReviewReceipt(job);
      if (receipt) job.reviewPublication = receipt;
    }
    job.requestRevision = revision; job.acceptanceComplete = false; job.reviewStatus = 'stale'; job.reviewClearance = null;
    job.designHandoffValidation = null;
    job.reviewResultStatus = 'superseded'; job.reviewResult = null; job.reviewFindings = [];
    if (job.reviewPublicationStatus === 'pending') job.reviewPublicationStatus = 'superseded';
    job.checkBase = null; job.checkHead = null; job.pendingFeedback = [];
    job.phase = 'repair'; job.activeRole = null; job.nextRole = 'builder'; job.repairReason = reason;
    job.lastError = null; await this.save(); await this.progress(job);
  }
  async findSavedReviewReceipt(job) {
    if (!job.pr || !Number.isSafeInteger(job.reviewAttempt) || !job.reviewHead) throw new Error('Saved review publication intent lacks its PR, attempt, or reviewed head; preserve it and reconcile before continuing.');
    return this.github.findReviewReceipt(job.pr, { attempt: job.reviewAttempt, head: job.reviewHead });
  }
  async verify(job) {
    this.assertRunning();
    const base = await this.base();
    this.assertRunning();
    const refreshed = await this.workspace.refreshBranch({ repoRoot: this.repo.root, worktreePath: job.worktree, baseRef: base });
    if (refreshed.conflict) throw new Error('Base integration conflicts require repair in the original builder.');
    const head = await git(job.worktree, 'rev-parse', 'HEAD');
    if (job.checkHead === head && job.checkBase === base) return;
    job.checkHead = null; job.checkBase = null; await this.save();
    for (const command of this.config.checks) await this.command(command, job.worktree);
    if (await git(job.worktree, 'status', '--porcelain')) throw new Error('Verification changed workspace content; original builder must reconcile it.');
    if (await git(job.worktree, 'rev-parse', 'HEAD') !== head) throw new Error('Source changed while checks were running.');
    job.checkHead = head; job.checkBase = base; await this.save();
  }
  async waitForDelivery(job, reason) {
    if (job.waitingFor === reason && !job.lastError) return;
    job.waitingFor = reason; job.lastError = null;
    await this.save();
  }
  async reconcilePull(job, base) {
    if (job.intent || this.executionBlocked()) return;
    const pull = await this.github.pull(job.pr);
    this.assertRunning();
    if (pull.baseRefName !== this.config.baseBranch) throw new Error('PR targets a different base branch; operator reconciliation required.');
    if (pull.state === 'MERGED') {
      const acceptedBase = await this.base();
      if (!pull.mergeCommit?.oid) throw new Error('Merged PR has no verified merge commit yet.');
      await git(this.repo.root, 'merge-base', '--is-ancestor', pull.mergeCommit.oid, acceptedBase);
      if (!job.acceptanceComplete) { job.phase = 'blocked'; job.summary = 'PR merged but complete issue acceptance remains unresolved.'; await this.save(); return; }
      const deliveredIssue = await this.github.issue(job.issue);
      const deliveredRevision = createRequestRevision(deliveredIssue);
      if (deliveredRevision !== job.requestRevision) {
        job.phase = 'blocked'; job.landedRequestRevision = job.requestRevision; job.currentRequestRevision = deliveredRevision;
        job.summary = `PR #${job.pr} landed for an older issue revision. The issue remains open for reconciliation; no follow-up implementation was started on the merged branch.`;
        await this.save(); await this.progress(job); return;
      }
      if (this.director) await this.guard(job, { allowCompleted: true });
      this.assertRunning();
      await this.github.closeIssue(job.issue, `Delivered by PR #${job.pr}; accepted base contains ${pull.mergeCommit.oid}.\n\n${job.summary}`);
      job.phase = 'complete'; job.mergedCommit = pull.mergeCommit.oid; delete job.waitingFor;
      job.deliveredHead = pull.headRefOid && pull.headRefOid === job.checkHead ? pull.headRefOid : null;
      delete job.runnerInterrupted; delete job.deliveryReconciliationRequired; job.mergeArmed = false;
      delete job.designHandoff; delete job.designHandoffValidation;
      await this.save(); await this.cleanupCompletedWorktrees(); await this.progress(job); return;
    }
    if (pull.state === 'CLOSED') { job.phase = 'blocked'; job.summary = 'PR closed without merge; acceptance remains open.'; await this.save(); await this.progress(job); return; }
    const currentIssue = await this.github.issue(job.issue);
    const currentRevision = createRequestRevision(currentIssue);
    if (!job.requestRevision) job.requestRevision = currentRevision;
    else if (currentRevision !== job.requestRevision) {
      if (job.mergeArmed) await this.disarm(job);
      await this.supersedeReviewIntent(job, currentRevision, 'The issue request changed. Reassess the revised acceptance against current source and preserve useful work.');
      this.launch(job, currentIssue, job.repairReason, [], 'builder'); return;
    }
    if ((await this.designContext(job)).status === 'blocked') return;
    const feedback = await this.github.feedback(job.pr, pull.headRefOid);
    const unseen = feedback.items.filter(item => !(job.feedbackSeen ?? []).includes(digest(item)));
    const checks = checkState(pull);
    const checkFailure = checks.failed.length ? digest({ head: pull.headRefOid, failed: checks.failed }) : null;
    if (unseen.length || (checkFailure && checkFailure !== job.checkFailure)) {
      if (job.mergeArmed) await this.disarm(job);
      job.feedbackHash = feedback.hash; job.feedbackSeen = [...(job.feedbackSeen ?? []), ...unseen.map(digest)]; job.checkFailure = checkFailure;
      job.pendingFeedback = [...unseen, ...checks.failed];
      job.repairReason = 'Reconcile review or failed-check evidence and repair this same issue. Preserve and report unresolved findings.';
      await this.save();
      this.launch(job, await this.github.issue(job.issue), job.repairReason, job.pendingFeedback); return;
    }
    const wait = deliveryWaitReason(pull, checks);
    if (wait) return this.waitForDelivery(job, wait);
    const currentBase = await this.base();
    if (job.mergeArmed && job.checkBase !== currentBase) await this.disarm(job);
    try { await this.verify(job); }
    catch (error) { job.nextRole = 'builder'; await this.repair(job, error); return; }
    let head = await git(job.worktree, 'rev-parse', 'HEAD');
    if (head !== pull.headRefOid) {
      const localContainsRemote = await run('git', ['merge-base', '--is-ancestor', pull.headRefOid, head], { cwd: job.worktree, allowFailure: true });
      if (localContainsRemote.code !== 0) throw new Error('PR contains changes not present in the issue worktree; reconcile before updating it.');
      if ((await this.designContext(job)).status === 'blocked') return;
      this.assertRunning();
      await git(job.worktree, 'push', 'origin', job.branch);
      const pushed = await this.github.pull(job.pr);
      if (pushed.headRefOid !== head) throw new Error('Updated issue branch push is not confirmed by the PR.');
      if (job.mergeArmed) await this.disarm(job);
      job.reviewStatus = null; job.reviewClearance = null; job.phase = this.config.reviewEnabled ? 'review' : 'waiting'; job.nextRole = this.config.reviewEnabled ? 'reviewer' : null; await this.save();
      if (this.config.reviewEnabled) this.launch(job, currentIssue, 'The issue branch now includes the latest base; review the newly verified commit.', [], 'reviewer');
      return;
    }
    const instructionsRevision = this.reviewInstructionRevision();
    if (this.config.reviewEnabled && (job.reviewStatus !== 'clear' || job.reviewClearance?.head !== head || job.reviewClearance?.base !== currentBase || job.reviewClearance?.instructionRevision !== instructionsRevision || job.reviewClearance?.requestRevision !== job.requestRevision)) {
      if (job.mergeArmed) await this.disarm(job);
      job.reviewStatus = null; job.reviewClearance = null; job.phase = 'review'; job.nextRole = 'reviewer'; await this.save();
      this.launch(job, currentIssue, 'Review the current verified PR head against the current issue and review instructions.', [], 'reviewer'); return;
    }
    // GitHub can retain an armed request after all gates turn green. Reconcile a
    // CLEAN request through the normal protected merge command instead of waiting forever.
    if (job.mergeArmed && pull.autoMergeRequest && pull.mergeStateStatus !== 'CLEAN') return this.waitForDelivery(job, `GitHub auto-merge is waiting for branch requirements (${pull.mergeStateStatus ?? 'unknown'}); inspect the PR merge requirements`);
    const approvals = await this.github.approvals(job.pr, head);
    const approvalWait = deliveryWaitReason(pull, checks, approvals, this.config.requiredApprovals);
    if (approvalWait) return this.waitForDelivery(job, approvalWait);
    // Only one PR may have native auto-merge armed. Waiting issues retain their slots.
    const landing = this.state.jobs.find(other => other.issue !== job.issue && other.mergeArmed && other.phase !== 'complete');
    if (landing) return this.waitForDelivery(job, `Waiting for Issue #${landing.issue} to finish landing before this PR can merge`);
    const fresh = await this.github.pull(job.pr);
    if (fresh.headRefOid !== job.checkHead || (await this.base()) !== job.checkBase) return this.waitForDelivery(job, 'The PR or base branch changed; rechecking on the next observation');
    const freshChecks = checkState(fresh);
    const freshApprovals = await this.github.approvals(job.pr, fresh.headRefOid);
    if (this.executionBlocked() || job.intent) return;
    if (fresh.state !== 'OPEN') return this.waitForDelivery(job, 'PR state changed; reconciling delivery on the next observation');
    const freshWait = deliveryWaitReason(fresh, freshChecks, freshApprovals, this.config.requiredApprovals);
    if (freshWait) return this.waitForDelivery(job, freshWait);
    job.waitingFor = 'Submitting the merge request; an interrupted response will be reconciled before retrying';
    job.lastError = null;
    job.mergeArmed = true; await this.save();
    if (this.executionBlocked() || job.intent) return;
    if (this.director) await this.guard(job);
    if ((await this.designContext(job)).status === 'blocked') return;
    this.assertRunning();
    await this.github.merge(job.pr, fresh.headRefOid, this.config.mergeMethod);
    await this.waitForDelivery(job, 'GitHub accepted the merge request; waiting to verify delivery on the base branch');
  }
  async disarm(job) {
    const before = await this.github.pull(job.pr);
    if (before.state === 'MERGED') throw Object.assign(new Error('PR already landed; reconcile delivery before cancelling or repairing.'), { code: 'ALREADY_MERGED' });
    if (before.autoMergeRequest) await this.github.disableAutoMerge(job.pr);
    const after = await this.github.pull(job.pr);
    if (after.state === 'MERGED') throw Object.assign(new Error('PR landed while cancellation was disarming auto-merge.'), { code: 'ALREADY_MERGED' });
    if (after.autoMergeRequest) throw new Error('Merge outcome is not safely disarmed; retain ownership and reconcile again.');
    job.mergeArmed = false; await this.save();
  }
  async answer(key, value) {
    this.assertRunning();
    const request = this.requests.get(key);
    if (!request) throw new Error('That request is no longer pending.');
    let response;
    if (['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(request.method)) {
      if (!['accept','acceptForSession','decline','cancel'].includes(value)) throw new Error('Type accept, acceptForSession, decline or cancel explicitly.');
      response = { decision: value };
    } else {
      try { response = JSON.parse(value); } catch { throw new Error('This request needs an explicit JSON response; inspect the displayed request.'); }
    }
    await request.client.respond(request.id, response); this.requests.delete(key);
  }
  async cancel(issue) {
    this.assertRunning();
    const job = this.state.jobs.find(x => x.issue === issue);
    if (!job) throw new Error(`No owned issue #${issue}.`);
    if (job.phase === 'complete') throw new Error('Delivered issues cannot be cancelled.');
    if (job.phase === 'cancelled') return;
    job.intent = 'cancel';
    this.handoffChecks.get(job.issue)?.abort();
    job.phase = 'cancelling'; await this.save();
    try {
      await this.deliveryAction(async () => { if (job.pr) await this.disarm(job); });
    } catch (error) {
      if (error.code !== 'ALREADY_MERGED') throw error;
      job.intent = null; job.phase = 'waiting';
      job.summary = 'Cancellation arrived after the PR landed; delivery reconciliation will verify the accepted base.';
      await this.save(); this.wake();
      throw new Error(`Issue #${issue} cannot be cancelled because PR #${job.pr} already landed; delivery reconciliation is continuing.`);
    }
    job.cancelConfirmed = true; await this.save();
    const client = this.clients.get(issue);
    if (client) await this.haltClient(job, client);
    await this.tasks.get(issue);
    job.phase = 'cancelled'; job.summary = 'Cancelled by the operator; unfinished branch and worktree retained, automatic redispatch disabled.';
    delete job.designHandoff; delete job.designHandoffValidation;
    await this.save();
    await this.progress(job); this.wake();
  }
  async resumeIssue({ issue, expectedRevision, workerThreadId, role, designHandoff }) {
    this.assertRunning();
    const current = this.director
      ? await this.director.assertEligible(issue, expectedRevision ?? (await this.director.snapshot(issue)).revision)
      : null;
    const job = this.state.jobs.find(job => job.issue === issue);
    if (!job) throw new Error('No original job to resume.');
    if (job.pr && (await this.github.pull(job.pr)).state === 'MERGED') throw new Error('PR already landed. Reconcile delivery before resuming.');
    if (job.deliveryReconciliationRequired) throw new Error('PR delivery requires reconciliation before resuming.');
    if (!this.hasResumeCapacity(job)) throw new Error('No issue capacity is available.');
    await this.resume(issue, workerThreadId, role, designHandoff, current?.revision);
    return { resumed: issue };
  }
  async resume(issue, threadId, role, designHandoff, eligibilityRevision) {
    this.assertRunning();
    this.director?.assertInteractionReleased();
    const job = this.state.jobs.find(x => x.issue === issue);
    if (!job || !['blocked','stopped','uncertain','paused'].includes(job.phase) || this.tasks.has(issue) || this.preparations.has(issue)) throw new Error('Only a stopped, blocked or paused original issue can be resumed.');
    if (job.childPid && processExists(job.childPid)) throw new Error('Previous builder process is still alive; ownership remains uncertain.');
    const source = await this.github.issue(issue);
    if (source.state !== 'open') throw new Error('Reopen and reconcile the issue before resuming it.');
    const recoveringPull = job.pullCreationPending;
    if (recoveringPull) {
      const receipt = await this.github.pullForBranch(job.branch);
      this.assertRunning();
      if (!job.pullCreationPending) return;
      if (receipt) {
        if (!this.hasResumeCapacity(job)) throw new Error('No issue capacity is available.');
        if (eligibilityRevision) job.eligibilityRevision = eligibilityRevision;
        if (designHandoff !== undefined) { job.designHandoff = structuredClone(designHandoff); job.designHandoffValidation = null; }
        job.intent = null;
        this.recordPullReceipt(job, receipt);
        job.deliveryReconciliationRequired = true;
        await this.save(); this.wake();
        return;
      }
      const worktree = await inspectRepository(job.worktree);
      if (worktree.root !== resolve(job.worktree) || worktree.commonDir !== this.repo.commonDir || job.branch !== `conductor/issue-${job.issue}` ||
          (await readFile(join(worktree.gitDir, 'conductor-owned-worktree'), 'utf8')).trim() !== this.repo.root ||
          await git(job.worktree, 'branch', '--show-current') !== job.branch) {
        throw new Error('The original worktree and issue branch could not be verified. PR creation remains unresolved.');
      }
      if (!job.pullCreationPending) return;
    }
    const targetRole = role ?? job.nextRole ?? job.activeRole ?? 'builder';
    if (!['builder', 'reviewer'].includes(targetRole)) throw new Error('Role must be builder or reviewer.');
    const field = targetRole === 'reviewer' ? 'reviewerThreadId' : 'builderThreadId';
    job.builderThreadId ??= job.threadId ?? null;
    let savedThread = job[field] ?? (targetRole === 'builder' ? job.threadId : null);
    if (!savedThread && job.prepared) {
      const client = new this.Client({ cwd: job.worktree });
      try {
        await client.connect();
        const candidates = await client.listThreads({ cwd: job.worktree });
        if (threadId && !candidates.some(thread => thread.id === threadId)) throw new Error('Selected thread does not belong to this worktree.');
        const expectedName = `${this.config.repository} #${issue} - ${targetRole}`;
        const named = candidates.filter(thread => thread.name === expectedName);
        const eligible = named.length ? named : targetRole === 'builder' ? candidates.filter(thread => !thread.name || thread.name === `${this.config.repository} #${issue} - builder`) : [];
        const selected = threadId ? candidates.find(thread => thread.id === threadId) : eligible.length === 1 ? eligible[0] : null;
        if (!selected) throw new Error(`Thread ownership for the ${targetRole} is uncertain. Inspect Codex threads for this worktree, then use resume ISSUE --role ${targetRole} --thread ID; no replacement session was started.`);
        const recovered = await client.readThread({ threadId: selected.id });
        if (recovered.turns?.some(turn => turn.status === 'inProgress')) throw new Error('The selected thread is still active; reconcile its owner first.');
        this.assertRunning();
        job[field] = selected.id; savedThread = selected.id; if (targetRole === 'builder') job.threadId = selected.id;
        await client.setThreadName({ threadId: selected.id, name: expectedName }); await this.save();
      } finally { await client.close(); }
    } else if (threadId && threadId !== savedThread) throw new Error(`This issue already owns a different ${targetRole} thread.`);
    this.assertRunning();
    if (eligibilityRevision) job.eligibilityRevision = eligibilityRevision;
    if (designHandoff !== undefined) { job.designHandoff = structuredClone(designHandoff); job.designHandoffValidation = null; }
    const previousIntent = job.intent;
    job.intent = null;
    if (!job.prepared) {
      try {
        try {
          await access(job.worktree);
          const marker = await git(job.worktree, 'rev-parse', '--absolute-git-dir');
          if ((await readFile(join(marker, 'conductor-owned-worktree'), 'utf8')).trim() !== this.repo.root) throw new Error('Worktree ownership does not match.');
          if (await git(job.worktree, 'branch', '--show-current') !== job.branch) throw new Error('Worktree branch does not match its issue owner.');
          job.worktreeCreated = true;
        } catch (error) { if (error.code !== 'ENOENT') throw error; if (job.worktreeCreated) throw new Error('The recorded worktree or ownership marker is missing; preserve state and reconcile it.'); }
        // Explicit resume authorizes repeating an interrupted preparation command.
        const base = await this.base();
        if (this.director) await this.guard(job);
        await this.prepare(job, base);
      } catch (error) {
        job.intent ??= previousIntent;
        await this.save();
        throw error;
      }
    }
    this.assertRunning();
    if (recoveringPull && !job.pullCreationPending) return;
    if (!this.hasResumeCapacity(job)) {
      job.intent = previousIntent;
      throw new Error('No issue capacity is available.');
    }
    job.activeRole = targetRole; job.nextRole = targetRole; job.phase = 'stopped'; job.repairAttempts = 0;
    delete job.runnerInterrupted; delete job.pullCreationPending;
    await this.save(); this.wake();
  }
  async haltClient(job, client) {
    this.handoffChecks.get(job.issue)?.abort();
    const threadId = job.activeRole === 'reviewer' ? job.reviewerThreadId : job.builderThreadId ?? job.threadId;
    if (job.turnId && threadId) await client.interrupt({ threadId, turnId: job.turnId }).catch(error => this.emit('notice', error.message));
    // EOF also resolves pending startup RPCs. The client waits for process exit;
    // cancellation never depends on receiving a final assistant message.
    await client.close();
  }
  async stopWorker(job, client) {
    const role = job.activeRole ?? job.runnerInterrupted?.role;
    const threadId = role === 'reviewer' ? job.reviewerThreadId : job.builderThreadId ?? job.threadId;
    // Send the interrupt before EOF. A missing RPC response must not prevent
    // closing the owned worker process or interrupting other workers.
    const interrupt = job.turnId && threadId ? client.interrupt({ threadId, turnId: job.turnId }) : null;
    const outcomes = await Promise.allSettled([interrupt, client.close()]);
    const failures = outcomes.filter(result => result.status === 'rejected').map(result => result.reason.message);
    if (failures.length) throw new Error(`Issue #${job.issue} worker interruption needs reconciliation: ${failures.join(' ')}`);
  }
  async stopMerge(job) {
    if (!job.mergeArmed) return;
    try {
      if (!job.pr) throw new Error('The armed merge has no saved PR number. Inspect the original branch.');
      await this.disarm(job);
      delete job.deliveryReconciliationRequired;
    } catch (error) {
      job.lastError = error.message;
      job.deliveryReconciliationRequired = true;
      throw new Error(`Issue #${job.issue}, PR #${job.pr}: ${error.message}`);
    } finally { await this.save(); }
  }
  async stop({ explicit = false } = {}) {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true; clearInterval(this.timer);
    this.activityWatcher?.close(); clearInterval(this.activityTimer);
    this.stopPromise = (async () => {
      if (explicit) {
        try { await this.pauseRunner(); }
        catch (error) { this.stopPromise = undefined; throw error; }
      }
      const halts = [];
      for (const job of this.state.jobs) {
        if (!explicit && !job.intent && !['complete','cancelled'].includes(job.phase)) job.intent = 'stop';
        this.handoffChecks.get(job.issue)?.abort();
        const client = this.clients.get(job.issue);
        if (client) halts.push(explicit ? this.stopWorker(job, client) : this.haltClient(job, client));
      }
      const drains = [this.loop.close(), ...this.preparations.values(), ...this.tasks.values(), ...this.controls, this.handoffProgress, this.worktreeCleanup, ...halts];
      if (this.hostStartup) {
        drains.push(this.directorHost.close());
        drains.push(this.hostStartup.catch(() => {}));
      }
      if (explicit) {
        drains.push(Promise.resolve(this.handoffProgress).catch(() => {}).then(() => this.director?.events.stop()));
        // A merge RPC may have reached GitHub before the stop gate closed.
        // Recheck after that delivery operation returns so it cannot re-arm.
        drains.push(this.deliveryAction(async () => {
          const armed = this.state.jobs.filter(job => job.mergeArmed);
          const results = await Promise.allSettled(armed.map(job => this.stopMerge(job)));
          const warnings = results.filter(result => result.status === 'rejected').map(result => result.reason.message);
          if (warnings.length) throw new Error(warnings.join(' '));
        }));
      }
      const results = await Promise.allSettled(drains);
      const warnings = results.filter(result => result.status === 'rejected').map(result => result.reason.message);
      try { await this.directorHost?.close(); }
      catch (error) { warnings.push(error.message); }
      this.directorActivity?.close();
      if (explicit) {
        for (const job of this.state.jobs) this.settleRunnerInterruption(job);
        const uncertain = this.state.jobs.filter(job => job.phase === 'uncertain' && job.runnerInterrupted || job.pullCreationPending)
          .map(job => `Issue #${job.issue} needs reconciliation before its original work can resume.`);
        for (const warning of uncertain) this.emit('notice', warning);
        if (warnings.length || uncertain.length) this.state.runnerPause.warnings = [...warnings, ...uncertain];
      }
      this.state.running = false; this.state.serviceReady = false;
      try { await this.save(); }
      catch (error) {
        // Only a failed final save retains ownership and permits stop retry.
        this.stopPromise = undefined;
        throw error;
      }
      await this.store.release(); this.emit('stopped');
      if (warnings.length) throw new Error(warnings.join(' '));
    })();
    return this.stopPromise;
  }
}
