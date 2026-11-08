import { randomUUID } from 'node:crypto';
import { activeHoldApplies, eligibility, workflowState } from './workflow.mjs';
import { DirectorEvents } from './director-events.mjs';
import { occupied } from './scheduler.mjs';
import { readDecisions, recordDecision } from './decisions.mjs';
import { runnerPause, RUNNER_PAUSED_MESSAGE } from './runner-state.mjs';
import { remoteHolds, createRemoteHoldReceipt, applyRemoteHold, releaseRemoteHold } from './remote-holds.mjs';

const pauseSafeOperations = new Set(['status', 'settle', 'wakeup', 'decision-read', 'enable', 'events', 'ack', 'retry-wakeup', 'bind', 'attach', 'resume-runner', 'stop', 'reconcile-delivery']);

// Policy is judged by the director. This owner enforces a fresh, bounded command
// and retains barriers before attempting any non-atomic GitHub mutation.
export class Director {
  constructor(coordinator, threadId) {
    this.c = coordinator;
    const state = coordinator.state.director ??= {};
    this.events = new DirectorEvents({ state, threadId: threadId ?? state.threadId,
      save: () => coordinator.save(), execute: coordinator.execute, cwd: coordinator.repo.root, host: coordinator.directorHost,
      runnerPause: () => runnerPause(coordinator.state), stopping: () => coordinator.stopping || coordinator.runnerStopRequested || coordinator.runnerResuming });
    coordinator.state.holds ??= [];
    coordinator.state.admissionPaused ??= coordinator.config.admissionPaused ?? false;
  }
  async snapshot(number) { return eligibility(this.c.github, number, this.c.config.labels); }
  assertInteractionReleased() {
    if (this.c.state.director.interaction?.active) throw new Error('Interactive resolution is active; finish the batch or explicitly wake up before starting or resuming work.');
  }
  async beginInteraction(request) {
    const state = this.c.state.director;
    if (typeof request.batchKey !== 'string' || !request.batchKey.trim()) throw new Error('Interaction requires a stable batchKey describing the unresolved decisions.');
    if (state.interaction?.active) {
      if (state.interaction.batchKey !== request.batchKey) throw new Error('An interaction is already active; continue its remaining decisions.');
    } else {
      if (state.interaction?.batchKey === request.batchKey && state.interaction?.outcome === 'wakeup') throw new Error('This batch was explicitly bypassed; do not reopen it without changed decisions or a user request.');
      state.interaction = { id: randomUUID(), batchKey: request.batchKey, active: true, issues: [], startedAt: new Date().toISOString() };
      await this.c.save();
    }
    // Close the in-flight queue race before asking. Only persisted Conductor
    // batches are eligible for cancellation; user queue entries are untouched.
    await this.events.flushing;
    for (const batch of state.batches) if (batch.queueItemId && !batch.nativeConsumed && !batch.queueCancellationConfirmed) {
      if (await this.events.cancelWake(batch)) batch.status = 'reconciled-not-queued';
    }
    await this.c.save();
    if (state.recoveryRequired && !state.recoveryRequired.resolvedAt) throw new Error('Interaction is gated, but queue recovery must be reconciled before presenting a question.');
    return structuredClone(state.interaction);
  }
  async completeInteraction(request) {
    const state = this.c.state.director;
    const phase = state.interaction;
    if (!phase?.active || request.interactionId !== phase.id) throw new Error('Complete requires the active interactionId.');
    for (const issue of phase.issues ?? []) {
      const saved = await readDecisions(this.c.github, issue);
      if (saved.decisions.some(item => ['pending', 'answered'].includes(item.record.status))) throw new Error(`Issue #${issue} still has pending decisions or answers awaiting integration.`);
    }
    if (request.checkRevision !== state.checkRevision) throw new Error('Inspect and reconcile current events before completing interaction.');
    await this.events.settle(request.checkRevision);
    // Settlement may await queue reconciliation while observations arrive.
    if (request.checkRevision !== state.checkRevision) throw new Error('Events changed during settlement; reconcile before completing interaction.');
    phase.active = false; phase.outcome = 'completed'; phase.endedAt = new Date().toISOString();
    await this.c.save();
    return structuredClone(phase);
  }
  async releaseInteractionForWakeup() {
    const phase = this.c.state.director.interaction;
    if (phase?.active) {
      phase.active = false; phase.outcome = 'wakeup'; phase.endedAt = new Date().toISOString();
      await this.c.save();
    }
  }
  async barrier(number, { admission = true } = {}) {
    if (this.c.executionBlocked?.() || runnerPause(this.c.state)) return RUNNER_PAUSED_MESSAGE;
    if (admission && this.c.state.admissionPaused) return 'Repository admission is paused.';
    const parents = await this.c.github.parents(number);
    if (activeHoldApplies(this.c.state.holds, number, parents)) return 'An unreleased local hold applies.';
    return null;
  }
  async assertEligible(number, expectedRevision, { allowCompleted = false } = {}) {
    const barrier = await this.barrier(number);
    if (barrier) throw new Error(barrier);
    const current = await this.snapshot(number);
    this.c.assertRunning?.();
    const reasons = allowCompleted && current.issue.state === 'closed' && current.issue.state_reason === 'completed'
      ? current.reasons.filter(reason => reason !== 'issue is closed') : current.reasons;
    if (reasons.length) throw new Error(reasons.join('; '));
    if (expectedRevision && current.revision !== expectedRevision) throw new Error('Issue eligibility revision changed; reconcile before dispatch or delivery.');
    return current;
  }
  async checkJob(job) {
    if (this.c.executionBlocked?.()) return false;
    if (job.intent || ['paused','blocked','uncertain','complete','cancelled'].includes(job.phase)) {
      // A blocked builder may still have armed auto-merge from earlier work.
      if (job.pr && job.mergeArmed) await this.pause(job.issue, 'Reconcile blocked delivery before advancing.');
      return false;
    }
    try { await this.assertEligible(job.issue, job.eligibilityRevision); return true; }
    catch (error) {
      if (!this.c.executionBlocked?.() && !job.runnerInterrupted) await this.pause(job.issue, error.message);
      return false;
    }
  }
  async observe() {
    const c = this.c;
    const issues = await c.github.openIssues();
    for (const job of c.state.jobs) if (!['complete','cancelled'].includes(job.phase) && !issues.some(issue => issue.number === job.issue)) issues.push(await c.github.issue(job.issue));
    const summaries = [];
    for (const issue of issues) {
      const current = await this.snapshot(issue.number);
      const barrier = await this.barrier(issue.number);
      summaries.push({ number: issue.number, title: issue.title, ...workflowState(issue, c.config.labels),
        eligible: current.eligible && !barrier, reasons: [...current.reasons, ...(barrier ? [barrier] : [])], revision: current.revision });
    }
    await this.events.observe('issues', summaries.sort((a,b) => a.number-b.number), { kind: 'tracker-changed' });
    for (const job of c.state.jobs) {
      await this.events.observe(`job:${job.issue}`, { phase: job.phase, summary: job.summary, lastError: job.lastError, pr: job.pr, turnCount: job.turnCount }, { kind: 'job-changed', issue: job.issue });
      if (job.pr && !['complete','cancelled'].includes(job.phase)) {
        const pull = await c.github.pull(job.pr);
        const feedback = await c.github.feedback(job.pr, pull.headRefOid);
        await this.events.observe(`pr:${job.pr}`, { pull, feedback }, { kind: 'delivery-changed', issue: job.issue });
      }
    }
    this.issues = summaries;
    c.state.director.issues = summaries;
    await c.save();
    await this.events.flush();
    return summaries;
  }
  async pause(number, reason = 'Paused by director') {
    const c = this.c, job = c.state.jobs.find(j => j.issue === number);
    c.assertRunning?.();
    if (!job || ['complete','cancelled'].includes(job.phase)) return { issue: number, state: job?.phase ?? 'not-started', deliveryBarrierEstablished: !job?.deliveryReconciliationRequired };
    job.intent = 'pause'; job.summary = reason; await c.save();
    c.handoffChecks?.get(number)?.abort();
    let warning;
    if (job.pr && !(job.deliveryEvidence && !job.deliveryReconciliationRequired)) {
      try {
        await c.deliveryAction(() => c.disarm(job));
        if (job.deliveryReconciliationRequired) job.lastError = null;
        job.deliveryReconciliationRequired = false;
      }
      catch (error) {
        job.lastError = error.message;
        warning = error.message;
        job.deliveryReconciliationRequired = true;
        await c.save();
        // Continue stopping the worker even if a remote merge cannot be undone.
      }
    }
    const client = c.clients.get(number);
    if (client) await c.haltClient(job, client);
    await c.preparations?.get(number);
    await c.tasks.get(number);
    job.phase = 'paused'; job.nextRole ??= job.activeRole ?? 'builder';
    await c.save();
    const result = { issue: number, state: 'paused', deliveryBarrierEstablished: !job.deliveryReconciliationRequired,
      deliveryReconciliationRequired: !!job.deliveryReconciliationRequired, warning };
    if (result.deliveryBarrierEstablished) this.recordDeliveryBarrier(job.issue);
    await this.events.emit({ kind: 'paused', reason, ...result });
    return result;
  }
  recordDeliveryBarrier(issue) {
    for (const hold of this.c.state.holds.filter(item => item.active && item.deliveryReconciliationRequired?.includes(issue))) {
      hold.deliveryReconciliationRequired = hold.deliveryReconciliationRequired.filter(number => number !== issue);
      hold.deliveryBarrierEstablished = hold.deliveryReconciliationRequired.length === 0;
      hold.applied = !!hold.labelsApplied && hold.deliveryBarrierEstablished;
    }
  }
  async expand(numbers, descendants) {
    const found = new Set(numbers);
    if (descendants) for (const number of found) for (const child of await this.c.github.children(number)) found.add(child.number);
    return [...found];
  }
  async hold(request) {
    const c = this.c;
    const roots = request.all ? (await c.github.openIssues()).map(i => i.number) : request.issues ?? [request.issue];
    if (!roots.length || roots.some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error('Hold requires issue numbers or all:true.');
    // Cleanup uses a snapshot of active holds. Wait for any sweep that already
    // took its snapshot, then publish the hold before another sweep can start.
    while (c.worktreeCleanup) await c.worktreeCleanup;
    c.assertRunning?.();
    const record = { id: request.holdId ?? randomUUID(), active: true, all: request.all === true, issues: [...roots], previous: {}, attempted: [], reason: request.reason ?? 'Held for revision', createdAt: new Date().toISOString() };
    if (c.state.holds.some(h => h.id === record.id)) throw new Error('Hold ID already exists; inspect its receipt instead of duplicating it.');
    c.state.holds.push(record); await c.save();
    // Root barriers protect descendants even while enumeration/label writes fail.
    record.issues = await this.expand(roots, request.descendants === true); await c.save();
    const pauses = [];
    for (const job of c.state.jobs) if (await this.barrier(job.issue)) pauses.push(await this.pause(job.issue, record.reason));
    // A stopped worker does not prove that GitHub stopped an armed merge. Keep
    // the local hold, but never give contract-edit callers a successful barrier.
    record.deliveryBarrierEstablished = pauses.every(result => result.deliveryBarrierEstablished);
    record.deliveryReconciliationRequired = pauses.filter(result => !result.deliveryBarrierEstablished).map(result => result.issue);
    for (const number of record.issues) {
      const issue = await c.github.issue(number);
      record.previous[number] = workflowState(issue, c.config.labels).state;
      await c.save();
      const receipt = await createRemoteHoldReceipt(c.github, { number, holdId: record.id, reason: record.reason, previous: record.previous[number], labels: c.config.labels }, () => c.assertRunning?.());
      record.previous[number] = receipt.record.previous;
      record.attempted.push(number); await c.save();
      await applyRemoteHold(c.github, { number, labels: c.config.labels }, () => c.assertRunning?.());
    }
    record.labelsApplied = true;
    record.applied = record.deliveryBarrierEstablished; await c.save();
    await this.events.emit({ kind: 'held', holdId: record.id, issues: record.issues, applied: record.applied, deliveryReconciliationRequired: record.deliveryReconciliationRequired });
    return record;
  }
  async release(request) {
    const c = this.c;
    let record = c.state.holds.find(h => h.id === request.holdId && h.active);
    if (!record && Number.isSafeInteger(request.issue)) {
      const current = await c.github.issue(request.issue);
      if (workflowState(current, c.config.labels).state !== 'hold') throw new Error('Issue is not held.');
      // Recover only this explicit issue. A missing group record cannot prove
      // that other members were included, so never manufacture a group release.
      const comments = await c.github.comments(request.issue);
      const candidates = remoteHolds(comments, request.issue).map(item => item.record).filter(item => !item.releasedAt && (!request.holdId || item.holdId === request.holdId));
      if (candidates.length !== 1) throw new Error('Identify one active remote holdId before releasing this issue.');
      record = { id: candidates[0].holdId, active: true, issues: [request.issue], previous: { [request.issue]: candidates[0].previous }, recovered: true };
      c.state.holds.push(record); await c.save();
    }
    if (!record) throw new Error('An active holdId is required. Inspect status; never infer release from issue edits.');
    for (const job of c.state.jobs) if (job.deliveryReconciliationRequired && activeHoldApplies([record], job.issue, await c.github.parents(job.issue))) {
      throw new Error(`Issue #${job.issue} delivery needs reconciliation before release; retain the hold and use reconcile-delivery for a merged PR or retry pause to disarm it.`);
    }
    for (const number of record.attempted ?? Object.keys(record.previous).map(Number)) {
      const other = c.state.holds.some(h => h !== record && h.active && (h.all || h.issues.includes(number)));
      await releaseRemoteHold(c.github, { number, holdId: record.id, labels: c.config.labels, otherHold: other }, () => c.assertRunning?.());
    }
    record.active = false; record.releasedAt = new Date().toISOString(); await c.save();
    await this.events.emit({ kind: 'released', holdId: record.id });
    return record;
  }
  async control(request) {
    const c = this.c;
    if (request.repository !== c.config.repository || request.threadId !== c.state.director.threadId) throw new Error('Control repository/director identity does not match its owner.');
    if (!pauseSafeOperations.has(request.op)) c.assertRunning?.();
    switch (request.op) {
      case 'status': {
        await this.observe();
        return { checkRevision: c.state.director.checkRevision, interaction: c.state.director.interaction ?? null, jobs: c.state.jobs, holds: c.state.holds, admissionPaused: c.state.admissionPaused, runnerPause: runnerPause(c.state), issues: this.issues ?? [], requests: [...c.requests].map(([key,r]) => ({ key, issue:r.issue, method:r.method, params:r.params })) };
      }
      case 'settle': return this.events.settle(request.checkRevision);
      case 'wakeup': if (!runnerPause(c.state)) await this.releaseInteractionForWakeup(); return c.requestCheck({ manual: true });
      case 'interaction-begin': return this.beginInteraction(request);
      case 'interaction-complete': return this.completeInteraction(request);
      case 'decision-read':
      case 'decision-integrate':
      case 'decision-record': {
        const current = await readDecisions(c.github, request.issue);
        if (c.state.director.interaction?.active) {
          const issues = c.state.director.interaction.issues ??= [];
          if (!issues.includes(request.issue)) { issues.push(request.issue); await c.save(); }
        }
        if (request.op === 'decision-read') return current;
        if (request.op === 'decision-record' && request.record?.status === 'integrated') throw new Error('Use decision-integrate to reconcile labels before recording integration.');
        if (request.op === 'decision-integrate' && request.record?.status !== 'integrated') throw new Error('Integration requires an integrated record.');
        return recordDecision(c.github, c.config.repository, request, { beforeWrite: async saved => {
          c.assertRunning?.();
          if (request.op !== 'decision-integrate') return;
          if (!['triage', 'proposal', 'ready', 'hold'].includes(request.state) || typeof request.needsInput !== 'boolean') throw new Error('Integration requires the judged primary state and needsInput boolean.');
          const remaining = saved.decisions.filter(item => item.decisionId !== request.decisionId && ['pending', 'answered', 'deferred'].includes(item.record.status));
          if (remaining.length && !request.needsInput) throw new Error('Other unresolved or deferred decisions still require needs-input.');
          const source = await this.snapshot(request.issue);
          if (!request.expectedIssueRevision || source.revision !== request.expectedIssueRevision) throw new Error('Issue revision changed; reconcile meaning and labels before integrating.');
          const held = workflowState(source.issue, c.config.labels).state === 'hold' || await this.barrier(request.issue, { admission: false });
          if (held && request.state !== workflowState(source.issue, c.config.labels).state) throw new Error('Preserve the explicit hold during decision integration.');
          if (request.state === 'hold' && workflowState(source.issue, c.config.labels).state !== 'hold') throw new Error('Use hold to create an explicit hold.');
          c.assertRunning?.();
          await c.github.setWorkflowState(request.issue, request.state, c.config.labels);
          c.assertRunning?.();
          await c.github.setNeedsInput(request.issue, request.needsInput, c.config.labels);
        } });
      }
      case 'enable': {
        c.state.runtimeEnabled = true;
        await c.save();
        return runnerPause(c.state) ? { status: 'runner-paused' } : c.requestCheck({ manual: true });
      }
      case 'events': return this.events.pending();
      case 'ack': { const receipt = await this.events.acknowledge(request.ids); await this.events.flush(); return receipt; }
      case 'retry-wakeup': return this.events.retry(request.batchId, { confirmedNotQueued: request.confirmedNotQueued });
      case 'bind': return { threadId: c.state.director.threadId };
      case 'attach': return c.attachThread(request.targetThreadId);
      case 'activate': c.state.admissionPaused = false; await c.save(); await this.events.emit({kind:'activated'}); return { admissionPaused: false };
      case 'dispatch': {
        this.assertInteractionReleased();
        if (!request.expectedRevision) throw new Error('Dispatch requires expectedRevision from current status.');
        const current = await this.assertEligible(request.issue, request.expectedRevision);
        if (c.state.jobs.some(j => j.issue === request.issue)) throw new Error('Issue already has an owner; resume that job.');
        if (occupied(c.state.jobs) >= c.config.agents) throw new Error('No issue capacity is available.');
        return c.dispatchIssue(current.issue, await c.base(), current.revision, request.designHandoff);
      }
      case 'resume': {
        this.assertInteractionReleased();
        if (!request.expectedRevision) throw new Error('Resume requires expectedRevision.');
        return c.resumeIssue(request);
      }
      case 'pause': return this.pause(request.issue, request.reason);
      case 'reconcile-delivery': {
        const job = c.state.jobs.find(item => item.issue === request.issue);
        if (!job?.pr || job.phase !== 'paused' || job.intent !== 'pause') throw new Error('Delivery evidence reconciliation requires a paused original job with its owned PR.');
        const current = await this.snapshot(request.issue);
        if (!request.expectedRevision || request.expectedRevision !== current.revision) throw new Error('Delivery evidence reconciliation requires the current expectedRevision.');
        const evidence = await c.deliveryAction(() => c.mergedDeliveryEvidence(job));
        if ((await this.snapshot(request.issue)).revision !== current.revision) throw new Error('Issue revision changed during delivery reconciliation; inspect the current evidence again.');
        job.deliveryEvidence = { ...evidence, eligibilityRevision: current.revision };
        job.mergeArmed = false; job.deliveryReconciliationRequired = false; job.lastError = null;
        this.recordDeliveryBarrier(job.issue);
        await c.save();
        await this.events.emit({ kind: 'delivery-reconciled', issue: job.issue });
        return { issue: job.issue, phase: job.phase, deliveryBarrierEstablished: true, deliveryReconciliationRequired: false, evidence: job.deliveryEvidence };
      }
      case 'reconcile': {
        if (!request.expectedRevision) throw new Error('Reconcile requires expectedRevision.');
        const current = await this.assertEligible(request.issue, request.expectedRevision, { allowCompleted: true });
        const job = c.state.jobs.find(j => j.issue === request.issue);
        if (!job?.pr || (await c.github.pull(job.pr)).state !== 'MERGED') throw new Error('This operation reconciles an already merged owned PR; use resume for unfinished work.');
        c.assertRunning?.();
        job.eligibilityRevision = current.revision; job.intent = null; job.phase = 'waiting'; await c.save();
        try {
          await c.deliveryAction(() => c.reconcilePull(job));
          job.deliveryReconciliationRequired = job.phase !== 'complete'; await c.save();
          return { issue: job.issue, phase: job.phase, mergedCommit: job.mergedCommit };
        } catch (error) {
          if (error.code === 'RUNNER_PAUSED') throw error;
          if (job.phase === 'complete') {
            job.deliveryReconciliationRequired = false; job.lastError = error.message; await c.save();
            return { issue: job.issue, phase: 'complete', mergedCommit: job.mergedCommit, warning: error.message };
          }
          job.intent = 'pause'; job.phase = 'paused'; await c.save(); throw error;
        }
      }
      case 'hold': return this.hold(request);
      case 'release': return this.release(request);
      case 'transition': {
        if (request.state === 'hold') return this.hold(request);
        const current = await this.snapshot(request.issue);
        if (!request.expectedRevision || request.expectedRevision !== current.revision) throw new Error('Transition requires the current expectedRevision.');
        if (workflowState(current.issue, c.config.labels).state === 'hold' || await this.barrier(request.issue, { admission: false })) throw new Error('Release the hold explicitly before changing workflow state.');
        c.assertRunning?.();
        const result = await c.github.setWorkflowState(request.issue, request.state, c.config.labels);
        await this.events.emit({ kind: 'workflow-changed', issue: request.issue }); return result;
      }
      case 'answer': await c.answer(request.key, typeof request.value === 'string' ? request.value : JSON.stringify(request.value)); return { answered: request.key };
      case 'signal': return c.requestCheck({ reason: request.reason });
      case 'stop': return c.pauseRunner(request.reason);
      case 'resume-runner': return c.resumeRunner();
      default: throw new Error(`Unknown director operation: ${request.op}`);
    }
  }
}
