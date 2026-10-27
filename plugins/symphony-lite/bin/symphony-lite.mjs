#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { watch, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { inspectRepository } from '../lib/worktrees.mjs';
import { loadConfig } from '../lib/config.mjs';
import { Store } from '../lib/state.mjs';
import { Coordinator } from '../lib/coordinator.mjs';

const HELP = `Symphony Lite 0.1.0 -- foreground GitHub/Codex issue worker pool
Usage: symphony-lite [--agents N] [--poll-interval 5m]
       symphony-lite signal | status | stop | cancel ISSUE
       symphony-lite resume ISSUE [--role builder|reviewer] [--thread ID]

Run from a configured repository with symphony-lite.json. Defaults: one issue
through landing, five-minute polling. Enter requests a scan; it never approves
a question. Type 'answer ISSUE:REQUEST VALUE' to answer a displayed request.
Ctrl+C stops admission and interrupts active turns, preserving recovery state.
No production issue starts from installation alone.
`;

export function parseArgs(args) {
  const result = { command: 'run', overrides: {} };
  if (args[0] && !args[0].startsWith('-')) result.command = args.shift();
  if (!['run','signal','status','stop','cancel','resume'].includes(result.command)) throw new Error(`Unknown command: ${result.command}`);
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
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (result.command !== 'run' && Object.keys(result.overrides).length) throw new Error('Runtime options apply only to run.');
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return; }
  if (args.includes('--version')) { console.log('0.1.0'); return; }
  const options = parseArgs(args);
  const repo = await inspectRepository(process.cwd());
  const store = new Store(repo.commonDir);
  if (options.command === 'status') {
    const state = await store.read(); const owner = await store.owner();
    console.log(JSON.stringify({ owner, ...state, controls: await store.results() }, null, 2)); return;
  }
  if (options.command !== 'run') {
    const queued = await store.send(options.command, options.issue, options.threadId, options.role);
    console.log(`${options.command} queued (${queued.id}); use status to inspect the resulting state.`); return;
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
        if (request.command === 'stop') {
          // Stop itself has no external side effect beyond retaining work and releasing
          // ownership. Acknowledge before release; later commands remain for the next run.
          await store.acknowledge(request); await coordinator.stop(); break;
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
    // Initialize storage before watching. A local filesystem fallback covers missed fs.watch events;
    // this never performs GitHub/model polling at the fallback frequency.
    await store.initialize();
    watcher = watch(store.controls, () => controls());
    fallback = setInterval(controls, 1000);
    console.log(`Symphony Lite: ${config.repository}; ${config.agents} issue slot(s); polling ${config.pollMs / 1000}s. Enter scans, Ctrl+C stops.`);
    await coordinator.start({ beforeScan: async () => { controlsReady = true; await controls(); } });
  } catch (error) { cleanup(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  main().catch(error => { console.error(`symphony-lite: ${error.message}`); process.exitCode = 1; });
}
