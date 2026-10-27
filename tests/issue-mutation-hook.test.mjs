import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { eligibleRepository, handleIssueMutation, recognizedIssueMutation, signalRepository } from '../plugins/conductor/lib/issue-mutation-hook.mjs';

const config = { version: 2, repository: 'OnePersonLabs/example', baseBranch: 'main', authorized: true, checks: [{ command: 'npm', args: ['test'] }] };

async function fixture({ enabled = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'conductor-hook-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await writeFile(join(root, 'README.md'), 'hook fixture\n'); git('add', 'README.md'); git('commit', '-qm', 'fixture');
  await writeFile(join(root, 'conductor.json'), JSON.stringify(config));
  const common = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const stateDir = join(root, common, 'conductor');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'state.json'), JSON.stringify({ version: 1, jobs: [], runtimeEnabled: enabled, director: { threadId: enabled ? 'thread' : null, enabled } }));
  return { root, clean: () => rm(root, { recursive: true, force: true }) };
}

test('recognizes only known GitHub issue mutations and direct gh issue commands', () => {
  assert.equal(recognizedIssueMutation({ tool_name: 'mcp__codex_apps__github_create_issue', tool_input: {} }), true);
  assert.equal(recognizedIssueMutation({ tool_name: 'mcp__codex_apps__github_fetch_issue', tool_input: {} }), false);
  assert.equal(recognizedIssueMutation({ tool_name: 'Bash', tool_input: { command: 'gh issue edit 42 --add-label ready' } }), true);
  assert.equal(recognizedIssueMutation({ tool_name: 'exec_command', tool_input: { cmd: 'gh issue reopen 42' } }), true);
  assert.equal(recognizedIssueMutation({ tool_name: 'Bash', tool_input: { command: 'gh issue list' } }), false);
  assert.equal(recognizedIssueMutation({ tool_name: 'Bash', tool_input: { command: 'some-script-that-runs-gh issue edit 42' } }), false);
  assert.equal(recognizedIssueMutation({ tool_name: 'Bash', tool_input: { command: 'gh pr edit 4' } }), false);
});

test('signals only when cwd is a configured enabled repo and target matches', async t => {
  const f = await fixture(); t.after(f.clean);
  const base = { hook_event_name: 'PostToolUse', cwd: f.root, tool_name: 'mcp__codex_apps__github_update_issue', tool_input: { repository_full_name: 'OnePersonLabs/example' } };
  assert.equal((await eligibleRepository(base))?.repository, 'OnePersonLabs/example');
  assert.equal(await eligibleRepository({ ...base, tool_input: { repo_full_name: 'other/repo' } }), null);
  assert.equal(await eligibleRepository({ ...base, tool_input: {} }), null);
  assert.equal(await eligibleRepository({ ...base, tool_name: 'mcp__codex_apps__github_fetch_issue' }), null);
  assert.equal(await eligibleRepository({ ...base, cwd: tmpdir() }), null);
  assert.equal(await eligibleRepository({ ...base, cwd: null }), null);
  assert.equal(await eligibleRepository({ ...base, tool_name: 'mcp__codex_apps__github_add_comment_to_issue', tool_input: { repository_full_name: 'OnePersonLabs/example', comment: '<!-- conductor:internal --> event receipt' } }), null);
});

test('disabled and unconfigured repositories do not launch or signal', async t => {
  const f = await fixture({ enabled: false }); t.after(f.clean);
  let calls = 0;
  const payload = { cwd: f.root, tool_name: 'mcp__codex_apps__github_create_issue', tool_input: { repo_full_name: 'OnePersonLabs/example' } };
  const result = await handleIssueMutation(payload, { spawnProcess: () => { calls++; } });
  assert.equal(result.signaled, false);
  assert.equal(calls, 0);
  assert.equal(await eligibleRepository({ ...payload, cwd: tmpdir() }), null);
});

test('launches a passive signal in the observed working directory', () => {
  let command, args, options;
  const fake = Object.assign(new EventEmitter(), { unrefCalled: false, unref() { this.unrefCalled = true; } });
  const launched = signalRepository({ repository: 'OnePersonLabs/example' }, { cwd: 'C:/repo', spawnProcess: (...values) => { [command, args, options] = values; return fake; } });
  assert.equal(launched, true);
  assert.match(command, /node(?:\.exe)?$/i);
  assert.equal(args[1], 'signal');
  assert.equal(options.cwd, 'C:/repo');
  assert.equal(options.detached, true);
  assert.equal(options.shell, false);
  assert.equal(fake.unrefCalled, true);
});
