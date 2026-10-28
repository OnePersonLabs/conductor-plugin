import { createHash, randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EVENT_BYTES = 16 * 1024;
const MAX_RECEIPTS = 200;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function hash(value) { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }

function normalize(state, threadId) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('director state must be an object.');
  if (state.threadId && state.threadId !== threadId) throw new Error('Director thread binding differs from the saved thread; reconcile before rebinding.');
  state.threadId ??= threadId;
  state.enabled ??= true;
  state.snapshots ??= {};
  state.events ??= [];
  state.batches ??= [];
  state.acknowledged ??= [];
  if (!Array.isArray(state.events) || !Array.isArray(state.batches) || !Array.isArray(state.acknowledged)) throw new Error('Invalid director event recovery state; preserve it for inspection.');
  for (const batch of state.batches) if (batch.status === 'submitting') {
    // The process may have died after codex accepted the message. Never replay it
    // until an operator has reconciled the target thread.
    batch.status = 'uncertain';
    batch.error = 'Process restarted during queue submission; delivery outcome requires reconciliation.';
    batch.uncertainAt ??= new Date().toISOString();
  }
}

export class DirectorEvents {
  constructor({ state, save, execute, cwd, threadId, host }) {
    if (!UUID.test(threadId ?? '')) throw new TypeError('A valid director thread UUID is required.');
    if (typeof save !== 'function' || typeof execute !== 'function') throw new TypeError('save and execute functions are required.');
    Object.assign(this, { state, save, execute, cwd, threadId, host });
    normalize(this.state, threadId);
    this.state.checkRevision ??= 0;
    this.state.checkedRevision ??= 0;
    this.flushing = null;
  }

  async observe(key, value, event) {
    if (typeof key !== 'string' || !key.trim()) throw new TypeError('Observation key must be a nonempty string.');
    const next = hash(value);
    const previous = this.state.snapshots[key];
    if (previous === next) return { changed: false, event: null };
    this.state.snapshots[key] = next;
    const result = await this.emit({ kind: event?.kind ?? 'observed-change', key, ...event, revision: next });
    await this.save();
    return { changed: true, event: result };
  }

  async emit(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('Event must be an object.');
    const serialized = JSON.stringify(event);
    if (Buffer.byteLength(serialized) > MAX_EVENT_BYTES) throw new RangeError(`Director events are limited to ${MAX_EVENT_BYTES} bytes.`);
    if (event.dedupeKey) {
      const existing = this.state.events.find(item => item.dedupeKey === event.dedupeKey && !item.acknowledgedAt);
      if (existing) return existing;
    }
    const item = { id: randomUUID(), revision: ++this.state.checkRevision, createdAt: new Date().toISOString(), event: structuredClone(event), dedupeKey: event.dedupeKey ?? null, acknowledgedAt: null };
    this.state.pendingCheck = true;
    this.state.events.push(item);
    await this.save();
    return item;
  }

  async pending() { return structuredClone(this.state.events.filter(item => !item.acknowledgedAt)); }

  async cancelWake(batch) {
    if (batch.queueCancellationConfirmed) return true;
    batch.cancellationRequired = true;
    await this.save();
    try {
      const removed = await this.host.cancelQueuedWakeup(batch.queueItemId);
      if (removed) batch.queueCancellationConfirmed = true;
      if (!removed && !batch.nativeConsumed) {
        // Queue absence also means consumed. Settlement is not a lifecycle
        // receipt: the turn may still be running while it acknowledges work.
        this.state.recoveryRequired = {
          native: true, status: 'lifecycle-receipt-missing', batchId: batch.id,
          queueItemId: batch.queueItemId, turnId: this.state.nativeActivity?.turnId ?? null,
          error: 'The Desktop wake left the queue without a matching lifecycle receipt. Automatic wakeups are suspended; inspect the native chat and hook execution before manually resuming.',
        };
      }
      delete batch.cancellationRequired;
      const recovery = this.state.recoveryRequired;
      if (recovery?.status === 'queue-cancellation-failed' && recovery.queueItemId === batch.queueItemId) {
        recovery.resolvedAt = new Date().toISOString();
      }
      await this.save();
      return removed;
    } catch (error) {
      this.state.recoveryRequired = { status: 'queue-cancellation-failed', queueItemId: batch.queueItemId, batchId: batch.id, error: error.message };
      await this.save();
      throw error;
    }
  }

