import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

const CLIENT_INFO = Object.freeze({
  name: 'symphony-lite',
  title: 'Symphony Lite',
  version: '0.1.0',
});

/**
 * A small JSON-RPC client for Codex App Server's stdio transport.
 *
 * The coordinator supplies reviewer-specific read-only sandbox, no-approval,
 * and tool-isolation overrides. Builder turns retain configured defaults.
 * Server requests are surfaced to the caller and remain pending until respond().
 */
export class CodexClient extends EventEmitter {
  constructor({ cwd = process.cwd(), env = process.env, command, args } = {}) {
    super();
    this.cwd = resolve(cwd);
    this.env = { ...env };
    this.command = command ?? 'codex';
    this.args = args === undefined ? ['app-server', '--listen', 'stdio://'] : [...args];

    this.child = undefined;
    this.connected = false;
    this.lastError = undefined;
    this._nextId = 1;
    this._pending = new Map();
    this._serverRequests = new Map();
    this._stdoutBuffer = '';
    this._stderrBuffer = '';
    this._exit = undefined;
    this._exitPromise = undefined;
  }

  /** Pending requests made by Codex that need an explicit respond() call. */
  get pendingRequests() {
    return [...this._serverRequests.values()].map(({ id, method, params }) => ({ id, method, params }));
  }

  /** Alias that makes the direction of pendingRequests explicit. */
  get pendingServerRequests() {
    return this.pendingRequests;
  }

  /** Child process id for persisted process recovery. It is undefined before spawn. */
  get pid() {
    return this.child?.pid;
  }

  async connect() {
    if (this.connected) return this;
    if (this.child) throw new Error('Codex App Server connection has already been started');

    const executable = resolveCommand(this.command, this.args, this.env);
    this.child = spawn(executable.command, executable.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });

    this._exitPromise = new Promise((resolveExit) => {
      this.child.once('exit', (code, signal) => {
        this._finishExit({ code, signal }, resolveExit);
      });
      this.child.once('close', (code, signal) => {
        if (!this._exit) this._finishExit({ code, signal }, resolveExit);
      });
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.child.stdout.on('end', () => this._onStdoutEnd());
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => this._onStderr(chunk));
    this.child.stdin.on('error', (error) => this._reportError(error));
    this.child.once('error', (error) => {
      this._rejectPending(error);
      this._reportError(error);
    });

    await this._request('initialize', {
      clientInfo: CLIENT_INFO,
    });
    await this._notify('initialized', {});
    this.connected = true;
    return this;
  }

  async readConfig({ cwd = this.cwd } = {}) {
    this._assertConnected();
    return this._request('config/read', { cwd: resolve(cwd), includeLayers: false });
  }

  async startThread({ cwd = this.cwd, sandbox, approvalPolicy, config } = {}) {
    this._assertConnected();
    const params = { cwd: resolve(cwd) };
    if (sandbox !== undefined) params.sandbox = sandbox;
    if (approvalPolicy !== undefined) params.approvalPolicy = approvalPolicy;
    if (config !== undefined) params.config = config;
    const result = await this._request('thread/start', params);
    return requireResultObject(result, 'thread/start', 'thread');
  }

  async setThreadName({ threadId, name } = {}) {
    this._assertConnected();
    requireString(threadId, 'threadId');
    requireString(name, 'name');
    return this._request('thread/name/set', { threadId, name });
  }

  async resumeThread({ threadId, cwd = this.cwd, sandbox, approvalPolicy, config } = {}) {
    this._assertConnected();
    requireString(threadId, 'threadId');
    const params = { threadId, cwd: resolve(cwd) };
    if (sandbox !== undefined) params.sandbox = sandbox;
    if (approvalPolicy !== undefined) params.approvalPolicy = approvalPolicy;
    if (config !== undefined) params.config = config;
    const result = await this._request('thread/resume', params);
    return requireResultObject(result, 'thread/resume', 'thread');
  }

  async readThread({ threadId } = {}) {
    this._assertConnected();
    requireString(threadId, 'threadId');
    return requireResultObject(await this._request('thread/read', { threadId, includeTurns: true }), 'thread/read', 'thread');
  }

  async listThreads({ cwd = this.cwd } = {}) {
    this._assertConnected();
    const threads = []; let cursor;
    do {
      const page = await this._request('thread/list', { cwd: resolve(cwd), cursor, limit: 100, sourceKinds: ['cli','vscode','exec','appServer','unknown'] });
      if (!Array.isArray(page.data)) throw new Error('Codex thread/list did not return a data array.');
      threads.push(...page.data); cursor = page.nextCursor;
    } while (cursor);
    return threads;
  }

