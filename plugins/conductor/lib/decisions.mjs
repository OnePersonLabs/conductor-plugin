import { createHash } from 'node:crypto';

const PREFIX = '<!-- conductor:decision:v1 -->';
const digest = value => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

// GitHub is the recovery owner. Append stages instead of overwriting a human's
// issue body; a lost POST response is reconciled by its exact content on retry.
export async function readDecisions(github, issue) {
  if (!Number.isSafeInteger(issue) || issue < 1) throw new Error('A positive issue number is required.');
  const records = new Map();
  for (const comment of await github.comments(issue)) {
    if (!comment.body?.startsWith(PREFIX)) continue;
    let entry;
    try { entry = JSON.parse(comment.body.slice(PREFIX.length).trim()); }
    catch { throw new Error(`Malformed decision record on issue #${issue}; reconcile it before continuing.`); }
    if (!nonempty(entry.decisionId) || !entry.record) throw new Error(`Invalid decision record on issue #${issue}.`);
    records.set(entry.decisionId, entry.record);
  }
  const decisions = [...records].map(([decisionId, record]) => ({ decisionId, record }));
  return { issue, revision: digest(decisions), decisions };
}

export async function recordDecision(github, repository, request, { beforeWrite } = {}) {
  const { issue, decisionId, expectedRevision, record } = request;
  if (!nonempty(decisionId) || !record || !nonempty(record.context) || !nonempty(record.question)) throw new Error('Decision ID, context and self-contained question are required.');
  if (!['pending', 'answered', 'integrated', 'deferred'].includes(record.status)) throw new Error('Invalid decision status.');
  if (['answered', 'integrated'].includes(record.status) && !nonempty(record.answer)) throw new Error('An explicit nonempty answer is required.');
  if (record.status === 'integrated' && !nonempty(record.integration)) throw new Error('Verified integration evidence is required.');
  if (record.status === 'deferred' && (!nonempty(record.answer) || !nonempty(record.returnCondition))) throw new Error('Deferral requires an explicit response and return condition.');
  const current = await readDecisions(github, issue);
  const previous = current.decisions.find(item => item.decisionId === decisionId)?.record;
  if (previous && digest(previous) === digest(record)) return current;
  if (expectedRevision !== current.revision) throw new Error('Decision revision changed; read and reconcile before writing.');
  if (previous && previous.context === record.context) {
    if (previous.status === 'integrated' && record.status !== 'integrated') throw new Error('A resolved decision requires materially changed context before reopening.');
    if (previous.status === 'answered' && record.status === 'pending') throw new Error('Integrate the recorded answer instead of asking again.');
  }
  if (record.status === 'integrated' && (!previous || previous.answer !== record.answer || previous.context !== record.context || !['answered', 'integrated'].includes(previous.status))) throw new Error('Persist the answer against its context before integrating it.');
  await beforeWrite?.(current);
  const body = `${PREFIX}\n${JSON.stringify({ decisionId, record }, null, 2)}`;
  try { await github.api(`repos/${repository}/issues/${issue}/comments`, { method: 'POST', fields: { body } }); }
  catch (error) {
    const recovered = await readDecisions(github, issue);
    if (digest(recovered.decisions.find(item => item.decisionId === decisionId)?.record) !== digest(record)) throw error;
    return recovered;
  }
  const verified = await readDecisions(github, issue);
  if (digest(verified.decisions.find(item => item.decisionId === decisionId)?.record) !== digest(record)) throw new Error('Decision write could not be verified; reconcile before asking the next question.');
  return verified;
}
