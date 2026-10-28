#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { watch, realpathSync } from 'node:fs';
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { hostname } from 'node:os';
import { inspectRepository } from '../lib/worktrees.mjs';
import { loadConfig } from '../lib/config.mjs';
import { Store, prepareServiceLog, appendServiceLog } from '../lib/state.mjs';
import { Coordinator } from '../lib/coordinator.mjs';
import { GitHub } from '../lib/github.mjs';
import { applyMigration, previewMigration } from '../lib/migration.mjs';
import { processExists } from '../lib/state.mjs';
import { atomicJSON } from '../lib/state.mjs';
import { ensureService, signalIfEnabled } from '../lib/bootstrap.mjs';
import { git } from '../lib/process.mjs';

const HELP = `Conductor 0.1.0 -- conversational GitHub issue director
Usage: conductor enable [--thread UUID]
       conductor enable --host desktop --thread UUID
       conductor attach --host desktop --thread UUID
       conductor wakeup
       conductor signal                    (internal, passive)
       conductor start --thread UUID       (compatibility)
       conductor serve [--thread UUID]      (internal)
       conductor rpc --request-file PATH
       conductor status | conductor cleanup [--preview] | conductor stop | conductor migrate [--apply --mapping FILE]

Use enable to persistently enable the repository runner. Wakeup resumes
observation and requests a check. Passive signals never re-enable a stopped runner.
Migration preview makes no changes; migrated configuration remains admission-paused.
`;