  async acknowledge(ids) {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new TypeError('Acknowledgement requires event IDs.');
    const selected = new Set(ids);
    const now = new Date().toISOString();
    for (const item of this.state.events) if (selected.has(item.id) && !item.acknowledgedAt) {
      item.acknowledgedAt = now;
      this.state.acknowledged.push({ id: item.id, acknowledgedAt: now });
    }
    for (const batch of this.state.batches) if (batch.eventIds.every(id => this.state.events.find(item => item.id === id)?.acknowledgedAt)) {
      // A manual Desktop turn can handle the work before its queued wake is
      // consumed. Remove that obsolete native queue item instead of waking again.
      if (batch.queueItemId && !batch.nativeConsumed && !batch.acknowledgedAt) await this.cancelWake(batch);
      batch.acknowledgedAt ??= now;
    }
    this.state.acknowledged = this.state.acknowledged.slice(-MAX_RECEIPTS);
    this.pruneSettled();
    await this.save();
    return { acknowledged: ids };
  }

  pruneSettled() {
    const recoveryBatch = this.state.recoveryRequired?.resolvedAt ? null : this.state.recoveryRequired?.batchId;
    const removable = new Set(this.state.batches.filter(batch => {
      const terminal = batch.turnStatus === 'completed' || batch.turnStatus === 'failed' || batch.turnStatus === 'interrupted' || batch.status === 'reconciled-ended';
      const queueSettled = !batch.queueItemId || batch.nativeConsumed || batch.queueCancellationConfirmed;
      return batch.acknowledgedAt && terminal && queueSettled && batch.id !== recoveryBatch;
    }).map(batch => batch.id));
    if (removable.size) {
      const removedEvents = new Set(this.state.batches.filter(batch => removable.has(batch.id)).flatMap(batch => batch.eventIds));
      this.state.batches = this.state.batches.filter(batch => !removable.has(batch.id));
      this.state.events = this.state.events.filter(item => !removedEvents.has(item.id) || !item.acknowledgedAt);
    }
    const remainingEvents = new Set(this.state.batches.flatMap(batch => batch.eventIds));
    this.state.events = this.state.events.filter(item => !item.acknowledgedAt || remainingEvents.has(item.id));
    this.state.acknowledged = this.state.acknowledged.slice(-MAX_RECEIPTS);
    return removable.size;
  }

