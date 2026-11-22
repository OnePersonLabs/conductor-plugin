import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ClaudeClient, ClaudeStore } from '../plugins/conductor/lib/claude.mjs';
import { DirectorActivity } from '../plugins/conductor/lib/director-activity.mjs';
import { ARM_WAITER, handleDirectorLifecycle } from '../plugins/conductor/lib/director-lifecycle.mjs';
import { waitForDirectorWake } from '../plugins/conductor/lib/claude-director.mjs';
import { hostModeFor, selectRuntime } from '../plugins/conductor/lib/runtime.mjs';
import { validateSetupConfig } from '../plugins/conductor/lib/config.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/claude-cli.mjs', import.meta.url));
const DIRECTOR = '019c6e27-e55b-73d1-87d8-4e01f1f75046';
const WAKE = '019c6e27-0000-4000-8000-000000000001';

async function client(t, settings) {
  const home = await mkdtemp(join(tmpdir(), 'conductor-claude-'));
  const log = join(home, 'calls.jsonl');
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: home, FAKE_CLAUDE_LOG: log };
  const instance = new ClaudeClient({ cwd: home, env, command: FAKE, settings });
  await instance.connect();
  const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { client: instance, home, calls };
}

function completion(instance) {
  const events = [];
  return new Promise(resolve => instance.on('notification', ({ method, params }) => {
    events.push({ method, params });
    if (method === 'turn/completed') resolve({ turn: params.turn, events });
  }));
}

test('runtime selection prefers configuration, then CONDUCTOR_RUNTIME, then the launching host', () => {
  assert.equal(selectRuntime({ config: { runtime: 'codex' }, env: { CLAUDECODE: '1' } }), 'codex');
  assert.equal(selectRuntime({ env: { CONDUCTOR_RUNTIME: 'claude' } }), 'claude');
  assert.equal(selectRuntime({ env: { CLAUDECODE: '1' } }), 'claude');
  assert.equal(selectRuntime({ env: {} }), 'codex');
  assert.equal(hostModeFor('claude', 'desktop'), 'claude-code');
  assert.equal(hostModeFor('claude', 'daemon'), 'claude-headless');
  assert.throws(() => hostModeFor('claude', 'codex-desktop'), /codex runtime/);
  const config = validateSetupConfig({ version: 2, runtime: 'claude', repository: 'o/r', baseBranch: 'main', authorized: false, checks: [{ command: 'npm', args: ['test'] }] });
  assert.equal(config.directorModel, 'sonnet');
  assert.throws(() => validateSetupConfig({ ...config, claude: { permissionMode: 'yolo' } }), /permissionMode/);
});

test('a worker turn creates the session, then resumes it, and reports Codex-shaped events', async t => {
  const { client: instance, calls } = await client(t, { permissionMode: 'acceptEdits', allowedTools: ['Bash(npm test:*)'] });
  const thread = await instance.startThread({ model: 'opus', reasoningEffort: 'high' });
  await instance.setThreadName({ threadId: thread.id, name: 'owner/repo #1 - builder' });

  let done = completion(instance);
  await instance.startTurn({ threadId: thread.id, prompt: 'build it', outputSchema: { type: 'object' } });
  let { turn, events } = await done;
  assert.equal(turn.status, 'completed');
  assert.deepEqual(events.map(event => event.method), ['turn/started', 'item/completed', 'turn/completed']);
  assert.equal(events[1].params.item.type, 'agentMessage');
  assert.deepEqual(JSON.parse(events[1].params.item.text), { ok: true });

  done = completion(instance);
  await instance.startTurn({ threadId: thread.id, prompt: 'again' });
  await done;
  const [first, second] = await calls();
  assert.equal(first.args[first.args.indexOf('--session-id') + 1], thread.id);
  assert.equal(second.args[second.args.indexOf('--resume') + 1], thread.id);
  for (const flag of ['--model', '--effort', '--name', '--permission-mode', '--allowedTools']) assert.ok(first.args.includes(flag), flag);
  assert.equal(first.args[first.args.indexOf('--permission-mode') + 1], 'acceptEdits');

  const read = await instance.readThread({ threadId: thread.id });
  assert.equal(read.status.type, 'idle');
  assert.equal(read.name, 'owner/repo #1 - builder');
  assert.deepEqual(read.turns.map(item => item.status), ['completed', 'completed']);
});

test('plan mode stays read-only, emits the plan item, and keeps the worker from leaving plan mode', async t => {
  const { client: instance, calls } = await client(t, { permissionMode: 'bypassPermissions' });
  const thread = await instance.startThread({});
  await instance.updateThreadSettings({ threadId: thread.id, mode: 'plan', model: 'opus', effort: 'xhigh' });
  const done = completion(instance);
  await instance.startTurn({ threadId: thread.id, prompt: 'plan it' });
  const { events } = await done;
  const plan = events.find(event => event.params.item?.type === 'plan');
  assert.match(plan.params.item.text, /Read the code/);
  const [call] = await calls();
  assert.equal(call.args[call.args.indexOf('--permission-mode') + 1], 'plan');
  assert.ok(call.args.includes('ExitPlanMode'));
  assert.ok(!call.args.includes('bypassPermissions'));
  const settings = await instance.resumeThread({ threadId: thread.id, includeSettings: true });
  assert.deepEqual([settings.collaborationMode.mode, settings.model, settings.reasoningEffort], ['plan', 'opus', 'xhigh']);
});

