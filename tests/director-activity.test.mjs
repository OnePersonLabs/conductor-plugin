import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DirectorActivity } from '../plugins/conductor/lib/director-activity.mjs';
import { handleDirectorLifecycle } from '../plugins/conductor/lib/director-lifecycle.mjs';
import { DirectorEvents } from '../plugins/conductor/lib/director-events.mjs';

const DESTINATION = '019c6e27-e55b-73d1-87d8-4e01f1f75046';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'conductor-activity-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await writeFile(join(root, 'README.md'), 'fixture\n'); git('add', 'README.md'); git('commit', '-qm', 'fixture');
  await writeFile(join(root, 'conductor.json'), JSON.stringify({ version: 2, repository: 'OnePersonLabs/example' }));
  const common = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const dir = join(root, common, 'conductor');
  await mkdir(dir, { recursive: true });
  const threadId = 'thr-director';
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    version: 1, jobs: [], runtimeEnabled: true,
    director: { threadId, enabled: true, threadHostOwnership: { threadId, host: 'codex-desktop' } },
  }));
  const close = [];
  t.after(async () => {
    for (const fn of close) fn();
    await rm(root, { recursive: true, force: true });
  });
  return { root, dir, threadId, close };
}

test('missing activity is unknown; matching prompt creates active persisted state', async t => {
  const { dir, close } = await fixture(t);
  const activity = new DirectorActivity({ dir });
  close.push(() => activity.close());
  assert.deepEqual(await activity.read('thr-director'), { state: 'unknown', turnId: null, wakeupMarker: null, revision: 0 });
  assert.deepEqual(await activity.record({ threadId: 'thr-director', turnId: 'turn-1', event: 'UserPromptSubmit' }), { state: 'active', turnId: 'turn-1', wakeupMarker: null, revision: 1 });
  activity.close();
  const recovered = new DirectorActivity({ dir });
  close.push(() => recovered.close());
  assert.deepEqual(await recovered.read('thr-director'), { state: 'active', turnId: 'turn-1', wakeupMarker: null, revision: 1 });
});

test('only matching terminal turn changes active state; stale Stop cannot clear a newer turn', async t => {
  const { dir, close } = await fixture(t);
  const activity = new DirectorActivity({ dir }); close.push(() => activity.close());
  await activity.record({ threadId: 'thr-director', turnId: 'turn-old', event: 'UserPromptSubmit' });
  assert.equal((await activity.record({ threadId: 'thr-director', turnId: 'turn-new', event: 'UserPromptSubmit' })).turnId, 'turn-new');
  assert.deepEqual(await activity.record({ threadId: 'thr-director', turnId: 'turn-old', event: 'Stop' }), { state: 'active', turnId: 'turn-new', wakeupMarker: null, revision: 2 });
  assert.deepEqual(await activity.record({ threadId: 'thr-director', turnId: 'turn-new', event: 'Stop' }), { state: 'idle', turnId: 'turn-new', wakeupMarker: null, revision: 3 });
  assert.deepEqual(await activity.record({ threadId: 'thr-director', turnId: 'turn-new', event: 'Interrupt' }), { state: 'idle', turnId: 'turn-new', wakeupMarker: null, revision: 3 });
});

test('Interrupt is distinct from idle and an old terminal event cannot override it', async t => {
  const { dir, close } = await fixture(t);
  const activity = new DirectorActivity({ dir }); close.push(() => activity.close());
  await activity.record({ threadId: 'thr-director', turnId: 'turn-1', event: 'UserPromptSubmit' });
  assert.deepEqual(await activity.record({ threadId: 'thr-director', turnId: 'turn-1', event: 'Interrupt' }), { state: 'interrupted', turnId: 'turn-1', wakeupMarker: null, revision: 2 });
  assert.deepEqual(await activity.record({ threadId: 'thr-director', turnId: 'turn-1', event: 'Stop' }), { state: 'interrupted', turnId: 'turn-1', wakeupMarker: null, revision: 2 });
});

test('late PostToolUse enrollment marks only unknown or same-turn activity and never supersedes a newer turn', async t => {
  const { dir, close } = await fixture(t);
  const activity = new DirectorActivity({ dir }); close.push(() => activity.close());
  assert.deepEqual(await activity.record({ threadId: 'thr-director', turnId: 'enrolled-turn', event: 'PostToolUse' }), { state: 'active', turnId: 'enrolled-turn', wakeupMarker: null, revision: 1 });
  await activity.record({ threadId: 'thr-director', turnId: 'newer-turn', event: 'UserPromptSubmit' });
  assert.deepEqual(await activity.record({ threadId: 'thr-director', turnId: 'enrolled-turn', event: 'PostToolUse' }), { state: 'active', turnId: 'newer-turn', wakeupMarker: null, revision: 2 });
});

