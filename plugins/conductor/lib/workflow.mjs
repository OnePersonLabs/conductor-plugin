import { createHash } from 'node:crypto';

export const DEFAULT_LABELS = Object.freeze({
  triage: 'triage',
  proposal: 'proposal',
  ready: 'ready',
  hold: 'on-hold',
  needsInput: 'needs-input',
});

const PRIMARY = ['triage', 'proposal', 'ready', 'hold'];
const normalize = value => String(value ?? '').trim().toLowerCase();
const labelNames = issue => (issue?.labels ?? []).map(label => typeof label === 'string' ? label : label?.name).filter(Boolean);
const stable = value => JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
  : item);

export function workflowState(issue, labels = DEFAULT_LABELS) {
  const names = new Set(labelNames(issue).map(normalize));
  const matching = PRIMARY.filter(key => names.has(normalize(labels[key])));
  const conflict = matching.length > 1;
  return {
    state: conflict ? 'conflict' : matching[0] ?? 'triage',
    needsInput: names.has(normalize(labels.needsInput)),
    conflict,
  };
}

function blockerState(blocker) {
  const state = normalize(blocker.state);
  const reason = normalize(blocker.state_reason ?? blocker.stateReason);
  if (state === 'open') return 'open';
  if (state === 'closed' && reason === 'not_planned') return 'not-planned';
  if (state === 'closed' && reason === 'completed') return 'complete';
  return 'unknown';
}

export async function eligibility(github, number, labels = DEFAULT_LABELS) {
  const [issue, dependencies, parents, comments] = await Promise.all([
    github.issue(number), github.dependencies(number), github.parents(number), github.comments(number),
  ]);
  const state = workflowState(issue, labels);
  const reasons = [];
  if (normalize(issue.state) !== 'open') reasons.push(`issue is ${normalize(issue.state) || 'not open'}`);
  if (state.conflict) reasons.push('issue has conflicting primary workflow labels');
  else if (state.state !== 'ready') reasons.push(`issue is in ${state.state} state`);
  if (state.needsInput) reasons.push('issue needs human input');
  for (const blocker of dependencies) {
    const status = blockerState(blocker);
    if (status === 'open') reasons.push(`blocked by open issue #${blocker.number}`);
    if (status === 'not-planned') reasons.push(`blocked by issue #${blocker.number} closed as not planned`);
    if (status === 'unknown') reasons.push(`blocker issue #${blocker.number} has an unrecognized closed reason`);
  }
  for (const parent of parents) {
    const ancestor = workflowState(parent, labels);
    if (ancestor.conflict) reasons.push(`parent issue #${parent.number} has conflicting primary workflow labels`);
    else if (ancestor.state === 'proposal' || ancestor.state === 'hold') reasons.push(`parent issue #${parent.number} is ${ancestor.state}`);
    if (ancestor.needsInput) reasons.push(`parent issue #${parent.number} needs human input`);
  }
  const canonicalIssue = {
    number: issue.number, node_id: issue.node_id, title: issue.title, body: issue.body,
    state: issue.state, state_reason: issue.state_reason,
    labels: labelNames(issue).map(normalize).sort(),
  };
  const canonical = {
    issue: canonicalIssue,
    dependencies: dependencies.map(item => ({ number: item.number, state: item.state, state_reason: item.state_reason ?? item.stateReason, title: item.title })).sort((a,b) => (a.number ?? 0) - (b.number ?? 0)),
    parents: parents.map(item => ({ number: item.number, state: item.state, title: item.title, labels: labelNames(item).map(normalize).sort() })).sort((a,b) => a.number - b.number),
    comments: comments.filter(item => !String(item.body ?? '').startsWith('<!-- conductor:'))
      .map(item => ({ id: item.id, body: item.body, updated_at: item.updated_at ?? item.created_at }))
      .sort((a,b) => String(a.id).localeCompare(String(b.id))),
  };
  return { eligible: reasons.length === 0, reasons, revision: createHash('sha256').update(stable(canonical)).digest('hex'), issue };
}