test('failed and interrupted turns are terminal and leave no running turn behind', async t => {
  const { client: instance } = await client(t);
  const thread = await instance.startThread({});
  let done = completion(instance);
  await instance.startTurn({ threadId: thread.id, prompt: 'FAIL' });
  let { turn } = await done;
  assert.equal(turn.status, 'failed');
  assert.match(turn.error.message, /fake failure/);

  done = completion(instance);
  const started = await instance.startTurn({ threadId: thread.id, prompt: 'SLEEP' });
  assert.equal((await instance.readThread({ threadId: thread.id })).status.type, 'active');
  await assert.rejects(instance.startTurn({ threadId: thread.id, prompt: 'again' }), /already has a running turn/);
  await instance.interrupt({ threadId: thread.id, turnId: started.id });
  ({ turn } = await done);
  assert.equal(turn.status, 'interrupted');
  assert.equal((await instance.readThread({ threadId: thread.id })).status.type, 'idle');
});

async function directorRepo(t) {
  const root = await mkdtemp(join(tmpdir(), 'conductor-claude-director-'));
  const home = join(root, '.claude-home');
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status, 0);
  git('init', '-q');
  await writeFile(join(root, 'conductor.json'), JSON.stringify({ version: 2, runtime: 'claude', repository: 'OnePersonLabs/example' }));
  const dir = join(root, '.git', 'conductor');
  await mkdir(dir, { recursive: true });
  const state = {
    version: 1, jobs: [], runtimeEnabled: true,
    director: { threadId: DIRECTOR, enabled: true, threadHostOwnership: { threadId: DIRECTOR, host: 'claude-code' }, batches: [] },
  };
  await writeFile(join(dir, 'state.json'), JSON.stringify(state));
  const store = new ClaudeStore({ home });
  const hook = (event, extra = {}) => handleDirectorLifecycle({ cwd: root, session_id: DIRECTOR, transcript_path: join(home, 'x.jsonl'), hook_event_name: event, ...extra }, { claudeStore: store });
  const activity = () => new DirectorActivity({ dir });
  return { root, dir, home, store, hook, activity, state };
}

test('Claude Code director hooks derive turns and deliver a queued wake at Stop', async t => {
  const { store, hook, activity } = await directorRepo(t);
  const prompt = await hook('UserPromptSubmit', { prompt: 'check issues' });
  assert.match(prompt.hookOutput.hookSpecificOutput.additionalContext, /director-wait/);
  const active = activity(); const turn = (await active.read(DIRECTOR)).turnId; active.close();
  assert.equal(prompt.status.state, 'active');

  store.enqueue(DIRECTOR, { text: `wake\n<!-- conductor:director-wakeup:${WAKE} -->\ncheck`, clientUserMessageId: `conductor-director-${WAKE}` });
  const stop = await hook('Stop', { stop_hook_active: false });
  assert.equal(stop.hookOutput.decision, 'block');
  assert.match(stop.hookOutput.reason, /check/);
  assert.deepEqual(store.queue(DIRECTOR), []);
  const after = activity(); const consumed = await after.read(DIRECTOR); after.close();
  assert.equal(consumed.state, 'active');
  assert.equal(consumed.wakeupMarker, WAKE);
  assert.notEqual(consumed.turnId, turn);

  // The continued turn ends; with no waiter armed, the director is reminded once.
  const idle = await hook('Stop', { stop_hook_active: false });
  assert.equal(idle.status.state, 'idle');
  assert.equal(idle.hookOutput.reason, ARM_WAITER);
  assert.deepEqual((await hook('Stop', { stop_hook_active: true })).hookOutput, {});
});

test('director-wait delivers one queued wake to the bound session and refuses others', async t => {
  const { root, store, activity } = await directorRepo(t);
  await assert.rejects(waitForDirectorWake({ cwd: root, env: { CLAUDE_CODE_SESSION_ID: WAKE }, store }), /Only the bound director session/);
  // Bounded so a failed assertion cannot leave the waiter holding the test process open.
  const waiting = waitForDirectorWake({ cwd: root, env: { CLAUDE_CODE_SESSION_ID: DIRECTOR }, store, pollMs: 20, timeoutMs: 15_000 });
  for (let attempt = 0; attempt < 250 && !store.waiter(DIRECTOR); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(store.waiter(DIRECTOR));
  store.enqueue(DIRECTOR, { text: `<!-- conductor:director-wakeup:${WAKE} -->\nnew events`, clientUserMessageId: 'a' });
  const outcome = await waiting;
  assert.equal(outcome.status, 'woken');
  assert.match(outcome.text, /new events/);
  assert.equal(store.waiter(DIRECTOR), null);
  const recorded = activity(); assert.equal((await recorded.read(DIRECTOR)).wakeupMarker, WAKE); recorded.close();
  assert.equal((await waitForDirectorWake({ cwd: root, env: {}, store, timeoutMs: 30, pollMs: 10 })).status, 'timeout');
});

test('a paused runner blocks an unauthorized Claude wake instead of delivering it', async t => {
  const { dir, store, hook, state, activity } = await directorRepo(t);
  state.runnerPause = { reason: 'stopped by user', at: new Date().toISOString() };
  state.director.batches = [{ id: WAKE, threadId: DIRECTOR, status: 'queued' }];
  await writeFile(join(dir, 'state.json'), JSON.stringify(state));
  store.enqueue(DIRECTOR, { text: `<!-- conductor:director-wakeup:${WAKE} -->\nwork`, clientUserMessageId: 'b' });
  const stop = await hook('Stop', { stop_hook_active: false });
  assert.notEqual(stop.hookOutput.decision, 'block');
  assert.deepEqual(store.queue(DIRECTOR), []);
  const recorded = activity(); assert.deepEqual(recorded.blockedWakeups(DIRECTOR).map(item => item.batchId), [WAKE]); recorded.close();
});
