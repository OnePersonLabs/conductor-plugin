import { randomUUID } from 'node:crypto';
import { eligibility, workflowState } from './workflow.mjs';
import { DirectorEvents } from './director-events.mjs';
import { occupied } from './scheduler.mjs';

// Policy is judged by the director. This owner enforces a fresh, bounded command
// and retains barriers before attempting any non-atomic GitHub mutation.
export class Director {
  constructor(coordinator, threadId) {
    this.c = coordinator;
    const state = coordinator.state.director ??= {};
    this.events = new DirectorEvents({ state, threadId: threadId ?? state.threadId,
      save: () => coordinator.save(), execute: coordinator.execute, cwd: coordinator.repo.root });
    coordinator.state.holds ??= [];
    coordinator.state.admissionPaused ??= coordinator.config.admissionPaused ?? false;
  }
  async snapshot(number) { return eligibility(this.c.github, number, this.c.config.labels); }
  async barrier(number, { admission = true } = {}) {
    if (admission && this.c.state.admissionPaused) return 'Repository admission is paused.';
    const parents = await this.c.github.parents(number);
    const numbers = new Set([number, ...parents.map(p => p.number)]);
    if (this.c.state.holds.some(h => h.active && (h.all || h.issues.some(n => numbers.has(n))))) return 'An unreleased local hold applies.';
    return null;
  }
  async assertEligible(number, expectedRevision, { allowCompleted = false } = {}) {
    const barrier = await this.barrier(number);
    if (barrier) throw new Error(barrier);
    const current = await this.snapshot(number);
    const reasons = allowCompleted && current.issue.state === 'closed' && current.issue.state_reason === 'completed'
      ? current.reasons.filter(reason => reason !== 'issue is closed') : current.reasons;
    if (reasons.length) throw new Error(reasons.join('; '));
    if (expectedRevision && current.revision !== expectedRevision) throw new Error('Issue eligibility revision changed; reconcile before dispatch or delivery.');
    return current;
  }
  async checkJob(job) {
    if (job.intent || ['paused','blocked','uncertain','complete','cancelled'].includes(job.phase)) {
      // A blocked builder may still have armed auto-merge from earlier work.
      if (job.pr && job.mergeArmed) await this.pause(job.issue, 'Reconcile blocked delivery before advancing.');
      return false;
    }
    try { await this.assertEligible(job.issue, job.eligibilityRevision); return true; }
    catch (error) { await this.pause(job.issue, error.message); return false; }
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
    if (!job || ['complete','cancelled'].includes(job.phase)) return { issue: number, state: job?.phase ?? 'not-started' };
    job.intent = 'pause'; job.summary = reason; await c.save();
    if (job.pr) {
      try { await c.deliveryAction(() => c.disarm(job)); }
      catch (error) {
        job.lastError = error.message;
        if (error.code === 'ALREADY_MERGED') job.deliveryReconciliationRequired = true;
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
    await this.events.emit({ kind: 'paused', issue: number, reason, warning: job.lastError });
    return { issue: number, state: 'paused', warning: job.lastError };
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
    const record = { id: request.holdId ?? randomUUID(), active: true, all: request.all === true, issues: [...roots], previous: {}, attempted: [], reason: request.reason ?? 'Held for revision', createdAt: new Date().toISOString() };
    if (c.state.holds.some(h => h.id === record.id)) throw new Error('Hold ID already exists; inspect its receipt instead of duplicating it.');
    c.state.holds.push(record); await c.save();
    // Root barriers protect descendants even while enumeration/label writes fail.
    record.issues = await this.expand(roots, request.descendants === true); await c.save();
    for (const job of c.state.jobs) if (await this.barrier(job.issue)) await this.pause(job.issue, record.reason);
    for (const number of record.issues) {
      const issue = await c.github.issue(number);
      record.previous[number] = workflowState(issue, c.config.labels).state;
      await c.save();
      const marker = `<!-- conductor:hold:${record.id} -->`;
      const body = `${marker}\n${record.reason}\n\nPrevious workflow state: ${record.previous[number]}.\n\n${JSON.stringify({ holdId: record.id, issue: number, previous: record.previous[number] })}`;
      if (!(await c.github.comments(number)).some(comment => comment.body === body)) await c.github.api(`repos/${c.config.repository}/issues/${number}/comments`, { method: 'POST', fields: { body } });
      record.attempted.push(number); await c.save();
      await c.github.setWorkflowState(number, 'hold', c.config.labels);
    }
    record.applied = true; await c.save();
    await this.events.emit({ kind: 'held', holdId: record.id, issues: record.issues });
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
      const candidates = comments.filter(x => x.body?.startsWith('<!-- conductor:hold:')).map(x => {
        try { return JSON.parse(x.body.trim().split('\n').at(-1)); } catch { return null; }
      }).filter(x => x?.issue === request.issue && (!request.holdId || x.holdId === request.holdId));
      const previous = candidates.length === 1 ? candidates[0].previous : 'triage';
      record = { id: request.holdId ?? randomUUID(), active: true, issues: [request.issue], previous: { [request.issue]: previous }, recovered: true };
      c.state.holds.push(record); await c.save();
    }
    if (!record) throw new Error('An active holdId is required. Inspect status; never infer release from issue edits.');
    for (const number of record.attempted ?? Object.keys(record.previous).map(Number)) {
      const other = c.state.holds.some(h => h !== record && h.active && (h.all || h.issues.includes(number)));
      if (other) continue;
      const current = await c.github.issue(number);
      const hasHold = (current.labels ?? []).some(label => (typeof label === 'string' ? label : label.name).toLowerCase() === c.config.labels.hold.toLowerCase());
      if (!hasHold) continue; // A failed write or a later explicit edit is not ours to reset.
      let previous = record.previous[number];
      if (previous === 'hold') {
        const original = c.state.holds.find(h => h !== record && h.previous[number] && h.previous[number] !== 'hold');
        previous = original?.previous[number];
      }
      if (!['triage','proposal','ready'].includes(previous)) previous = 'triage';
      await c.github.setWorkflowState(number, previous, c.config.labels);
    }
    record.active = false; record.releasedAt = new Date().toISOString(); await c.save();
    await this.events.emit({ kind: 'released', holdId: record.id });
    return record;
  }
  async control(request) {
    const c = this.c;
    if (request.repository !== c.config.repository || request.threadId !== c.state.director.threadId) throw new Error('Control repository/director identity does not match its owner.');
    switch (request.op) {
      case 'status': {
        await this.observe();
        return { jobs: c.state.jobs, holds: c.state.holds, admissionPaused: c.state.admissionPaused, issues: this.issues ?? [], requests: [...c.requests].map(([key,r]) => ({ key, issue:r.issue, method:r.method, params:r.params })) };
      }
      case 'events': return this.events.pending();
      case 'ack': { const receipt = await this.events.acknowledge(request.ids); await this.events.flush(); return receipt; }
      case 'retry-wakeup': return this.events.retry(request.batchId, { confirmedNotQueued: request.confirmedNotQueued });
      case 'bind': return { threadId: c.state.director.threadId };
      case 'activate': c.state.admissionPaused = false; await c.save(); await this.events.emit({kind:'activated'}); return { admissionPaused: false };
      case 'dispatch': {
        if (!request.expectedRevision) throw new Error('Dispatch requires expectedRevision from current status.');
        const current = await this.assertEligible(request.issue, request.expectedRevision);
        if (c.state.jobs.some(j => j.issue === request.issue)) throw new Error('Issue already has an owner; resume that job.');
        if (occupied(c.state.jobs) >= c.config.agents) throw new Error('No issue capacity is available.');
        return c.dispatchIssue(current.issue, await c.base(), current.revision);
      }
      case 'resume': {
        if (!request.expectedRevision) throw new Error('Resume requires expectedRevision.');
        const current = await this.assertEligible(request.issue, request.expectedRevision);
        const job = c.state.jobs.find(j => j.issue === request.issue);
        if (!job) throw new Error('No original job to resume.');
        if (job.deliveryReconciliationRequired) throw new Error('PR may already have landed; reconcile delivery before resuming.');
        if (job.phase === 'paused' && occupied(c.state.jobs) >= c.config.agents) throw new Error('No issue capacity is available.');
        job.eligibilityRevision = current.revision; job.intent = null;
        if (job.phase === 'paused') job.phase = 'blocked';
        await c.resume(request.issue, request.workerThreadId, request.role); return { resumed: request.issue };
      }
      case 'pause': return this.pause(request.issue, request.reason);
      case 'reconcile': {
        if (!request.expectedRevision) throw new Error('Reconcile requires expectedRevision.');
        const current = await this.assertEligible(request.issue, request.expectedRevision, { allowCompleted: true });
        const job = c.state.jobs.find(j => j.issue === request.issue);
        if (!job?.pr || (await c.github.pull(job.pr)).state !== 'MERGED') throw new Error('This operation reconciles an already merged owned PR; use resume for unfinished work.');
        job.eligibilityRevision = current.revision; job.intent = null; job.phase = 'waiting'; await c.save();
        try {
          await c.deliveryAction(() => c.reconcilePull(job));
          job.deliveryReconciliationRequired = job.phase !== 'complete'; await c.save();
          return { issue: job.issue, phase: job.phase, mergedCommit: job.mergedCommit };
        } catch (error) {
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
        const result = await c.github.setWorkflowState(request.issue, request.state, c.config.labels);
        await this.events.emit({ kind: 'workflow-changed', issue: request.issue }); return result;
      }
      case 'answer': await c.answer(request.key, typeof request.value === 'string' ? request.value : JSON.stringify(request.value)); return { answered: request.key };
      case 'signal': await this.events.emit({ kind: 'explicit-signal', reason: request.reason }); c.wake(); return { signaled: true };
      case 'stop': await this.events.stop(); return { stopping: true };
      default: throw new Error(`Unknown director operation: ${request.op}`);
    }
  }
}
