import { workflowState } from './workflow.mjs';

export function remoteHolds(comments, issue) {
  return comments.filter(comment => comment.body?.startsWith('<!-- conductor:hold:')).map(comment => {
    let record;
    try { record = JSON.parse(comment.body.trim().split('\n').at(-1)); } catch {}
    if (!record?.holdId || record.issue !== issue || !comment.body.startsWith(`<!-- conductor:hold:${record.holdId} -->`) ||
        !['triage', 'proposal', 'ready', 'hold', 'conflict'].includes(record.previous)) {
      throw new Error(`Malformed hold receipt on issue #${issue}; reconcile it before changing a hold.`);
    }
    return { comment, record };
  });
}

const receiptBody = (record, reason) => `<!-- conductor:hold:${record.holdId} -->\n${reason}\n\nPrevious workflow state: ${record.previous}.\n\n${JSON.stringify(record)}`;
const unique = (receipts, holdId, number) => {
  const matches = receipts.filter(item => item.record.holdId === holdId);
  if (matches.length > 1) throw new Error(`Hold ${holdId} has duplicate receipts on issue #${number}; reconcile them before changing a hold.`);
  return matches[0];
};

export async function createRemoteHoldReceipt(github, { number, holdId, reason = 'Held for revision', previous, labels }, beforeWrite = () => {}) {
  const receipts = remoteHolds(await github.comments(number), number);
  const existing = unique(receipts, holdId, number);
  if (existing) {
    if (existing.record.releasedAt) throw new Error('This holdId was released; do not revive it.');
    return existing;
  }
  if (workflowState(await github.issue(number), labels).state !== previous) throw new Error(`Issue #${number} workflow changed before hold creation; inspect it before retrying.`);
  const record = { holdId, issue: number, previous };
  const body = receiptBody(record, reason);
  await beforeWrite();
  try { await github.api(`repos/${github.repository}/issues/${number}/comments`, { method: 'POST', fields: { body } }); }
  catch (error) {
    const found = unique(remoteHolds(await github.comments(number), number), holdId, number);
    if (found?.comment.body !== body) throw error;
  }
  const verified = unique(remoteHolds(await github.comments(number), number), holdId, number);
  if (verified?.comment.body !== body) throw new Error(`Hold receipt could not be verified on issue #${number}.`);
  return verified;
}

async function updateReceipt(github, number, owned, fields, beforeWrite) {
  // Always start from the current remote body. An uncertain response is
  // reconciled by exact readback before any caller can retry the mutation.
  const current = unique(remoteHolds(await github.comments(number), number), owned.record.holdId, number);
  if (!current) throw new Error(`Hold receipt disappeared on issue #${number}; preserve its restriction.`);
  const body = current.comment.body.trim().split('\n').slice(0, -1).concat(JSON.stringify({ ...current.record, ...fields })).join('\n');
  await beforeWrite();
  try { await github.api(`repos/${github.repository}/issues/comments/${current.comment.id}`, { method: 'PATCH', fields: { body } }); }
  catch (error) {
    if (!(await github.comments(number)).some(item => item.id === current.comment.id && item.body === body)) throw error;
  }
  const verified = unique(remoteHolds(await github.comments(number), number), owned.record.holdId, number);
  if (verified?.comment.body !== body) throw new Error(`Hold receipt update could not be verified on issue #${number}.`);
  return verified;
}

export async function inspectRemoteHold(github, { number, holdId, labels }) {
  const [issue, comments] = await Promise.all([github.issue(number), github.comments(number)]);
  const receipts = remoteHolds(comments, number);
  const owned = unique(receipts, holdId, number);
  const workflow = workflowState(issue, labels);
  const active = !!owned && !owned.record.releasedAt;
  const state = owned?.record.releaseCompletedAt ? 'released' : !active ? 'incomplete' : workflow.state === 'hold' ? 'held' : 'incomplete';
  return { issue: number, holdId, state, active, deliveryBarrierEstablished: state === 'held',
    receipt: owned ? { id: owned.comment.id, url: owned.comment.html_url, ...owned.record } : null,
    workflow, otherHoldIds: receipts.filter(item => item.record.holdId !== holdId && !item.record.releasedAt).map(item => item.record.holdId) };
}

export async function applyRemoteHold(github, { number, labels }, beforeWrite = () => {}) {
  await beforeWrite();
  await github.ensureWorkflowLabels(labels, ['hold']);
  await beforeWrite();
  return github.setWorkflowState(number, 'hold', labels);
}

export async function releaseRemoteHold(github, { number, holdId, labels, otherHold = false }, beforeWrite = () => {}) {
  let receipts = remoteHolds(await github.comments(number), number);
  let owned = unique(receipts, holdId, number);
  if (!owned) throw new Error(`Hold ${holdId} has no receipt on issue #${number}; reconcile before release.`);
  if (owned.record.releaseCompletedAt) return inspectRemoteHold(github, { number, holdId, labels });
  if (!owned.record.releasedAt) owned = await updateReceipt(github, number, owned, { releasedAt: new Date().toISOString() }, beforeWrite);
  receipts = remoteHolds(await github.comments(number), number);
  if (!otherHold && !receipts.some(item => item.record.holdId !== holdId && !item.record.releasedAt)) {
    const current = await github.issue(number);
    const hasHold = (current.labels ?? []).some(label => (typeof label === 'string' ? label : label.name).toLowerCase() === labels.hold.toLowerCase());
    if (hasHold) {
      let previous = owned.record.previous;
      if (previous === 'hold') {
        const ownIndex = receipts.findIndex(item => item.record.holdId === holdId);
        const original = receipts.slice(0, ownIndex).reverse().find(item => item.record.previous && item.record.previous !== 'hold');
        previous = original?.record.previous;
        if (!previous) throw new Error(`The prior hold on issue #${number} has no recoverable owner; preserve its restriction and reconcile it.`);
      }
      if (!['triage', 'proposal', 'ready'].includes(previous)) previous = 'triage';
      await beforeWrite();
      await github.ensureWorkflowLabels(labels, [previous]);
      await beforeWrite();
      const fresh = remoteHolds(await github.comments(number), number);
      if (!fresh.some(item => item.record.holdId !== holdId && !item.record.releasedAt)) await github.setWorkflowState(number, previous, labels);
    }
  }
  await updateReceipt(github, number, owned, { releaseCompletedAt: new Date().toISOString() }, beforeWrite);
  return inspectRemoteHold(github, { number, holdId, labels });
}
