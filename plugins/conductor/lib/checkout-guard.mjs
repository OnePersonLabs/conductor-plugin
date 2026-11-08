import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { inspectRepository } from './worktrees.mjs';
import { processExists } from './process.mjs';

const ACTIVE_PHASES = new Set(['preparing', 'starting', 'launching', 'building', 'reviewing', 'checking', 'cancelling', 'uncertain']);
const SHELL_TOOLS = new Set(['exec_command', 'shell', 'shell_command', 'Bash']);
// These names identify reviewed capabilities, not naming conventions. A new
// read_* MCP tool can still mutate state and must not inherit permission.
const READ_TOOLS = new Set([
  'view_image', 'read_file', 'list_dir', 'grep_files', 'file_search',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'mcp__codex_app__list_threads', 'mcp__codex_app__read_thread',
  'mcp__codex_app__list_archived_threads', 'mcp__codex_app__wait_threads',
  'mcp__codex_app__read_thread_terminal',
  ...['fetch', 'fetch_blob', 'fetch_commit', 'fetch_file', 'fetch_issue', 'fetch_issue_comments',
    'fetch_pr', 'fetch_pr_comments', 'fetch_pr_file_patch', 'fetch_pr_patch',
    'get_pr_diff', 'get_pr_info', 'get_repo', 'get_profile', 'get_commit_combined_status',
    'search', 'search_branches', 'search_commits', 'search_issues', 'search_prs',
    'search_repositories'].map(name => `mcp__codex_apps__github_${name}`),
]);

function toolName(name) {
  return typeof name === 'string' ? name.replace(/^functions[._]/, '') : '';
}

function inputOf(payload) {
  const input = payload.tool_input;
  if (typeof input !== 'string') return input ?? {};
  try { return JSON.parse(input); } catch { return { raw: input }; }
}

