import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectRepository } from './worktrees.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = join(ROOT, 'bin', 'conductor.mjs');
const GH_MUTATIONS = new Set(['create', 'edit', 'close', 'reopen', 'comment', 'delete', 'transfer', 'lock', 'unlock']);
const TOOL_MUTATIONS = new Set([
  'github_create_issue', 'github_update_issue', 'github_add_issue_labels',
  'github_remove_issue_label', 'github_add_issue_assignees', 'github_remove_issue_assignees',
  'github_add_comment_to_issue', 'github_update_issue_comment', 'github_lock_issue_conversation', 'github_unlock_issue_conversation',
]);

export function recognizedIssueMutation(payload) {
  const name = payload?.tool_name;
  if (typeof name === 'string' && [...TOOL_MUTATIONS].some(tool => name.endsWith(tool))) return true;
  if (typeof name !== 'string' || !/^(?:Bash|shell|exec_command)$/.test(name)) return false;
  const command = payload?.tool_input?.command ?? payload?.tool_input?.cmd;
  if (typeof command !== 'string') return false;
  if (/[;&|\r\n`]/.test(command) || command.includes('$(')) return false;
  const match = /^\s*(?:\$\s*)?gh\s+issue\s+(\S+)/i.exec(command);
  return Boolean(match && GH_MUTATIONS.has(match[1].toLowerCase()));
}

function toolRepository(payload) {
  if (!payload.tool_name?.startsWith('mcp__codex_apps__github_')) return null;
  const input = payload.tool_input;
  return typeof input?.repository_full_name === 'string' ? input.repository_full_name
    : typeof input?.repo_full_name === 'string' ? input.repo_full_name : null;
}

function isConductorComment(payload) {
  const name = payload?.tool_name ?? '';
  if (!name.endsWith('github_add_comment_to_issue') && !name.endsWith('github_update_issue_comment')) return false;
  return /^\s*<!--\s*conductor:/i.test(payload.tool_input?.comment ?? '');
}

function commandRepository(command) {
  const matches = [...command.matchAll(/(?:--repo(?:=|\s+)|-R\s+)(?:"([\w.-]+\/[\w.-]+)"|'([\w.-]+\/[\w.-]+)'|([\w.-]+\/[\w.-]+))/gi)];
  if (matches.length !== 1) return /(?:--repo\b|-R\b)/.test(command) ? '__ambiguous__' : null;
  return matches[0][1] ?? matches[0][2] ?? matches[0][3];
}

export async function eligibleRepository(payload, { cwd = payload?.cwd } = {}) {
  if (typeof cwd !== 'string' || !cwd.trim() || !recognizedIssueMutation(payload) || isConductorComment(payload)) return null;
  const command = payload.tool_input?.command ?? payload.tool_input?.cmd ?? '';
  const inputRepo = toolRepository(payload) ?? commandRepository(command);
  if (payload.tool_name?.startsWith('mcp__codex_apps__github_') && !inputRepo) return null;
  try {
    const repo = await inspectRepository(cwd);
    const config = JSON.parse(await readFile(join(repo.root, 'conductor.json'), 'utf8'));
    if (config.version !== 2 || !/^[\w.-]+\/[\w.-]+$/.test(config.repository ?? '')) return null;
    if (inputRepo && inputRepo.toLowerCase() !== config.repository.toLowerCase()) return null;
    const statePath = join(repo.commonDir, 'conductor', 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const enabled = state.runtimeEnabled === true || (state.runtimeEnabled === undefined && state.director?.enabled === true && Boolean(state.director?.threadId));
    if (!enabled) return null;
    return { ...repo, repository: config.repository };
  } catch { return null; }
}

export function signalRepository(repository, { cwd, spawnProcess = spawn } = {}) {
  if (!repository || typeof cwd !== 'string') return false;
  const child = spawnProcess(process.execPath, [ENTRY, 'signal'], {
    cwd,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    shell: false,
  });
  child.on('error', () => {});
  child.unref();
  return true;
}

export async function handleIssueMutation(payload, options = {}) {
  const target = await eligibleRepository(payload, options);
  if (!target) return { signaled: false, reason: 'not-an-enabled-issue-mutation' };
  const cwd = options.cwd ?? payload.cwd;
  signalRepository(target, { cwd, spawnProcess: options.spawnProcess });
  return { signaled: true, repository: target.repository };
}
