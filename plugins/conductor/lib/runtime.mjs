import { homedir } from 'node:os';
import { CodexClient } from './codex.mjs';
import { ClaudeClient } from './claude.mjs';
import { join, resolve } from 'node:path';

/**
 * Conductor runs its agents on one of two hosts. Everything above the client
 * (coordinator, director, managed bridge, hooks) speaks the Codex App Server
 * vocabulary; ClaudeClient translates that vocabulary to Claude Code sessions.
 * This module is the single owner of which host is selected and how the two
 * hosts' director modes and defaults correspond.
 */
export const RUNTIMES = Object.freeze(['codex', 'claude']);

// Director host modes. "chat" is a user-visible conversation bound by its id
// and woken through a queue; "service" is a session Conductor creates and runs.
const HOST_MODES = Object.freeze({
  codex: { chat: 'codex-desktop', service: 'codex-app-server-daemon' },
  claude: { chat: 'claude-code', service: 'claude-headless' },
});
export const CHAT_HOSTS = Object.freeze(new Set(Object.values(HOST_MODES).map(modes => modes.chat)));
export const SERVICE_HOSTS = Object.freeze(new Set(Object.values(HOST_MODES).map(modes => modes.service)));
export const ALL_HOSTS = Object.freeze(new Set([...CHAT_HOSTS, ...SERVICE_HOSTS]));

export function isChatHost(mode) { return CHAT_HOSTS.has(mode); }
export function isServiceHost(mode) { return SERVICE_HOSTS.has(mode); }
export function runtimeOfHost(mode) {
  for (const [runtime, modes] of Object.entries(HOST_MODES)) if (modes.chat === mode || modes.service === mode) return runtime;
  return null;
}

/** Map the CLI's host-neutral `desktop`/`daemon` choice onto the selected runtime. */
export function hostModeFor(runtime, host) {
  if (host === undefined || host === null) return undefined;
  if (ALL_HOSTS.has(host)) {
    if (runtimeOfHost(host) !== runtime) throw new Error(`Host ${host} belongs to the ${runtimeOfHost(host)} runtime, not ${runtime}.`);
    return host;
  }
  if (host === 'desktop' || host === 'chat') return HOST_MODES[runtime].chat;
  if (host === 'daemon' || host === 'service') return HOST_MODES[runtime].service;
  throw new Error(`Unknown director host ${host}; use desktop or daemon.`);
}

/**
 * Explicit configuration wins, then CONDUCTOR_RUNTIME, then the host that
 * launched this process. Claude Code sets CLAUDECODE=1 for its tools and hooks.
 */
export function selectRuntime({ config, env = process.env } = {}) {
  const chosen = config?.runtime ?? env.CONDUCTOR_RUNTIME ?? (env.CLAUDECODE === '1' ? 'claude' : 'codex');
  if (!RUNTIMES.includes(chosen)) throw new Error(`runtime must be one of ${RUNTIMES.join(', ')}; got ${chosen}.`);
  return chosen;
}

export const DEFAULTS = Object.freeze({
  codex: { directorModel: 'gpt-6.1-sol', directorEffort: 'low', plannerModel: 'gpt-6-astra' },
  claude: { directorModel: 'sonnet', directorEffort: 'low', plannerModel: 'opus' },
});

/** Home whose identity pins unfinished workers to one environment. */
export function runtimeHome(runtime, env = process.env) {
  return runtime === 'claude'
    ? resolve(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'))
    : resolve(env.CODEX_HOME ?? join(homedir(), '.codex'));
}

/** Ownership/environment stamp; Codex records keep their original `codexHome` key. */
export function homeStamp(runtime, env = process.env) {
  return runtime === 'claude' ? { runtime, claudeHome: runtimeHome(runtime, env) } : { codexHome: runtimeHome(runtime, env) };
}

/** Resolve `current` to the calling host session, where the host exposes it. */
export function resolveThreadArgument(value, env = process.env) {
  if (value !== 'current') return value;
  const current = env.CLAUDE_CODE_SESSION_ID ?? env.CODEX_THREAD_ID;
  if (!current) throw new Error('--thread current needs a host that exposes its session id (Claude Code sets CLAUDE_CODE_SESSION_ID). Pass the chat UUID explicitly.');
  return current;
}

/** Client class for a runtime; both expose the same App Server-shaped interface. */
export function clientClass(runtime) {
  if (!RUNTIMES.includes(runtime)) throw new Error(`Unknown runtime ${runtime}.`);
  return runtime === 'claude' ? ClaudeClient : CodexClient;
}