  async startTurn({ threadId, cwd = this.cwd, prompt, skillPath, outputSchema } = {}) {
    this._assertConnected();
    requireString(threadId, 'threadId');
    requireString(prompt, 'prompt');

    const input = [];
    if (skillPath !== undefined) {
      const absoluteSkillPath = resolve(skillPath);
      input.push({
        type: 'skill',
        name: basename(dirname(absoluteSkillPath)),
        path: absoluteSkillPath,
      });
    }
    input.push({ type: 'text', text: prompt });

    const params = { threadId, cwd: resolve(cwd), input };
    if (outputSchema !== undefined) params.outputSchema = outputSchema;
    const result = await this._request('turn/start', params);
    return requireResultObject(result, 'turn/start', 'turn');
  }

  async interrupt({ threadId, turnId } = {}) {
    this._assertConnected();
    requireString(threadId, 'threadId');
    requireString(turnId, 'turnId');
    return this._request('turn/interrupt', { threadId, turnId });
  }

  async respond(requestId, response) {
    this._assertConnected();
    const request = this._serverRequests.get(requestId);
    if (!request) throw new Error(`No pending Codex server request with id ${String(requestId)}`);
    if (response === undefined) throw new TypeError('response is required');
    await this._write({ jsonrpc: '2.0', id: requestId, result: response });
    this._serverRequests.delete(requestId);
  }

  async close() {
    if (!this.child) return;
    if (this._exit) return;

    const exitPromise = this._exitPromise;
    this.child.stdin.end();
    const forceKill = setTimeout(() => {
      if (!this._exit) this.child?.kill();
    }, 1000);
    forceKill.unref?.();
    await exitPromise;
    clearTimeout(forceKill);
  }

  _assertConnected() {
    if (!this.connected || !this.child || this._exit) {
      throw new Error('Codex App Server is not connected');
    }
  }

  _request(method, params) {
    if (!this.child || this._exit) return Promise.reject(new Error('Codex App Server is not running'));
    const id = this._nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      this._pending.set(id, { resolve: resolveRequest, reject: rejectRequest, method });
      this._write({ jsonrpc: '2.0', id, method, params }).catch((error) => {
        const pending = this._pending.get(id);
        if (!pending) return;
        this._pending.delete(id);
        pending.reject(error);
      });
    });
  }

  _notify(method, params) {
    return this._write({ jsonrpc: '2.0', method, params });
  }

  _write(message) {
    if (!this.child || this._exit || !this.child.stdin.writable) {
      return Promise.reject(new Error('Codex App Server stdin is not writable'));
    }
    const frame = `${JSON.stringify(message)}\n`;
    return new Promise((resolveWrite, rejectWrite) => {
      try {
        this.child.stdin.write(frame, 'utf8', (error) => error ? rejectWrite(error) : resolveWrite());
      } catch (error) {
        rejectWrite(error);
      }
    });
  }

  _onStdout(chunk) {
    this._stdoutBuffer += chunk;
    let newline;
    while ((newline = this._stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this._stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      this._stdoutBuffer = this._stdoutBuffer.slice(newline + 1);
      if (line.trim()) this._handleFrame(line);
    }
  }

  _onStdoutEnd() {
    if (!this._stdoutBuffer.trim()) return;
    this._handleFrame(this._stdoutBuffer.replace(/\r$/, ''));
    this._stdoutBuffer = '';
  }

  _handleFrame(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (cause) {
      this._reportError(new Error(`Invalid JSON from Codex App Server: ${line.slice(0, 500)}`, { cause }));
      return;
    }
    // Codex App Server 0.164.0's stdio transport emits JSON-RPC-shaped
    // objects without the optional `jsonrpc` member. Accept that wire form,
    // while rejecting an explicitly incompatible protocol version.
    if (!message || typeof message !== 'object' || (message.jsonrpc !== undefined && message.jsonrpc !== '2.0')) {
      this._reportError(new Error('Invalid JSON-RPC frame from Codex App Server'));
      return;
    }

    if (Object.hasOwn(message, 'method')) {
      if (Object.hasOwn(message, 'id')) {
        this._serverRequests.set(message.id, {
          id: message.id,
          method: message.method,
          params: message.params,
        });
        this._emitSafely('request', { id: message.id, method: message.method, params: message.params });
      } else {
        // Keep notification params unchanged. Terminal assistant text is
        // available at item/completed params.item.text when item.type is
        // "agentMessage"; consumers decide which messages are final.
        this._emitSafely('notification', { method: message.method, params: message.params });
      }
      return;
    }

    if (Object.hasOwn(message, 'id')) {
      const pending = this._pending.get(message.id);
      if (!pending) {
        this._reportError(new Error(`Unmatched Codex App Server response id ${String(message.id)}`));
        return;
      }
      this._pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message ?? `Codex App Server request failed (${message.error.code ?? 'unknown'})`);
        error.code = message.error.code;
        error.data = message.error.data;
        error.method = pending.method;
        pending.reject(error);
      } else if (Object.hasOwn(message, 'result')) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(`Codex App Server response for ${pending.method} had neither result nor error`));
      }
    }
  }

  _onStderr(chunk) {
    this._stderrBuffer = (this._stderrBuffer + chunk).slice(-8000);
  }

  _stderrSuffix() {
    return this._stderrBuffer.trim() ? `; stderr: ${this._stderrBuffer.trim()}` : '';
  }

  _rejectPending(error) {
    for (const [id, pending] of this._pending) {
      this._pending.delete(id);
      pending.reject(error);
    }
  }

  _reportError(error) {
    this.lastError = error;
    this._rejectPending(error);
    this._emitSafely('error', error);
  }

  _emitExit(exit) {
    this._emitSafely('exit', exit);
  }

  _finishExit(exit, resolveExit) {
    if (this._exit) return;
    this._exit = exit;
    this.connected = false;
    this._rejectPending(new Error(`Codex App Server exited (${formatExit(exit.code, exit.signal)})${this._stderrSuffix()}`));
    this._emitExit(exit);
    resolveExit(exit);
  }

  _emitSafely(event, value) {
    if (event === 'error' && this.listenerCount('error') === 0) return;
    try {
      this.emit(event, value);
    } catch (error) {
      if (event !== 'error') this._reportError(error);
    }
  }
}

