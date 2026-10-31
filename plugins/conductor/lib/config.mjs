import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_LABELS } from './workflow.mjs';

export function duration(value) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(value));
  const amount = match && Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2] ?? 's']);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Poll interval must be a positive duration, such as 5m.');
  return amount;
}

export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Configuration must be an object.');
  if (!/^[\w.-]+\/[\w.-]+$/.test(raw.repository ?? '')) throw new Error('repository must be owner/name.');
  if (typeof raw.baseBranch !== 'string' || !raw.baseBranch || raw.baseBranch.startsWith('-')) throw new Error('baseBranch is required.');
  if (raw.authorized !== true) throw new Error('Setup must explicitly set authorized: true for ready-issue execution.');
  if (!Array.isArray(raw.checks) || !raw.checks.length) throw new Error('Configure at least one existing verification command in checks.');
  for (const key of ['checks', 'prepare']) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) throw new Error(`${key} must be an array.`);
    for (const item of raw[key] ?? []) {
      if (!item || typeof item.command !== 'string' || !item.command || !Array.isArray(item.args) || item.args.some(a => typeof a !== 'string')) throw new Error(`${key} entries need command and an array of string args.`);
    }
  }
  const agents = raw.agents ?? 1;
  if (!Number.isSafeInteger(agents) || agents < 1) throw new Error('agents must be a positive integer.');
  if (raw.maxTurns !== undefined && (!Number.isSafeInteger(raw.maxTurns) || raw.maxTurns < 1)) throw new Error('maxTurns must be a positive integer when specified.');
  const requiredApprovals = raw.requiredApprovals ?? 0;
  if (!Number.isSafeInteger(requiredApprovals) || requiredApprovals < 0) throw new Error('requiredApprovals must be a nonnegative integer.');
  if (raw.priorityLabels !== undefined && (!Array.isArray(raw.priorityLabels) || raw.priorityLabels.some(v => typeof v !== 'string'))) throw new Error('priorityLabels must be an ordered string array.');
  if (raw.readyLabel !== undefined && (typeof raw.readyLabel !== 'string' || !raw.readyLabel.trim())) throw new Error('readyLabel must be a nonempty string.');
  const mergeMethod = raw.mergeMethod ?? 'merge';
  if (!['merge', 'squash', 'rebase'].includes(mergeMethod)) throw new Error('mergeMethod must be merge, squash, or rebase.');
  for (const key of ['implementationInstructions', 'reviewInstructions']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') throw new Error(`${key} must be a string.`);
  }
  if (raw.reviewEnabled !== undefined && typeof raw.reviewEnabled !== 'boolean') throw new Error('reviewEnabled must be a boolean.');
  if (raw.designHandoff !== undefined && (!raw.designHandoff || typeof raw.designHandoff !== 'object' || Array.isArray(raw.designHandoff) || typeof raw.designHandoff.command !== 'string' || !raw.designHandoff.command.trim() || !Array.isArray(raw.designHandoff.args) || raw.designHandoff.args.some(arg => typeof arg !== 'string'))) throw new Error('designHandoff needs a command and an array of string args.');
  return { ...raw, agents, implementationInstructions: raw.implementationInstructions ?? '', reviewEnabled: raw.reviewEnabled ?? true, reviewInstructions: raw.reviewInstructions ?? '', readyLabel: raw.readyLabel ?? 'conductor:ready', priorityLabels: raw.priorityLabels ?? [], pollMs: duration(raw.pollInterval ?? '5m'), requiredApprovals, mergeMethod, prepare: raw.prepare ?? [] };
}

export async function loadConfig(root, overrides = {}) {
  let raw;
  try { raw = JSON.parse(await readFile(join(root, 'conductor.json'), 'utf8')); }
  catch (error) { throw new Error(`Cannot load conductor.json: ${error.message}. Use $conductor:setup-repo-workflow for explicit setup.`); }
  const merged = { ...raw, ...overrides };
  if (merged.version !== 2) throw new Error('This repository uses a legacy Conductor configuration. Run `conductor migrate` to preview the issue-state migration, then apply it explicitly before starting the director. No work was admitted.');
  return validateDirectorConfig(merged);
}

export function validateDirectorConfig(raw) {
  if (raw.version !== 2) throw new Error('Conductor director configuration must set version: 2.');
  const base = validateConfig({ ...raw, authorized: raw.authorized, readyLabel: raw.labels?.ready ?? DEFAULT_LABELS.ready, pollInterval: raw.pollInterval ?? '30m' });
  const labels = { ...DEFAULT_LABELS, ...(raw.labels ?? {}) };
  if (Object.values(labels).some(value => typeof value !== 'string' || !value.trim())) throw new Error('labels must map each workflow state to a nonempty string.');
  if (new Set([labels.triage, labels.proposal, labels.ready, labels.hold, labels.needsInput].map(value => value.trim().toLowerCase())).size !== 5) throw new Error('triage, proposal, ready, hold and needsInput labels must be distinct.');
  for (const [key, fallback] of [['directorModel', 'gpt-6.1-sol'], ['plannerModel', 'gpt-6-astra']]) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !raw[key].trim())) throw new Error(`${key} must be a nonempty model name.`);
    base[key] = raw[key] ?? fallback;
  }
  return { ...base, version: 2, labels, pollMs: duration(raw.pollInterval ?? '30m'), admissionPaused: raw.admissionPaused === true };
}

export function orderedIssues(issues, priorityLabels) {
  const rank = issue => { const names = (issue.labels ?? []).map(x => typeof x === 'string' ? x : x.name); const n = priorityLabels.findIndex(x => names.includes(x)); return n < 0 ? priorityLabels.length : n; };
  return [...issues].sort((a, b) => rank(a) - rank(b) || String(a.createdAt ?? a.created_at).localeCompare(String(b.createdAt ?? b.created_at)) || a.number - b.number);
}