export function parseArgs(args) {
  const result = { command: 'run', overrides: {} };
  if (args[0] && !args[0].startsWith('-')) result.command = args.shift();
  if (!['run','signal','status','cleanup','stop','cancel','resume','start','serve','rpc','migrate','enable','wakeup','attach'].includes(result.command)) throw new Error(`Unknown command: ${result.command}`);
  if (result.command === 'cleanup') {
    const option = args.shift();
    if (option !== undefined && option !== '--preview') throw new Error('cleanup accepts only --preview.');
    if (args.length) throw new Error('cleanup accepts only --preview.');
    result.preview = option === '--preview'; return result;
  }
  if (['cancel','resume'].includes(result.command)) {
    result.issue = Number(args.shift());
    if (!Number.isSafeInteger(result.issue) || result.issue < 1) throw new Error(`${result.command} requires a positive issue number.`);
  }
  while (args.length) {
    const flag = args.shift();
    if (flag === '--agents') result.overrides.agents = Number(args.shift());
    else if (flag === '--poll-interval') { result.overrides.pollInterval = args.shift(); if (!result.overrides.pollInterval) throw new Error('--poll-interval requires a duration.'); }
    else if (flag === '--thread' && result.command === 'resume') { result.threadId = args.shift(); if (!result.threadId) throw new Error('--thread requires the existing thread ID.'); }
    else if (flag === '--role' && result.command === 'resume') { result.role = args.shift(); if (!['builder', 'reviewer'].includes(result.role)) throw new Error('--role must be builder or reviewer.'); }
    else if (flag === '--thread' && ['start','serve','enable','attach'].includes(result.command)) { result.threadId = args.shift(); if (!result.threadId) throw new Error('--thread requires a thread ID.'); }
    else if (flag === '--host' && ['start','serve','enable','attach'].includes(result.command)) { result.host = args.shift(); if (!['desktop', 'daemon'].includes(result.host)) throw new Error('--host must be desktop or daemon.'); }
    else if (flag === '--attach-only' && result.command === 'serve') result.attachOnly = true;
    else if (flag === '--handoff-thread' && result.command === 'serve') { result.handoffThreadId = args.shift(); if (!result.handoffThreadId) throw new Error('--handoff-thread requires a thread ID.'); }
    else if (flag === '--enable' && result.command === 'serve') result.enable = true;
    else if (flag === '--manual-wake' && result.command === 'serve') result.manualWake = true;
    else if (flag === '--request-file' && result.command === 'rpc') { result.requestFile = args.shift(); if (!result.requestFile) throw new Error('--request-file requires a JSON file.'); }
    else if (flag === '--apply' && result.command === 'migrate') result.apply = true;
    else if (flag === '--mapping' && result.command === 'migrate') { result.mappingFile = args.shift(); if (!result.mappingFile) throw new Error('--mapping requires a JSON file.'); }
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (['start','serve','enable','attach'].includes(result.command) && result.threadId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result.threadId)) throw new Error('--thread must be the existing director thread UUID.');
  if (result.command === 'attach' && (result.host !== 'desktop' || !result.threadId)) throw new Error('attach requires --host desktop --thread UUID.');
  if (result.command === 'serve' && result.handoffThreadId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result.handoffThreadId)) throw new Error('--handoff-thread must be an existing Desktop chat UUID.');
  if (result.command === 'enable' && result.host === 'desktop' && !result.threadId) throw new Error('Desktop mode requires --thread with the current Codex Desktop chat UUID; Conductor cannot create a private replacement chat.');
  if (result.command !== 'run' && Object.keys(result.overrides).length) throw new Error('Runtime options apply only to run.');
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return; }
  if (args.includes('--version')) { console.log('0.1.0'); return; }
  const options = parseArgs(args);
  if (options.command === 'serve' && process.env.CONDUCTOR_SERVICE_LOG) {
    const earlyLogPath = process.env.CONDUCTOR_SERVICE_LOG;
    const writeLog = (chunk, encoding, callback) => {
      const done = typeof encoding === 'function' ? encoding : callback;
      try { appendServiceLog(earlyLogPath, Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk)); done?.(); return true; }
      catch (error) { if (done) { done(error); return false; } throw error; }
    };
    process.stdout.write = writeLog;
    process.stderr.write = writeLog;
  }
  const repo = await inspectRepository(process.cwd());
  const store = new Store(repo.commonDir);
  const cliPath = fileURLToPath(import.meta.url);
  const launch = async (command, argv, spawnOptions) => {
    const logPath = resolve(store.dir, 'service.log');
    mkdirSync(store.dir, { recursive: true });
    await prepareServiceLog(logPath);
    return spawn(command, argv, { ...spawnOptions, env: { ...process.env, CONDUCTOR_SERVICE_LOG: logPath }, stdio: 'ignore' });
  };
  if (options.command === 'migrate') {
    const raw = JSON.parse(readFileSync(resolve(repo.root, 'conductor.json'), 'utf8'));
    if (raw.version === 2) { console.log('Configuration already uses Conductor director policy v2.'); return; }
    const github = new GitHub(raw.repository, { cwd: repo.root });
    const labels = { triage: 'triage', proposal: 'proposal', ready: 'ready', hold: 'on-hold', needsInput: 'needs-input' };
    if (options.apply) {
      if (!options.mappingFile) throw new Error('Applying migration requires --mapping FILE with explicit issue states and preview revisions.');
      const mapping = JSON.parse(readFileSync(resolve(options.mappingFile), 'utf8'));
      const remote = await git(repo.root, 'remote', 'get-url', 'origin');
      const repoName = remote.replace(/\.git$/, '').match(/(?:github\.com[:/])([^/]+\/[^/]+)$/)?.[1];
      if (repoName?.toLowerCase() !== raw.repository.toLowerCase()) throw new Error('origin does not match configured repository; migration writes were not started.');
      const owner = await store.owner();
      if (owner && (owner.hostname !== hostname() || owner.platform !== process.platform || processExists(owner.pid))) throw new Error('A live or foreign Conductor owner exists. Migration must run in the owning environment after that service is stopped.');
      await store.acquire();
      try {
        const state = await store.read(); state.admissionPaused = true; await store.save(state);
        const records = previewMigration(await github.openIssues(), raw.readyLabel ?? 'conductor:ready', labels);
        await github.ensureWorkflowLabels(labels);
        const result = await applyMigration(github, records, mapping, labels, raw.readyLabel ?? 'conductor:ready');
        const configPath = resolve(repo.root, 'conductor.json');
        const backupPath = `${configPath}.legacy-${new Date().toISOString().replaceAll(':', '-')}.bak`;
        copyFileSync(configPath, backupPath);
        const migrated = { ...raw, version: 2, labels, pollInterval: raw.pollInterval ?? '30m', directorModel: raw.directorModel ?? 'gpt-6.1-sol', plannerModel: raw.plannerModel ?? 'gpt-6-astra', admissionPaused: true };
        delete migrated.readyLabel;
        await atomicJSON(configPath, migrated);
        console.log(JSON.stringify({ applied: result.length, repository: raw.repository, configPath, backupPath, admissionPaused: true }));
      } finally { await store.release(); }
      return;
    }
    const records = previewMigration(await github.openIssues(), raw.readyLabel ?? 'conductor:ready', labels);
    console.log(JSON.stringify({ action: 'preview', repository: raw.repository, legacyReadyLabel: raw.readyLabel ?? 'conductor:ready', proposedLabels: labels, admissionPaused: true, issues: records, message: 'No changes made. Review this preview, prepare a mapping of issue number to {state, revision}, then pass it with --apply --mapping FILE.' }, null, 2)); return;
  }
  if (options.command === 'status') {
    const state = await store.read(); const owner = await store.owner();
    console.log(JSON.stringify({ owner, ...state, controls: await store.results() }, null, 2)); return;
  }
  if (options.command === 'cleanup') {
    let configVerified = false;
    try { configVerified = (await loadConfig(repo.root)).version === 2; } catch { /* Expired migration backups remain available until valid configuration loads. */ }
    if (options.preview) {
      const result = await store.previewCleanup(), backups = await store.previewMigrationBackups(repo.root, Date.now(), configVerified);
      console.log(JSON.stringify({ preview: true, ...result, backupCandidates: backups.candidates, exceptions: [...result.retained, ...backups.retained] }, null, 2)); return;
    }
    const result = await store.cleanupStopped(Date.now(), repo.root, configVerified);
    console.log(JSON.stringify(result, null, 2)); return;
  }
  if (['start','enable','wakeup','attach'].includes(options.command)) {
    if (options.command === 'start' && !options.threadId) throw new Error('Start requires --thread with the existing director chat UUID. Use `conductor enable` to create or resume the configured director automatically.');
    const enabled = options.command === 'start' || options.command === 'enable' || options.command === 'attach';
    const result = await ensureService({ store, root: repo.root, threadId: options.threadId, attachThreadId: options.command === 'attach' ? options.threadId : undefined, host: options.host,
      enable: enabled, manualWake: options.command === 'wakeup' || options.command === 'start' || options.command === 'enable',
      execute: launch, cliPath });
    if (result.status === 'disabled') throw new Error('Conductor is not enabled for this repository. Run `conductor enable` explicitly first.');
    console.log(JSON.stringify({ ...result, repository: (await loadConfig(repo.root)).repository, logPath: resolve(store.dir, 'service.log') })); return;
  }
  if (options.command === 'signal') {
    const result = await signalIfEnabled({ store, root: repo.root, execute: launch, cliPath });
    if (result.status === 'started' || result.status === 'already-running') {
      const request = await store.send('signal');
      console.log(JSON.stringify({ ...result, signalQueued: true, requestId: request.id }));
    } else console.log(JSON.stringify({ ...result, signalQueued: false }));
    return;
  }
  if (options.command === 'rpc') {
    if (!options.requestFile) throw new Error('rpc requires --request-file PATH.');
    const payload = JSON.parse(readFileSync(resolve(options.requestFile), 'utf8'));
    const state = await store.read();
    if (payload.repository !== state.repository) throw new Error('Request must name the exact active repository.');
    if (payload.threadId !== state.director?.threadId) throw new Error('Request must name the exact bound director chat.');
    const request = await store.sendRequest(payload);
    console.log(JSON.stringify({ accepted: !request.completed, completed: request.completed === true, id: request.id, op: request.op, result: request.result ?? null, error: request.error ?? null })); return;
  }
  if (!['run','serve'].includes(options.command)) {
    const queued = await store.send(options.command, options.issue, options.threadId, options.role);
    console.log(`${options.command} queued (${queued.id}); use status to inspect the resulting state.`); return;
  }
  if (options.command === 'run') throw new Error('The legacy foreground runner no longer starts work. Bind and start the conversational director with `conductor start --thread UUID`.');
  if (options.command === 'serve') {
    const serviceLog = resolve(store.dir, 'service.log');
    console.log = (...values) => appendServiceLog(serviceLog, values.join(' '));
    console.error = (...values) => appendServiceLog(serviceLog, values.join(' '));
    console.warn = (...values) => appendServiceLog(serviceLog, values.join(' '));
  }
  const config = await loadConfig(repo.root, options.overrides);
  const coordinator = new Coordinator({ repo, config, store });
  coordinator.on('notice', message => console.error(message));
  coordinator.on('request', request => {
    const reviewer = request.role === 'reviewer';
    console.log(`\nIssue #${request.issue} ${request.role ?? 'builder'} session needs input (${request.method}).\n${JSON.stringify(request.params, null, 2)}\n${reviewer ? 'Reviewer requests cannot be approved; stop and reconcile the read-only review.' : `Answer with: answer ${request.key} <explicit decision or JSON response>`}\nEnter alone only scans GitHub.`);
  });
  const seen = new Map();
  coordinator.on('status', state => {
    for (const job of state.jobs) {
      const sessions = [job.builderThreadId ?? job.threadId, job.reviewerThreadId].filter(Boolean).map((id, index) => `${index ? 'reviewer' : 'builder'}:${id}`).join(' ');
      const role = ['building','reviewing','launching','starting','preparing'].includes(job.phase) ? job.activeRole : ['stopped','uncertain','blocked','repair','review'].includes(job.phase) ? job.nextRole ?? job.activeRole : null;
      const line = `#${job.issue} ${job.phase}${role ? ` (${role})` : ''}${job.pr ? ` PR #${job.pr}` : ''}${sessions ? ` ${sessions}` : ''}${job.lastError ? ` -- ${job.lastError}` : ''}`;
      if (seen.get(job.issue) !== line) { console.log(line); seen.set(job.issue, line); }
    }
  });
  let controlsRunning = false, controlsReady = false;
  async function controls() {
    if (controlsRunning || !controlsReady) return;
    controlsRunning = true;
    try {
      for (const request of await store.drain()) {
        if (request.owner !== store.token) {
          await store.acknowledge(request, 'Control request belongs to a previous Conductor owner; inspect and resubmit against the current owner.');
          continue;
        }
        if (request.op) {
          let failure, result;
          try { result = await coordinator.control(request); }
          catch (error) { failure = error.message; console.error(error.message); }
          await store.acknowledge(request, failure, result);
          if (request.op === 'stop') { await coordinator.stop(); break; }
          continue;
        }
        if (request.command === 'stop') {
          // Stop itself has no external side effect beyond retaining work and releasing
          // ownership. Acknowledge before release; later commands remain for the next run.
          await store.acknowledge(request); await coordinator.stop({ explicit: true }); break;
        }
        let failure;
        try {
          if (request.command === 'signal') coordinator.wake();
          else if (request.command === 'cancel') await coordinator.cancel(request.issue);
          else if (request.command === 'resume') await coordinator.resume(request.issue, request.threadId, request.role);
          else throw new Error(`Unknown queued command: ${request.command}`);
        } catch (error) { failure = error.message; console.error(error.message); }
        await store.acknowledge(request, failure);
      }
    } catch (error) { console.error(error.message); }
    finally { controlsRunning = false; }
  }
  const input = createInterface({ input: process.stdin, terminal: false });
  input.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) { coordinator.wake(); return; }
    if (trimmed === 'stop') { coordinator.stop().catch(error => console.error(error.message)); return; }
    const match = /^answer\s+(\S+)\s+(.+)$/.exec(trimmed);
    if (match) coordinator.answer(match[1], match[2]).catch(error => console.error(error.message));
    else console.error('Enter scans; use answer ISSUE:REQUEST VALUE for a pending question, or stop.');
  });
  const onSignal = () => coordinator.stop().catch(error => { console.error(error.message); process.exitCode = 1; });
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  let watcher, fallback;
  function cleanup() { watcher?.close(); clearInterval(fallback); input.close(); process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); }
  coordinator.once('stopped', cleanup);
  try {
    const saved = await store.read();
    if (options.threadId && saved.director?.threadId && saved.director.threadId !== options.threadId) throw new Error('Director thread is not bound to this repository. Start with its saved binding or explicitly reconcile the binding.');
    // Initialize storage before watching. A local filesystem fallback covers missed fs.watch events;
    // this never performs GitHub/model polling at the fallback frequency.
    await store.initialize();
    watcher = watch(store.controls, () => controls());
    fallback = setInterval(controls, 1000);
  console.log(`Conductor director: ${config.repository}; ${config.agents} worker slot(s); external reconciliation every ${config.pollMs / 60000}m.`);
    await coordinator.start({ threadId: options.threadId, host: options.host, enable: options.enable === true, manualWake: options.manualWake === true, attachOnly: options.attachOnly, handoffThreadId: options.handoffThreadId, beforeScan: async () => { controlsReady = true; await controls(); } });
  } catch (error) { cleanup(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  main().catch(error => { console.error(`conductor: ${error.message}`); process.exitCode = 1; });
}