  async settle(revision) {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision > this.state.checkRevision) throw new Error('Settle requires a checkRevision from current status.');
    // Consume only the snapshot the director actually inspected. A concurrent
    // change remains pending and is reconsidered on turn completion.
    await this.acknowledge(this.state.events.filter(item => (item.revision ?? 0) <= revision).map(item => item.id));
    this.state.checkedRevision = Math.max(this.state.checkedRevision, revision);
    this.state.pendingCheck = this.state.checkedRevision < this.state.checkRevision;
    await this.save();
    return { idle: !this.state.pendingCheck, checkRevision: this.state.checkRevision };
  }

  flush() {
    // All callers share one submission. An acknowledgement is not a turn-end.
    if (this.flushing) return this.flushing;
    this.flushing = this._flush().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async _flush() {
    if (this.state.handoff) return { status: 'handoff-pending', handoff: structuredClone(this.state.handoff) };
    if (!this.state.enabled) return { status: 'disabled' };
    if (this.state.recoveryRequired && !this.state.recoveryRequired.resolvedAt) return { status: 'recovery-required', reason: this.state.recoveryRequired };
    if (this.host) {
      const status = await this.host.status();
      if (status.type !== 'idle') return { status: status.type === 'active' ? 'busy' : 'unavailable', hostStatus: status };
    }
    if (this.state.batches.some(batch => batch.status === 'uncertain' && !batch.acknowledgedAt)) return { status: 'uncertain', batch: this.state.batches.find(batch => batch.status === 'uncertain' && !batch.acknowledgedAt) };
    const waiting = this.state.batches.find(batch => ['submitting','queued'].includes(batch.status) && !batch.acknowledgedAt);
    if (waiting) return { status: waiting.status === 'queued' ? 'awaiting-acknowledgement' : 'submitting', batch: structuredClone(waiting) };
    const deliveryStates = new Set(['submitting', 'queued', 'uncertain']);
    const unsent = this.state.events.filter(item => !item.acknowledgedAt && !this.state.batches.some(batch => deliveryStates.has(batch.status) && batch.eventIds.includes(item.id)));
    if (!unsent.length) return { status: 'idle' };
    const batch = { id: randomUUID(), eventIds: unsent.map(item => item.id), status: 'submitting', createdAt: new Date().toISOString(), threadId: this.threadId };
    this.state.batches.push(batch);
    await this.save();
    const message = `Conductor event batch ${batch.id}. Reconcile these persisted event IDs before acting: ${batch.eventIds.join(', ')}. Acknowledge them only after handling.`;
    try {
      const turn = this.host ? await this.host.startRunner({ prompt: message, revision: batch.id }) : null;
      const result = this.host ? { code: 0, stdout: turn.id } : await this.execute('codex', ['queue', '--thread', this.threadId, '--message', message], { cwd: this.cwd });
      if (turn?.queued) {
        batch.queueItemId = turn.id; batch.clientMessageId = turn.clientMessageId;
        // A native manual turn can settle (or stop) while queue/add is in
        // flight, before acknowledgement has a queue ID it can remove.
        if ((batch.acknowledgedAt || !this.state.enabled) && !batch.nativeConsumed) {
          await this.cancelWake(batch);
        }
      }
      else if (turn) batch.turnId = turn.id;
      if (result?.code !== 0) throw Object.assign(new Error(result?.stderr || `codex queue failed (${result?.code}).`), { result });
      batch.status = 'queued'; batch.queuedAt = new Date().toISOString(); batch.receipt = String(result?.stdout ?? '').slice(0, 1000);
      await this.save();
      return { status: 'queued', batch: structuredClone(batch) };
    } catch (error) {
      if (['DIRECTOR_BUSY', 'DIRECTOR_UNAVAILABLE', 'DIRECTOR_RECOVERY_REQUIRED'].includes(error.code)) {
        batch.status = 'reconciled-not-queued';
        batch.error = error.message;
        await this.save();
        return { status: error.code === 'DIRECTOR_BUSY' ? 'busy' : error.code === 'DIRECTOR_RECOVERY_REQUIRED' ? 'recovery-required' : 'unavailable' };
      }
      batch.status = 'uncertain'; batch.error = String(error.message ?? error).slice(0, 1000); batch.uncertainAt = new Date().toISOString();
      await this.save();
      return { status: 'uncertain', batch: structuredClone(batch) };
    }
  }

  async retry(batchId, { confirmedNotQueued = false } = {}) {
    const batch = this.state.batches.find(item => item.id === batchId);
    if (batch?.cancellationRequired && batch.queueItemId) {
      const removed = await this.cancelWake(batch);
      if (removed) batch.status = 'reconciled-not-queued';
      await this.save();
      return this.flush();
    }
    if (!batch || batch.status !== 'uncertain') throw new Error('Only an uncertain queue submission can be retried.');
    if (this.host?.hostMode === 'codex-desktop') {
      const queued = await this.host.findQueuedWakeup(batch.id);
      if (queued) {
        batch.status = 'queued'; batch.queueItemId = queued.id; batch.clientMessageId = queued.clientUserMessageId;
        await this.save(); return { status: 'awaiting-acknowledgement', batch: structuredClone(batch) };
      }
      // Absence cannot prove non-delivery: the native host may have consumed it.
    }
    if (confirmedNotQueued !== true) throw new Error('Inspect the target thread first; confirmNotQueued is required to retry an uncertain submission.');
    batch.status = 'reconciled-not-queued';
    delete batch.error;
    await this.save();
    // Preserve the uncertain receipt and its explicit reconciliation before retrying.
    return this.flush();
  }

  async stop() {
    this.state.enabled = false; await this.save();
    for (const batch of this.state.batches) if (batch.queueItemId && !batch.nativeConsumed && !batch.acknowledgedAt) {
      const removed = await this.cancelWake(batch);
      if (removed) batch.status = 'reconciled-not-queued';
    }
    await this.save();
  }
  async start() { this.state.enabled = true; await this.save(); }
}