function requireResultObject(result, method, field) {
  if (!result || typeof result !== 'object' || !result[field] || typeof result[field] !== 'object') {
    throw new Error(`Codex App Server ${method} response did not contain ${field}`);
  }
  return result[field];
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
}

function formatExit(code, signal) {
  return code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`;
}

function resolveCommand(command, args, env) {
  if (process.platform !== 'win32') return { command, args };
  const pathEntries = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const explicitPath = command.includes('/') || command.includes('\\') || isAbsolute(command);
  const candidates = explicitPath
    ? windowsCommandCandidates(command)
    : pathEntries.flatMap((entry) => windowsCommandCandidates(join(entry, command)));
  const found = candidates.find(isFile);
  if (!found) throw new Error(`Could not resolve Codex command on Windows: ${command}`);

  const extension = found.slice(found.lastIndexOf('.')).toLowerCase();
  if (extension === '.exe' || extension === '.com') return { command: found, args };
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    return { command: findExecutable('node', pathEntries), args: [found, ...args] };
  }
  if (extension === '.cmd' || extension === '.bat') {
    const launcher = resolveNodeLauncher(found, pathEntries, env);
    if (!launcher) {
      throw new Error(`Codex Windows shim ${found} does not expose a resolvable JavaScript launcher`);
    }
    return { command: launcher.node, args: [launcher.script, ...args] };
  }
  throw new Error(`Unsupported Codex command type on Windows: ${found}`);
}

function windowsCommandCandidates(command) {
  const ext = command.slice(command.lastIndexOf('.')).toLowerCase();
  if (['.exe', '.com', '.cmd', '.bat', '.js', '.mjs', '.cjs'].includes(ext)) return [resolve(command)];
  return ['.exe', '.com', '.cmd', '.bat', '.js', '.mjs', '.cjs'].map((suffix) => resolve(`${command}${suffix}`));
}

function resolveNodeLauncher(shimPath, pathEntries, env) {
  let source;
  try {
    source = readFileSync(shimPath, 'utf8');
  } catch {
    return undefined;
  }
  const shimDir = dirname(shimPath);
  const candidates = new Set();
  const dp0 = /["']?((?:%~dp0|%dp0%)[\\/][^"'\r\n]*?\.(?:m?js|cjs))["']?/ig;
  for (const match of source.matchAll(dp0)) {
    const relative = match[1].replace(/^(?:%~dp0|%dp0%)[\\/]?/i, '');
    candidates.add(resolve(shimDir, relative));
  }
  const absoluteJs = /["']([A-Za-z]:[\\/][^"'\r\n]*?\.(?:m?js|cjs))["']/ig;
  for (const match of source.matchAll(absoluteJs)) candidates.add(resolve(match[1]));
  const script = [...candidates].find(isFile);
  if (!script) return undefined;

  const adjacentNode = join(shimDir, 'node.exe');
  const node = isFile(adjacentNode) ? adjacentNode : findExecutable('node', pathEntries);
  return { node, script };
}

function findExecutable(name, pathEntries) {
  const candidates = pathEntries.flatMap((entry) => windowsCommandCandidates(join(entry, name)));
  const found = candidates.find(isFile);
  if (!found) throw new Error(`Could not resolve required Windows executable: ${name}`);
  return found;
}

function isFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}