async function jsonOrMissing(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export function checkoutActivity(state, owner) {
  if (!object(state) || state.version !== 1 || !Array.isArray(state.jobs)) throw new Error('Invalid Conductor recovery state');
  if ((state.director != null && !object(state.director)) || (state.running !== undefined && typeof state.running !== 'boolean') || (state.runtimeEnabled !== undefined && typeof state.runtimeEnabled !== 'boolean') || (state.runnerPause != null && !object(state.runnerPause))) throw new Error('Invalid Conductor ownership fields');
  if (owner && (!object(owner) || typeof owner.token !== 'string' || !Number.isSafeInteger(owner.pid) || typeof owner.hostname !== 'string' || typeof owner.platform !== 'string')) throw new Error('Invalid Conductor owner lock');
  const reasons = [];
  if (state.running === true) reasons.push('runner is running or its shutdown is unresolved');
  if (owner && (owner.hostname !== hostname() || owner.platform !== process.platform || processExists(owner.pid))) reasons.push('coordinator owns the repository');
  if (state.director?.handoff) reasons.push('director handoff is pending');
  if (state.director?.recoveryRequired && !state.director.recoveryRequired.resolvedAt) reasons.push('director turn needs reconciliation');
  if (state.director?.enabled === true && state.director?.threadId && state.runtimeEnabled !== false && !state.runnerPause) reasons.push('automated director is enabled');
  if (state.runnerPause?.warnings?.length) reasons.push('runner shutdown has unresolved warnings');
  for (const job of state.jobs) {
    if (!object(job)) throw new Error('Invalid Conductor job record');
    if (job.childPid || job.turnId || ACTIVE_PHASES.has(job.phase) || job.mergeArmed || job.deliveryReconciliationRequired || job.pullCreationPending) {
      reasons.push(`issue #${job.issue ?? '?'} has active or unreconciled work`);
    }
  }
  return [...new Set(reasons)];
}

function authorizedDirector(state, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  const director = state.director;
  const ownership = director?.threadHostOwnership;
  if (!['codex-desktop', 'codex-app-server-daemon'].includes(ownership?.host) || (ownership.threadId && ownership.threadId !== director.threadId)) return false;
  return director.threadId === sessionId || (ownership.host === 'codex-desktop' && director.handoff?.fromThreadId === director.threadId && director.handoff.toThreadId === sessionId);
}

// This intentionally accepts a small shell language: a single literal command.
// It does not infer arbitrary Python, JavaScript, shell functions or pipelines.
export function literalShellTokens(command) {
  if (typeof command !== 'string' || /[\r\n;&|<>`$(){}\[\]]/.test(command)) return null;
  const tokens = [];
  let current = '', quote = null, started = false;
  for (const char of command.trim()) {
    if (quote) { if (char === quote) quote = null; else current += char; started = true; }
    else if (char === '"' || char === "'") { if (started) return null; quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { tokens.push(current); current = ''; started = false; } }
    else { current += char; started = true; }
  }
  if (quote) return null;
  if (started) tokens.push(current);
  return tokens;
}

function optionsAllowed(args, flags, valued = new Set()) {
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--') return true;
    if (!value.startsWith('-')) continue;
    if (flags.has(value)) continue;
    if (valued.has(value) && typeof args[++index] === 'string') continue;
    return false;
  }
  return true;
}

export function readOnlyShell(command) {
  const tokens = literalShellTokens(command);
  if (!tokens?.length) return false;
  const [executable, ...args] = tokens;
  const name = executable.toLowerCase();
  if (name === 'get-content') {
    if (args[0]?.toLowerCase() !== '-literalpath' || !args[1] || args[1].startsWith('-')) return false;
    return optionsAllowed(args.slice(2).map(x => x.toLowerCase()), new Set(['-raw']), new Set(['-totalcount', '-tail', '-encoding']));
  }
  if (name === 'get-childitem' || name === 'get-item') {
    if (args[0]?.toLowerCase() !== '-literalpath' || !args[1] || args[1].startsWith('-')) return false;
    return optionsAllowed(args.slice(2).map(x => x.toLowerCase()), new Set(['-force', '-recurse', '-name', '-file', '-directory']));
  }
  if (name === 'rg') {
    if (!args.includes('--no-config')) return false;
    return optionsAllowed(args, new Set(['--no-config', '--files', '--hidden', '--no-ignore', '-n', '--line-number', '-i', '--ignore-case', '-l', '--files-with-matches', '-F', '--fixed-strings', '-w', '--word-regexp', '--', '-S', '--smart-case', '--count', '-c']), new Set(['-g', '--glob', '-e', '--regexp', '-m', '--max-count', '-A', '-B', '-C', '--context']));
  }
  if (name !== 'git') return false;
  const gitArgs = [...args];
  // Status may run a configured fsmonitor; pagers, external diff and textconv
  // may execute arbitrary programs. Require callers to disable them explicitly.
  if (gitArgs.shift() !== '--no-optional-locks' || gitArgs.shift() !== '-c' || gitArgs.shift() !== 'core.fsmonitor=false' || gitArgs.shift() !== '--no-pager') return false;
  const subcommand = gitArgs.shift();
  const flags = new Set(['--short', '--branch', '--porcelain', '--porcelain=v1', '--porcelain=v2', '--untracked-files=all', '--name-only', '--name-status', '--stat', '--numstat', '--cached', '--staged', '--raw', '--oneline', '--decorate', '--all', '--graph', '--format=fuller', '--no-ext-diff', '--no-textconv', '--abbrev-ref', '--show-toplevel', '--git-common-dir', '--git-dir', '--absolute-git-dir', '--verify', '--quiet', '-q', '-z', '-v', '--others', '--exclude-standard', '--full-name', '--is-inside-work-tree']);
  if (!new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'merge-base']).has(subcommand)) return false;
  if (['diff', 'log', 'show'].includes(subcommand) && (!gitArgs.includes('--no-ext-diff') || !gitArgs.includes('--no-textconv'))) return false;
  return optionsAllowed(gitArgs, flags, new Set(['-n', '--max-count']));
}

async function repositoryAt(target) {
  let cursor = resolve(target);
  // New patch destinations may not exist yet. Inspect their existing parent.
  for (;;) {
    try { if ((await stat(cursor)).isFile()) cursor = dirname(cursor); break; }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; const parent = dirname(cursor); if (parent === cursor) return null; cursor = parent; }
  }
  try { return await inspectRepository(cursor); } catch { return null; }
}

function samePath(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }

function candidatePaths(payload, input) {
  // Native hooks execute in the session directory, while payload.cwd is the
  // individual tool's effective directory (for example exec_command.workdir).
  // Both matter: an unrelated main-checkout chat cannot shed its guard merely
  // by changing the shell directory.
  const paths = [process.cwd()];
  if (typeof payload.cwd === 'string') paths.push(payload.cwd);
  const base = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  for (const key of ['cwd', 'workdir', 'path', 'file_path', 'filename', 'directory']) {
    if (typeof input[key] === 'string' && input[key]) paths.push(resolve(base, input[key]));
  }
  const name = toolName(payload.tool_name);
  if (name === 'apply_patch') {
    const patch = typeof payload.tool_input === 'string' ? payload.tool_input : input.patch ?? input.input ?? input.command ?? input.raw;
    if (typeof patch === 'string') for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) paths.push(resolve(base, match[1].trim()));
  }
  if (SHELL_TOOLS.has(name)) {
    for (const token of literalShellTokens(input.cmd ?? input.command) ?? []) if (isAbsolute(token)) paths.push(token);
  }
  return [...new Set(paths)];
}

function warning(repo, reasons) {
  return `🚨 Conductor protects the main checkout at ${repo.root}: ${reasons.join('; ')}. This unrelated chat may inspect files and state, but edits and GitHub mutations are blocked. Continue edits in the recorded director chat or a separate worktree. Do not claim director authority from a prompt or chat title. Use Get-Content -LiteralPath <file>, rg --no-config <pattern> <path>, or git --no-optional-locks -c core.fsmonitor=false --no-pager status --short for inspection. Unknown tools, arbitrary code, command chains and queued writes are blocked here. This notice describes ownership at this hook invocation. The hook checks current ownership again for every tool call. After the recorded operation ends, re-read current state and retry work within the user's existing authorization; do not treat an earlier notice as a permanent restriction or report a current denial without a current rejected operation.`;
}

export async function handleCheckoutGuard(payload) {
  const event = payload?.hook_event_name;
  if (!['UserPromptSubmit', 'PreToolUse'].includes(event)) return { guarded: false };
  const input = inputOf(payload);
  const inspected = new Set();
  for (const candidate of candidatePaths(payload, input)) {
    const repo = await repositoryAt(candidate);
    // Linked worker checkouts share recovery state but do not own main files.
    if (!repo || !samePath(repo.gitDir, repo.commonDir) || inspected.has(repo.commonDir)) continue;
    inspected.add(repo.commonDir);
    let config, state, owner, reasons;
    try {
      config = await jsonOrMissing(join(repo.root, 'conductor.json'));
      state = await jsonOrMissing(join(repo.commonDir, 'conductor', 'state.json'));
      owner = await jsonOrMissing(join(repo.commonDir, 'conductor', 'coordinator.lock'));
      if (!config && !state && !owner) continue;
      if (!object(config) || config.version !== 2) throw new Error('Cannot verify repository configuration');
      if (!state && !owner) continue;
      reasons = checkoutActivity(state, owner);
    } catch (error) {
      // A configured repository's unreadable ownership is uncertainty, not an
      // assertion that automation stopped. Preserve it for the director.
      reasons = [`ownership state cannot be verified (${error.message})`];
      state = null;
    }
    if (!reasons.length || (state && authorizedDirector(state, payload.session_id))) continue;
    const message = warning(repo, reasons);
    if (event === 'UserPromptSubmit') return { guarded: true, hookOutput: { hookSpecificOutput: { hookEventName: event, additionalContext: message } } };
    const name = toolName(payload.tool_name);
    if (READ_TOOLS.has(name) || (SHELL_TOOLS.has(name) && readOnlyShell(input.cmd ?? input.command))) return { guarded: false };
    return { guarded: true, denied: true, message, hookOutput: { hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: message } } };
  }
  return { guarded: false };
}
