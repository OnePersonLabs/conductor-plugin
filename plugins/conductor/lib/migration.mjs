import { DEFAULT_LABELS, workflowState } from './workflow.mjs';

export function previewMigration(issues, legacyReadyLabel = 'conductor:ready', labels = DEFAULT_LABELS) {
  if (!Array.isArray(issues)) throw new Error('Migration preview requires an issue snapshot array.');
  return issues.filter(issue => issue.state === 'open' && !issue.pull_request).map(issue => {
    const names = (issue.labels ?? []).map(label => String(typeof label === 'string' ? label : label?.name ?? '').trim().toLowerCase());
    const wasReady = names.includes(legacyReadyLabel.trim().toLowerCase());
    const current = workflowState(issue, labels);
    return { number: issue.number, title: issue.title, revision: issue.updated_at ?? issue.updatedAt ?? null, previousState: wasReady ? 'ready' : current.state, proposedState: wasReady ? 'ready' : 'triage', needsExplicitReview: !wasReady };
  });
}

export async function applyMigration(github, records, classifications, labels = DEFAULT_LABELS, legacyReadyLabel = 'conductor:ready') {
  if (!Array.isArray(records) || !classifications || typeof classifications !== 'object' || Array.isArray(classifications)) throw new Error('Migration apply requires preview records and an explicit classification map.');
  const allowed = new Set(['triage','proposal','ready','hold']);
  const missing = records.filter(record => !allowed.has(classifications[record.number]?.state));
  if (missing.length) throw new Error(`Explicit classifications are required for every issue; missing #${missing.map(x => x.number).join(', #')}.`);
  for (const record of records) {
    if (classifications[record.number].revision !== record.revision) throw new Error(`Issue #${record.number} migration mapping lacks the exact preview revision.`);
    const current = await github.issue(record.number);
    const revision = current.updated_at ?? current.updatedAt ?? null;
    if (record.revision !== revision) throw new Error(`Issue #${record.number} changed since migration preview; regenerate the preview before applying.`);
  }
  const results = [];
  for (const record of records) {
    results.push(await github.setWorkflowState(record.number, classifications[record.number].state, labels));
    const current = await github.issue(record.number);
    if ((current.labels ?? []).some(label => (typeof label === 'string' ? label : label?.name)?.toLowerCase() === legacyReadyLabel.toLowerCase())) {
      await github.gh(['issue', 'edit', String(record.number), '--repo', github.repository, '--remove-label', legacyReadyLabel]);
    }
  }
  return results;
}
