import { EventEmitter } from 'node:events';
import { mkdir, access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hostname, homedir } from 'node:os';
import { CodexClient } from './codex.mjs';
import { GitHub, checkState } from './github.mjs';
import { git, run } from './process.mjs';
import { createWorktree, copyWorktreeIncludes, refreshBranch } from './worktrees.mjs';
import { processExists } from './state.mjs';
import { WakeLoop, admission } from './scheduler.mjs';
import { builderPrompt, parseResult, resultSchema } from './prompts.mjs';

const skillPath = fileURLToPath(new URL('../skills/github-workflow/SKILL.md', import.meta.url));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const activePhases = new Set(['building','launching','starting','preparing']);

export class Coordinator extends EventEmitter {
  constructor({ repo, config, store, github, Client = CodexClient, execute = run, workspace = { createWorktree, copyWorktreeIncludes, refreshBranch } }) {
    super(); Object.assign(this, { repo, config, store, Client, execute, workspace });
    this.github = github ?? new GitHub(config.repository, { cwd: repo.root });
    this.clients = new Map(); this.tasks = new Map(); this.requests = new Map();
    this.stopping = false; this.scanError = null;
    this.delivery = Promise.resolve(); this.ready = false;
    this.loop = new WakeLoop(() => this.scan(), error => { this.scanError = error.message; this.emit('notice', `Reconciliation failed: ${error.message}`); });
  }
  async save() { await this.store.save(this.state); this.emit('status', this.state); }
  async start({ beforeScan } = {}) {
    await this.store.acquire();
    try {
      this.state = await this.store.read();
      if (this.state.repository && this.state.repository !== this.config.repository) throw new Error('Recovery state belongs to another GitHub repository. Resolve configuration before proceeding.');
      const environment = { platform: process.platform, host: hostname(), codexHome: resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex')) };
      if (this.state.environment && JSON.stringify(this.state.environment) !== JSON.stringify(environment) && this.state.jobs.some(job => !['complete','cancelled'].includes(job.phase))) throw new Error('Unfinished builders belong to a different OS or Codex home. Resume in that environment; no replacement builder was started.');
      this.state.environment = environment;
      this.state.repository = this.config.repository; this.state.root = this.repo.root;
      this.state.running = true; this.state.pid = process.pid; this.state.pollMs = this.config.pollMs; this.state.agents = this.config.agents;
      for (const job of this.state.jobs) {
        job.intent = job.phase === 'cancelling' ? 'cancel' : null;
        if (activePhases.has(job.phase)) {
          job.recoveryPhase = job.phase;
          if (!job.threadId || (job.childPid && processExists(job.childPid))) {
            job.phase = 'uncertain'; job.summary = 'Previous builder launch/process ownership is uncertain; resolve it before starting another builder.';
          } else { job.phase = 'stopped'; job.turnId = null; job.childPid = null; }
        }
      }
      await this.save();
      await this.preflight();
      await beforeScan?.();
      if (this.stopping) return;
      this.ready = true;
      this.timer = setInterval(() => this.wake(), this.config.pollMs);
      await this.wake();
    } catch (error) { if (this.state) { this.state.running = false; await this.save().catch(() => {}); } await this.store.release(); throw error; }
  }
  async preflight() {
    const remote = await git(this.repo.root, 'remote', 'get-url', 'origin');
    const repoName = remote.replace(/\.git$/, '').match(/(?:github\.com[:/])([^/]+\/[^/]+)$/)?.[1];
    if (repoName?.toLowerCase() !== this.config.repository.toLowerCase()) throw new Error('origin does not match configured repository; no work started.');
    await this.github.gh(['auth', 'status']);
    await git(this.repo.root, 'check-ref-format', '--branch', this.config.baseBranch);
    await access(skillPath);
  }
  wake() { return this.ready ? this.loop.wake() : Promise.resolve(); }
  deliveryAction(action) {
    const task = this.delivery.catch(() => {}).then(action);
    this.delivery = task; return task;
  }
  async base() {
    await git(this.repo.root, 'fetch', 'origin', this.config.baseBranch);
    return git(this.repo.root, 'rev-parse', `origin/${this.config.baseBranch}`);
  }
  async scan() {
    if (this.stopping) return;
    this.scanError = null;
    const base = await this.base();
    for (const job of this.state.jobs) {
      if (this.stopping) return;
      try {
        if (job.phase === 'cancelling') await this.cancel(job.issue);
        else if (job.phase === 'stopped' || job.phase === 'repair') {
          const issue = await this.github.issue(job.issue);
          if (issue.state !== 'open') { job.phase = 'blocked'; job.summary = 'Issue closed before verified delivery; operator reconciliation required.'; await this.save(); continue; }
          this.launch(job, issue, job.repairReason ?? 'Resume the interrupted original task from current source and retained evidence.', job.pendingFeedback ?? []);
        } else if (job.phase === 'waiting') await this.deliveryAction(() => this.reconcilePull(job, base));
      } catch (error) { job.lastError = error.message; await this.save(); this.emit('notice', `Issue #${job.issue}: ${error.message}`); }
    }
    if (this.stopping) return;
    const ready = await this.github.ready(this.config.readyLabel);
    // Filter dependencies before the capacity slice so blocked candidates do not starve ready work.
    const eligible = [];
    for (const issue of ready) {
      if (this.state.jobs.some(job => job.issue === issue.number)) continue;
      if (!(await this.github.blockers(issue.number)).length) eligible.push(issue);
    }
    for (const issue of admission(eligible, this.state.jobs, this.config)) {
      if (this.stopping) break;
      const branch = `symphony/issue-${issue.number}`;
      if (await this.github.pullForBranch(branch)) { this.emit('notice', `Issue #${issue.number} already has a PR on ${branch}; recover its owner before adoption.`); continue; }
      // Ordinary worktrees stay outside all source checkouts; their explicit paths survive restart.
      const path = join(dirname(dirname(this.repo.commonDir)), '.symphony-lite-worktrees', digest(this.repo.commonDir).slice(0, 16), `issue-${issue.number}`);
      const job = { issue: issue.number, branch, worktree: path, baseBranch: this.config.baseBranch, phase: 'preparing', threadId: null, turnId: null, childPid: null, acceptanceComplete: false, createdAt: new Date().toISOString() };
      this.state.jobs.push(job); await this.save();
      try {
        await this.prepare(job, base);
        if (this.stopping || job.intent) { job.phase = job.intent === 'cancel' ? 'cancelled' : 'stopped'; await this.save(); }
        else this.launch(job, issue, 'Start the authorized issue. Read its acceptance and relevant project instructions before changing source.');
      } catch (error) { if (job.intent !== 'cancel') job.phase = 'blocked'; job.summary = `Workspace preparation failed: ${error.message}`; await this.save(); await this.github.progress(job); }
    }
    this.state.lastScan = new Date().toISOString(); await this.save();
  }
  async prepare(job, base) {
    if (!job.worktreeCreated) {
      await mkdir(dirname(job.worktree), { recursive: true });
      await this.workspace.createWorktree({ repoRoot: this.repo.root, path: job.worktree, branch: job.branch, baseRef: base });
      job.worktreeCreated = true; await this.save();
    }
    job.includes = await this.workspace.copyWorktreeIncludes({ repoRoot: this.repo.root, worktreePath: job.worktree });
    for (let i = job.preparedCommands ?? 0; i < this.config.prepare.length; i++) {
      if (this.stopping || job.intent) return;
      job.preparationInFlight = i; await this.save();
      await this.command(this.config.prepare[i], job.worktree);
      job.preparedCommands = i + 1; job.preparationInFlight = null; await this.save();
    }
    job.prepared = true; await this.save(); await this.github.progress(job);
  }
  async command(command, cwd) {
    let executable = command.command;
    let args = command.args;
    // npm.cmd cannot be spawned directly without a shell on Windows. Use its installed JS entrypoint.
    if (process.platform === 'win32' && ['npm','npm.cmd'].includes(executable)) {
      const npm = process.env.npm_execpath ?? join(resolve(process.execPath, '..'), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      await access(npm); executable = process.execPath; args = [npm, ...args];
    }
    return this.execute(executable, args, { cwd });
  }
  launch(job, issue, reason, feedback = []) {
    if (this.tasks.has(job.issue) || this.stopping) return;
    const task = this.build(job, issue, reason, feedback).catch(async error => {
      job.phase = job.intent === 'cancel' ? job.cancelConfirmed ? 'cancelled' : 'cancelling' : this.stopping ? 'stopped' : job.phase === 'launching' || !job.threadId ? 'uncertain' : 'blocked'; job.summary = error.message; job.lastError = error.message;
      await this.save(); await this.github.progress(job).catch(e => this.emit('notice', e.message));
    }).finally(() => { this.tasks.delete(job.issue); if (!this.stopping) this.wake(); });
    this.tasks.set(job.issue, task);
  }
  async build(job, issue, reason, feedback) {
    const client = new this.Client({ cwd: job.worktree });
    this.clients.set(job.issue, client);
    let finalText = '';
    let terminalResolve, terminalReject;
    const terminal = new Promise((resolve, reject) => { terminalResolve = resolve; terminalReject = reject; });
    // Rejection can arrive while startTurn's RPC is still pending.
    terminal.catch(() => {});
    client.on('notification', ({ method, params }) => {
      if (params?.threadId && job.threadId && params.threadId !== job.threadId) return;
      if (method === 'item/completed' && params?.item?.type === 'agentMessage') finalText = params.item.text;
      if (method === 'turn/completed') terminalResolve(params.turn);
      if (method === 'serverRequest/resolved') {
        for (const [key, request] of this.requests) if (request.issue === job.issue && request.id === params.requestId) this.requests.delete(key);
      }
    });
    client.on('request', request => {
      const key = `${job.issue}:${request.id}`;
      this.requests.set(key, { ...request, issue: job.issue, client });
      this.emit('request', { key, issue: job.issue, ...request });
    });
    client.on('exit', ({ code }) => terminalReject(new Error(`Codex process exited (${code}) before a terminal turn result.`)));
    client.on('error', terminalReject);
    try {
      if (job.intent || this.stopping) return;
      if (!job.prepared) throw new Error('Workspace preparation is incomplete; use explicit resume after inspecting preparation state.');
      job.phase = job.threadId ? 'building' : 'starting'; await this.save();
      await client.connect(); job.childPid = client.pid; await this.save();
      if (job.intent || this.stopping) return;
      if (job.threadId) {
        const recovered = await client.readThread({ threadId: job.threadId });
        if (recovered.turns?.some(turn => turn.status === 'inProgress')) throw new Error('Original thread still has an active turn; reconcile its owner before resuming.');
        await client.resumeThread({ threadId: job.threadId, cwd: job.worktree });
      }
      else { const thread = await client.startThread({ cwd: job.worktree }); job.threadId = thread.id; await this.save(); }
      if (this.stopping || job.intent) return;
      if (this.config.maxTurns && this.state.jobs.reduce((n, j) => n + (j.turnCount ?? 0), 0) >= this.config.maxTurns) throw new Error('Configured total Codex turn budget exhausted; work is retained.');
      job.phase = 'launching'; job.turnCount = (job.turnCount ?? 0) + 1; await this.save();
      const turn = await client.startTurn({ threadId: job.threadId, cwd: job.worktree, prompt: builderPrompt({ config: this.config, job, issue, reason, feedback }), skillPath, outputSchema: resultSchema });
      job.turnId = turn.id;
      if (this.stopping || job.intent) { await client.interrupt({ threadId: job.threadId, turnId: turn.id }); return; }
      job.phase = 'building'; await this.save();
      const done = await terminal;
      if (job.intent === 'cancel') return;
      if (done.status === 'interrupted' || this.stopping) { job.phase = 'stopped'; await this.save(); return; }
      if (done.status !== 'completed') throw new Error(`Builder turn ${done.status}: ${JSON.stringify(done.error ?? {})}`);
      const result = parseResult(finalText); Object.assign(job, result); job.acceptanceComplete = result.acceptanceComplete;
      if (result.disposition === 'blocked' || !result.acceptanceComplete) { job.phase = 'blocked'; await this.save(); await this.github.progress(job); return; }
      if (await git(job.worktree, 'status', '--porcelain')) throw new Error('Builder left uncommitted or untracked work; finish the owned change before delivery.');
      try { await this.verify(job); }
      catch (error) { await this.repair(job, error); return; }
      if (this.stopping || job.intent) return;
      await git(job.worktree, 'push', '-u', 'origin', job.branch);
      if (this.stopping || job.intent) return;
      const pull = await this.github.createPull(job, issue); job.pr = pull.number;
      // Do not swallow feedback arriving while the builder was active: only evidence sent
      // to that turn is acknowledged by reconcilePull before launching it.
      job.phase = 'waiting'; job.lastError = null; job.repairReason = null; job.pendingFeedback = [];
      await this.save(); await this.github.progress(job);
    } finally {
      await client.close(); this.clients.delete(job.issue); job.childPid = null; job.turnId = null;
      if (job.intent === 'cancel') job.phase = job.cancelConfirmed ? 'cancelled' : 'cancelling';
      else if (this.stopping && activePhases.has(job.phase)) job.phase = 'stopped';
      for (const [key, request] of this.requests) if (request.issue === job.issue) this.requests.delete(key);
      await this.save();
    }
  }
  async repair(job, error) {
    const fingerprint = digest({ error: error.message, head: await git(job.worktree, 'rev-parse', 'HEAD') });
    job.repairAttempts = job.repairFingerprint === fingerprint ? (job.repairAttempts ?? 0) + 1 : 1;
    job.repairFingerprint = fingerprint;
    job.phase = job.repairAttempts >= 2 ? 'blocked' : 'repair';
    job.repairReason = `Repair local verification in this original issue: ${error.message}`;
    job.lastError = error.message; await this.save(); await this.github.progress(job);
  }
  async verify(job) {
    const base = await this.base();
    const refreshed = await this.workspace.refreshBranch({ repoRoot: this.repo.root, worktreePath: job.worktree, baseRef: base });
    if (refreshed.conflict) throw new Error('Base integration conflicts require repair in the original builder.');
    const head = await git(job.worktree, 'rev-parse', 'HEAD');
    if (job.checkHead === head && job.checkBase === base) return;
    job.checkHead = null; job.checkBase = null; await this.save();
    for (const command of this.config.checks) await this.command(command, job.worktree);
    if (await git(job.worktree, 'status', '--porcelain')) throw new Error('Verification changed workspace content; original builder must reconcile it.');
    if (await git(job.worktree, 'rev-parse', 'HEAD') !== head) throw new Error('Source changed while checks were running.');
    job.checkHead = head; job.checkBase = base; await this.save();
  }
  async reconcilePull(job, base) {
    if (job.intent || this.stopping) return;
    const pull = await this.github.pull(job.pr);
    if (pull.baseRefName !== this.config.baseBranch) throw new Error('PR targets a different base branch; operator reconciliation required.');
    if (pull.state === 'MERGED') {
      const acceptedBase = await this.base();
      if (!pull.mergeCommit?.oid) throw new Error('Merged PR has no verified merge commit yet.');
      await git(this.repo.root, 'merge-base', '--is-ancestor', pull.mergeCommit.oid, acceptedBase);
      if (!job.acceptanceComplete) { job.phase = 'blocked'; job.summary = 'PR merged but complete issue acceptance remains unresolved.'; await this.save(); return; }
      await this.github.closeIssue(job.issue, `Delivered by PR #${job.pr}; accepted base contains ${pull.mergeCommit.oid}.\n\n${job.summary}`);
      job.phase = 'complete'; job.mergedCommit = pull.mergeCommit.oid; await this.save(); await this.github.progress(job); return;
    }
    if (pull.state === 'CLOSED') { job.phase = 'blocked'; job.summary = 'PR closed without merge; acceptance remains open.'; await this.save(); await this.github.progress(job); return; }
    const feedback = await this.github.feedback(job.pr, pull.headRefOid);
    const unseen = feedback.items.filter(item => !(job.feedbackSeen ?? []).includes(digest(item)));
    const checks = checkState(pull);
    const checkFailure = checks.failed.length ? digest({ head: pull.headRefOid, failed: checks.failed }) : null;
    if (unseen.length || (checkFailure && checkFailure !== job.checkFailure)) {
      if (job.mergeArmed) await this.disarm(job);
      job.feedbackHash = feedback.hash; job.feedbackSeen = [...(job.feedbackSeen ?? []), ...unseen.map(digest)]; job.checkFailure = checkFailure;
      job.pendingFeedback = [...unseen, ...checks.failed];
      job.repairReason = 'Reconcile review or failed-check evidence and repair this same issue. Preserve and report unresolved findings.';
      await this.save();
      this.launch(job, await this.github.issue(job.issue), job.repairReason, job.pendingFeedback); return;
    }
    if (checks.failed.length || checks.pending || pull.isDraft || pull.reviewDecision === 'CHANGES_REQUESTED') return;
    // GitHub can retain an armed request after all gates turn green. Reconcile a
    // CLEAN request through the normal protected merge command instead of waiting forever.
    if (job.mergeArmed && pull.autoMergeRequest && pull.mergeStateStatus !== 'CLEAN') return;
    const approvals = await this.github.approvals(job.pr);
    if (approvals.changesRequested || approvals.approved < this.config.requiredApprovals) return;
    // Only one PR may have native auto-merge armed. Waiting issues retain their slots.
    if (this.state.jobs.some(other => other.issue !== job.issue && other.mergeArmed && other.phase !== 'complete')) return;
    const head = await git(job.worktree, 'rev-parse', 'HEAD');
    if (head !== pull.headRefOid) throw new Error('Local and PR heads differ; reconcile publication before merging.');
    if (job.checkBase !== base || job.checkHead !== head) {
      try { await this.verify(job); }
      catch (error) { await this.repair(job, error); return; }
      const verified = await git(job.worktree, 'rev-parse', 'HEAD');
      if (verified !== pull.headRefOid) { await git(job.worktree, 'push', 'origin', job.branch); return; }
    }
    const fresh = await this.github.pull(job.pr);
    if (fresh.headRefOid !== job.checkHead || (await this.base()) !== job.checkBase) return;
    const freshChecks = checkState(fresh);
    const freshApprovals = await this.github.approvals(job.pr);
    if (this.stopping || job.intent || fresh.state !== 'OPEN' || fresh.isDraft || freshChecks.pending || freshChecks.failed.length || fresh.reviewDecision === 'CHANGES_REQUESTED' || freshApprovals.changesRequested || freshApprovals.approved < this.config.requiredApprovals) return;
    job.mergeArmed = true; await this.save();
    if (this.stopping || job.intent) return;
    await this.github.merge(job.pr, fresh.headRefOid, this.config.mergeMethod);
  }
  async disarm(job) {
    const before = await this.github.pull(job.pr);
    if (before.state === 'MERGED') throw Object.assign(new Error('PR already landed; reconcile delivery before cancelling or repairing.'), { code: 'ALREADY_MERGED' });
    if (before.autoMergeRequest) await this.github.disableAutoMerge(job.pr);
    const after = await this.github.pull(job.pr);
    if (after.state === 'MERGED') throw Object.assign(new Error('PR landed while cancellation was disarming auto-merge.'), { code: 'ALREADY_MERGED' });
    if (after.autoMergeRequest) throw new Error('Merge outcome is not safely disarmed; retain ownership and reconcile again.');
    job.mergeArmed = false; await this.save();
  }
  async answer(key, value) {
    const request = this.requests.get(key);
    if (!request) throw new Error('That request is no longer pending.');
    let response;
    if (['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(request.method)) {
      if (!['accept','acceptForSession','decline','cancel'].includes(value)) throw new Error('Type accept, acceptForSession, decline or cancel explicitly.');
      response = { decision: value };
    } else {
      try { response = JSON.parse(value); } catch { throw new Error('This request needs an explicit JSON response; inspect the displayed request.'); }
    }
    await request.client.respond(request.id, response); this.requests.delete(key);
  }
  async cancel(issue) {
    const job = this.state.jobs.find(x => x.issue === issue);
    if (!job) throw new Error(`No owned issue #${issue}.`);
    if (job.phase === 'complete') throw new Error('Delivered issues cannot be cancelled.');
    if (job.phase === 'cancelled') return;
    job.intent = 'cancel';
    job.phase = 'cancelling'; await this.save();
    try {
      await this.deliveryAction(async () => { if (job.pr) await this.disarm(job); });
    } catch (error) {
      if (error.code !== 'ALREADY_MERGED') throw error;
      job.intent = null; job.phase = 'waiting';
      job.summary = 'Cancellation arrived after the PR landed; delivery reconciliation will verify the accepted base.';
      await this.save(); this.wake();
      throw new Error(`Issue #${issue} cannot be cancelled because PR #${job.pr} already landed; delivery reconciliation is continuing.`);
    }
    job.cancelConfirmed = true; await this.save();
    const client = this.clients.get(issue);
    if (client) await this.haltClient(job, client);
    await this.tasks.get(issue);
    job.phase = 'cancelled'; job.summary = 'Cancelled by the operator; unfinished branch and worktree retained, automatic redispatch disabled.'; await this.save();
    await this.github.progress(job); this.wake();
  }
  async resume(issue, threadId) {
    const job = this.state.jobs.find(x => x.issue === issue);
    if (!job || !['blocked','stopped','uncertain'].includes(job.phase) || this.tasks.has(issue)) throw new Error('Only a stopped or blocked original issue can be resumed.');
    if (job.childPid && processExists(job.childPid)) throw new Error('Previous builder process is still alive; ownership remains uncertain.');
    const source = await this.github.issue(issue);
    if (source.state !== 'open') throw new Error('Reopen and reconcile the issue before resuming it.');
    if (!job.threadId && job.prepared) {
      const client = new this.Client({ cwd: job.worktree });
      try {
        await client.connect();
        const candidates = await client.listThreads({ cwd: job.worktree });
        if (threadId && !candidates.some(thread => thread.id === threadId)) throw new Error('Selected thread does not belong to this worktree.');
        const selected = threadId ? candidates.find(thread => thread.id === threadId) : candidates.length === 1 ? candidates[0] : null;
        if (!selected) throw new Error('Thread ownership is uncertain. Inspect Codex threads for this worktree, then use resume ISSUE --thread ID; no replacement builder was started.');
        const recovered = await client.readThread({ threadId: selected.id });
        if (recovered.turns?.some(turn => turn.status === 'inProgress')) throw new Error('The selected thread is still active; reconcile its owner first.');
        job.threadId = selected.id; await this.save();
      } finally { await client.close(); }
    } else if (threadId && threadId !== job.threadId) throw new Error('This issue already owns a different thread.');
    job.intent = null;
    if (!job.prepared) {
      try {
        await access(job.worktree);
        const marker = await git(job.worktree, 'rev-parse', '--absolute-git-dir');
        if ((await readFile(join(marker, 'symphony-lite-owned-worktree'), 'utf8')).trim() !== this.repo.root) throw new Error('Worktree ownership does not match.');
        if (await git(job.worktree, 'branch', '--show-current') !== job.branch) throw new Error('Worktree branch does not match its issue owner.');
        job.worktreeCreated = true;
      } catch (error) { if (error.code !== 'ENOENT') throw error; if (job.worktreeCreated) throw new Error('The recorded worktree or ownership marker is missing; preserve state and reconcile it.'); }
      // Explicit resume authorizes repeating an interrupted preparation command.
      await this.prepare(job, await this.base());
    }
    job.phase = 'stopped'; job.repairAttempts = 0; await this.save(); this.wake();
  }
  async haltClient(job, client) {
    if (job.turnId) await client.interrupt({ threadId: job.threadId, turnId: job.turnId }).catch(error => this.emit('notice', error.message));
    // EOF also resolves pending startup RPCs. The client waits for process exit;
    // cancellation never depends on receiving a final assistant message.
    await client.close();
  }
  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true; clearInterval(this.timer);
    this.stopPromise = (async () => {
      for (const job of this.state.jobs) {
        if (!['complete','cancelled'].includes(job.phase)) job.intent = 'stop';
        const client = this.clients.get(job.issue);
        if (client) await this.haltClient(job, client);
      }
      await this.loop.close();
      await Promise.allSettled([...this.tasks.values()]);
      this.state.running = false; await this.save(); await this.store.release(); this.emit('stopped');
    })();
    return this.stopPromise;
  }
}