test('wakeup marker is durable turn evidence and terminal hooks preserve it', async t => {
  const { dir, close } = await fixture(t);
  const activity = new DirectorActivity({ dir }); close.push(() => activity.close());
  const marker = '550e8400-e29b-41d4-a716-446655440000';
  assert.deepEqual(await activity.record({ threadId: 'thr-director', turnId: 'wake-turn', event: 'UserPromptSubmit', wakeupMarker: marker }), { state: 'active', turnId: 'wake-turn', wakeupMarker: marker, revision: 1 });
  assert.deepEqual(await activity.record({ threadId: 'thr-director', turnId: 'wake-turn', event: 'PostToolUse' }), { state: 'active', turnId: 'wake-turn', wakeupMarker: marker, revision: 1 });
  assert.deepEqual(await activity.record({ threadId: 'thr-director', turnId: 'wake-turn', event: 'Stop' }), { state: 'idle', turnId: 'wake-turn', wakeupMarker: marker, revision: 2 });
  assert.deepEqual(await activity.record({ threadId: 'thr-director', turnId: 'manual-turn', event: 'UserPromptSubmit' }), { state: 'active', turnId: 'manual-turn', wakeupMarker: null, revision: 3 });
  await assert.rejects(activity.record({ threadId: 'thr-director', turnId: 'bad-marker-turn', event: 'UserPromptSubmit', wakeupMarker: 'not-a-uuid' }), /wakeupMarker must be a UUID/);
});

test('activity rows are isolated by thread and unmatched terminals do not create them', async t => {
  const { dir, close } = await fixture(t);
  const activity = new DirectorActivity({ dir }); close.push(() => activity.close());
  assert.deepEqual(await activity.record({ threadId: 'other-thread', turnId: 'turn-1', event: 'Stop' }), { state: 'unknown', turnId: null, wakeupMarker: null, revision: 0 });
  await activity.record({ threadId: 'thr-director', turnId: 'turn-1', event: 'UserPromptSubmit' });
  assert.deepEqual(await activity.read('other-thread'), { state: 'unknown', turnId: null, wakeupMarker: null, revision: 0 });
});

test('binding a new chat retires old receipts and enrolls its already-open turn only from the exact baseline', async t => {
  const { dir, close } = await fixture(t);
  const activity = new DirectorActivity({ dir }); close.push(() => activity.close());
  await activity.record({ threadId: 'thr-director', turnId: 'prior-turn', event: 'UserPromptSubmit' });
  await activity.record({ threadId: 'thr-director', turnId: 'prior-turn', event: 'Stop' });
  const baseline = await activity.read('thr-director');
  await activity.pruneExcept(['destination']);
  assert.deepEqual(await activity.read('thr-director'), { state: 'unknown', turnId: null, wakeupMarker: null, revision: 0 });
  assert.deepEqual(await activity.record({ threadId: 'destination', turnId: 'already-open', event: 'PostToolUse', enrollmentBaseline: baseline }), { state: 'active', turnId: 'already-open', wakeupMarker: null, revision: 1 });
  await activity.record({ threadId: 'destination', turnId: 'already-open', event: 'Stop' });
  await activity.pruneExcept(['third-chat']);
  assert.deepEqual(await activity.record({ threadId: 'destination', turnId: 'late-old-turn', event: 'Stop' }), { state: 'unknown', turnId: null, wakeupMarker: null, revision: 0 });
});

test('pruning removes orphan active rows once the binding has moved', async t => {
  const { dir, close } = await fixture(t);
  const activity = new DirectorActivity({ dir }); close.push(() => activity.close());
  await activity.record({ threadId: 'thr-director', turnId: 'active-turn', event: 'UserPromptSubmit' });
  await activity.pruneExcept(['destination']);
  assert.equal((await activity.read('thr-director')).state, 'unknown');
});

test('hook writes activity and adds director skill context only for bound desktop thread', async t => {
  const { root, threadId } = await fixture(t);
  const calls = [];
  const activity = { record: async value => { calls.push(value); return { state: 'active', turnId: value.turnId, revision: 1 }; }, close() {} };
  const marker = '550e8400-e29b-41d4-a716-446655440000';
  const payload = { cwd: root, session_id: threadId, turn_id: 'turn-1', hook_event_name: 'UserPromptSubmit', prompt: `Wake now <!-- conductor:director-wakeup:${marker} -->` };
  const result = await handleDirectorLifecycle(payload, { activityFactory: () => activity });
  assert.equal(result.handled, true);
  assert.equal(result.hookOutput.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(result.hookOutput.hookSpecificOutput.additionalContext, /\$conductor:director/);
  assert.deepEqual(calls, [{ threadId, turnId: 'turn-1', event: 'UserPromptSubmit', wakeupMarker: marker }]);
  assert.equal((await handleDirectorLifecycle({ ...payload, session_id: 'worker-thread' }, { activityFactory: () => { throw Error('must not access another thread'); } })).handled, false);
  const enrollment = await handleDirectorLifecycle({ ...payload, hook_event_name: 'PostToolUse' }, { activityFactory: () => activity });
  assert.equal(enrollment.handled, true);
  assert.equal(enrollment.hookOutput, null);
  assert.equal(calls.at(-1).event, 'PostToolUse');
});

test('hook returns empty JSON for terminal events and blocks bound prompt on recording failure', async t => {
  const { root, threadId } = await fixture(t);
  const payload = { cwd: root, session_id: threadId, turn_id: 'turn-1', hook_event_name: 'Stop' };
  assert.deepEqual((await handleDirectorLifecycle(payload, { activityFactory: () => ({ record: async () => ({ state: 'idle' }), close() {} }) })).hookOutput, {});
  const failed = await handleDirectorLifecycle({ ...payload, hook_event_name: 'UserPromptSubmit' }, { activityFactory: () => ({ record: async () => { throw Error('db locked'); }, close() {} }) });
  assert.match(failed.error, /did not continue.*db locked/);
});

test('pending handoff informs source chat to finish and end, without making destination the bound chat early', async t => {
  const { root, dir, threadId } = await fixture(t);
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    version: 1, jobs: [], runtimeEnabled: true,
    director: { threadId, enabled: true, threadHostOwnership: { threadId, host: 'codex-desktop' }, handoff: { fromThreadId: threadId, toThreadId: DESTINATION, turnId: 'turn-1', status: 'waiting-turn' } },
  }));
  const result = await handleDirectorLifecycle({ cwd: root, session_id: threadId, turn_id: 'turn-2', hook_event_name: 'UserPromptSubmit', prompt: 'new request' }, { activityFactory: () => ({ record: async value => ({ state: 'active', turnId: value.turnId }), close() {} }) });
  assert.equal(result.handled, true);
  assert.match(result.hookOutput.hookSpecificOutput.additionalContext, /Finish only the current operation/);
  assert.match(result.hookOutput.hookSpecificOutput.additionalContext, /Do not wait for the replacement chat/);
  const destination = await handleDirectorLifecycle({ cwd: root, session_id: DESTINATION, turn_id: 'next-turn', hook_event_name: 'UserPromptSubmit', prompt: 'new request' });
  assert.equal(destination.handled, true);
  assert.equal(destination.hookOutput, null, 'pending chats receive lifecycle receipts but no conductor controls or context');
});

test('pending destination lifecycle is recorded without director context before binding', async t => {
  const { root, dir, threadId } = await fixture(t);
  const statePath = join(dir, 'state.json');
  const activity = new DirectorActivity({ dir });
  const hook = payload => handleDirectorLifecycle({ cwd: root, ...payload });
  const beforeHandoff = await hook({ session_id: DESTINATION, turn_id: 'new-turn', hook_event_name: 'UserPromptSubmit', prompt: 'Continue my work' });
  assert.equal(beforeHandoff.handled, false);
  await hook({ session_id: threadId, turn_id: 'old-turn', hook_event_name: 'UserPromptSubmit', prompt: 'Current director task' });
  await writeFile(statePath, JSON.stringify({ version: 1, jobs: [], runtimeEnabled: true, director: { threadId, enabled: true, threadHostOwnership: { threadId, host: 'codex-desktop' }, handoff: { fromThreadId: threadId, toThreadId: DESTINATION, status: 'waiting-turn', turnId: 'old-turn' } } }));
  const beforeBinding = await hook({ session_id: DESTINATION, turn_id: 'new-turn', hook_event_name: 'PostToolUse' });
  assert.equal(beforeBinding.handled, true);
  assert.equal(beforeBinding.hookOutput, null);
  assert.deepEqual(await activity.read(DESTINATION), { state: 'active', turnId: 'new-turn', wakeupMarker: null, revision: 1 });
  await hook({ session_id: DESTINATION, turn_id: 'new-turn', hook_event_name: 'Stop' });
  assert.equal((await activity.read(DESTINATION)).state, 'idle');
  await hook({ session_id: threadId, turn_id: 'old-turn', hook_event_name: 'Stop' });
  assert.equal((await activity.read(threadId)).state, 'idle');
  await activity.pruneExcept([DESTINATION]);
  await writeFile(statePath, JSON.stringify({ version: 1, jobs: [], runtimeEnabled: true, director: { threadId: DESTINATION, enabled: true, threadHostOwnership: { threadId: DESTINATION, host: 'codex-desktop' } } }));
  assert.equal((await hook({ session_id: threadId, turn_id: 'late-old', hook_event_name: 'Stop' })).handled, false);
  assert.equal((await activity.read(threadId)).state, 'unknown');
  let queued = 0;
  const events = new DirectorEvents({ state: { threadId: DESTINATION, enabled: true, snapshots: {}, events: [], batches: [], acknowledged: [] }, save: async () => {}, execute: async () => ({}), cwd: root, host: { status: async () => ({ type: (await activity.read(DESTINATION)).state }), startRunner: async () => { queued++; return { queued: true, id: 'native-queue-item' }; } }, threadId: DESTINATION });
  await events.emit({ kind: 'director-attached' });
  assert.equal((await events.flush()).status, 'queued');
  assert.equal(queued, 1);
  activity.close();
});

test('PostToolUse hook registration has room for the handoff instruction', async () => {
  const hooks = JSON.parse(await readFile(new URL('../plugins/conductor/hooks/hooks.json', import.meta.url), 'utf8'));
  const lifecycle = hooks.hooks.PostToolUse.flatMap(group => group.hooks).find(hook => hook.command.includes('director-lifecycle'));
  assert.equal(lifecycle.additionalContextLimit, 2048);
});
