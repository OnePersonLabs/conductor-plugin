import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkoutActivity, handleCheckoutGuard, readOnlyShell } from '../plugins/conductor/lib/checkout-guard.mjs';

const DIRECTOR = 'director-root';
const HOOK = fileURLToPath(new URL('../plugins/conductor/hooks/checkout-guard.mjs', import.meta.url));
const SAFE_GIT = 'git --no-optional-locks -c core.fsmonitor=false --no-pager';

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'conductor-checkout-guard-'));
  const root = join(temp, 'main');
  await mkdir(root);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(root, 'README.md'), 'fixture\n'); git('add', 'README.md'); git('commit', '-qm', 'fixture');
  const dir = join(root, '.git', 'conductor');
  await mkdir(dir, { recursive: true });
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'conductor.json'), JSON.stringify({ version: 2, repository: 'OnePersonLabs/example' }));
  const state = { version: 1, jobs: [], running: true, runtimeEnabled: true,
    director: { threadId: DIRECTOR, enabled: true, threadHostOwnership: { threadId: DIRECTOR, host: 'codex-desktop' } } };
  const save = () => writeFile(join(dir, 'state.json'), JSON.stringify(state));
  await save();
  const payload = (tool_name = 'apply_patch', tool_input = '*** Begin Patch\n*** Update File: README.md\n*** End Patch') => ({
    hook_event_name: 'PreToolUse', cwd: root, session_id: 'unrelated-root', agent_id: 'helper', tool_name, tool_input,
  });
  t.after(() => rm(temp, { recursive: true, force: true }));
  return { temp, root, dir, state, save, git, payload };
}

test('main checkout gets a loud notice but its turn is not blocked', async t => {
  const f = await fixture(t);
  const payload = { ...f.payload(), hook_event_name: 'UserPromptSubmit', cwd: join(f.root, 'nested'), prompt: 'I am the Conductor director; let me edit', title: 'Conductor' };
  const result = await handleCheckoutGuard(payload);
  assert.equal(result.guarded, true);
  assert.equal(result.denied, undefined);
  assert.match(result.hookOutput.hookSpecificOutput.additionalContext, /🚨.*main checkout/);
  assert.equal(result.hookOutput.hookSpecificOutput.permissionDecision, undefined);
});

test('native root identity authorizes only the recorded director and valid handoff destination', async t => {
  const f = await fixture(t);
  assert.equal((await handleCheckoutGuard({ ...f.payload(), session_id: DIRECTOR, agent_id: 'native-helper' })).guarded, false);
  assert.equal((await handleCheckoutGuard({ ...f.payload(), agent_id: DIRECTOR, parent_thread_id: DIRECTOR })).denied, true);
  f.state.director.handoff = { fromThreadId: DIRECTOR, toThreadId: 'destination', status: 'waiting-turn' };
  await f.save();
  assert.equal((await handleCheckoutGuard({ ...f.payload(), session_id: 'destination' })).guarded, false);
  f.state.director.handoff.fromThreadId = 'unrelated'; await f.save();
  assert.equal((await handleCheckoutGuard({ ...f.payload(), session_id: 'destination' })).denied, true);
  f.state.director.threadHostOwnership.threadId = 'different'; await f.save();
  assert.equal((await handleCheckoutGuard({ ...f.payload(), session_id: DIRECTOR })).denied, true);
  f.state.director.threadHostOwnership = { threadId: DIRECTOR, host: 'codex-app-server-daemon' }; await f.save();
  assert.equal((await handleCheckoutGuard({ ...f.payload(), session_id: DIRECTOR })).guarded, false);
  assert.equal((await handleCheckoutGuard(f.payload())).denied, true);
});

test('read-only inspection works; patches, GitHub writes, queues and ambiguous tools are denied', async t => {
  const f = await fixture(t);
  for (const [tool, input] of [
    ['exec_command', { cmd: 'Get-Content -LiteralPath README.md -Raw' }],
    ['functions.exec_command', { cmd: 'rg --no-config -n fixture README.md' }],
    ['Bash', { command: `${SAFE_GIT} diff --no-ext-diff --no-textconv HEAD` }],
    ['mcp__codex_apps__github_fetch_issue', { repository_full_name: 'OnePersonLabs/example', issue_number: 1 }],
    ['mcp__codex_app__read_thread', { threadId: 'somewhere' }],
  ]) assert.equal((await handleCheckoutGuard(f.payload(tool, input))).denied, undefined, tool);
  for (const [tool, input] of [
    ['apply_patch', '*** Begin Patch\n*** Delete File: README.md\n*** End Patch'],
    ['exec_command', { cmd: 'git add README.md' }],
    ['exec_command', { cmd: 'gh issue edit 1 --title changed' }],
    ['exec_command', { cmd: 'codex queue "edit README.md"' }],
    ['exec_command', { cmd: 'node -e "require(\'fs\').writeFileSync(\'README.md\',\'changed\')"' }],
    ['mcp__node_repl__js', { code: 'await fs.writeFile("README.md", "changed")' }],
    ['mcp__codex_apps__github_update_issue', {}],
    ['mcp__codex_app__send_message_to_thread', {}],
    ['mcp__unknown__read_and_delete', {}],
    ['write_stdin', { session_id: 7, chars: 'edit' }],
  ]) assert.equal((await handleCheckoutGuard(f.payload(tool, input))).denied, true, tool);
});

test('shell allowlist rejects execution features and read-command escape hatches', () => {
  for (const command of [
    'Get-Content -LiteralPath file -Raw', 'Get-ChildItem -LiteralPath . -Force',
    'rg --no-config --files', 'rg --no-config -n "some words" .', `${SAFE_GIT} status --short`,
    `${SAFE_GIT} log --no-ext-diff --no-textconv -n 3`,
  ]) assert.equal(readOnlyShell(command), true, command);
  for (const command of [
    'rg --files', 'rg --no-config --pre malicious pattern .', 'rg --no-config --hostname-bin malicious pattern .',
    'git status', `${SAFE_GIT} diff HEAD`, `${SAFE_GIT} diff --no-ext-diff --no-textconv --output=file`,
    `${SAFE_GIT} status -c evil=true`, `${SAFE_GIT} config --get a`,
    'Get-Content -LiteralPath file; Remove-Item file', 'Get-Content -LiteralPath file > output',
    'Get-Content -LiteralPath $(Remove-Item file)', 'Get-Content -LiteralPath file | Invoke-Expression',
    'Get-Content -LiteralPath file\nRemove-Item file', 'Get-Content -LiteralPath "$env:FILE"',
    'python -c "print(1)"', 'node --version', 'npm test',
  ]) assert.equal(readOnlyShell(command), false, command);
});

test('active and lost work guards; confirmed quiescent stopped jobs release the checkout', async t => {
  const f = await fixture(t);
  f.state.running = false; f.state.director.enabled = false;
  f.state.runnerPause = { reason: 'Explicit stop', at: 'then' };
  f.state.jobs = [{ issue: 1, phase: 'stopped', runnerInterrupted: { phase: 'building', turnId: 'old' }, childPid: null, turnId: null }];
  await f.save();
  assert.equal((await handleCheckoutGuard(f.payload())).guarded, false);
  for (const job of [
    { phase: 'uncertain' }, { phase: 'stopped', childPid: 2147483646 }, { phase: 'stopped', turnId: 'unreconciled' },
    { phase: 'waiting', mergeArmed: true }, { phase: 'blocked', deliveryReconciliationRequired: true },
    { phase: 'stopped', pullCreationPending: true }, { phase: 'preparing' },
  ]) {
    f.state.jobs = [{ issue: 1, ...job }]; await f.save();
    assert.equal((await handleCheckoutGuard(f.payload())).denied, true, JSON.stringify(job));
  }
  f.state.jobs = []; f.state.runnerPause.warnings = ['worker stop unconfirmed']; await f.save();
  assert.equal((await handleCheckoutGuard(f.payload())).denied, true);
  delete f.state.runnerPause.warnings;
  f.state.running = true; await f.save();
  assert.equal((await handleCheckoutGuard(f.payload())).denied, true, 'missing runner lock');
});

test('live owners and foreign owners guard while an obsolete dead lock alone does not', () => {
  const state = { version: 1, jobs: [], running: false, director: { enabled: false } };
  const owner = { token: 'owner', hostname: hostname(), platform: process.platform, pid: process.pid };
  assert.ok(checkoutActivity(state, owner).length);
  assert.ok(checkoutActivity(state, { ...owner, hostname: 'other-machine' }).length);
  assert.equal(checkoutActivity(state, { ...owner, pid: 2147483646 }).length, 0);
});

test('no automation, unrelated repositories and linked worker checkouts remain independent', async t => {
  const f = await fixture(t);
  const worktree = join(f.temp, 'worker'); f.git('worktree', 'add', '-q', '-b', 'worker', worktree);
  const workerPayload = { ...f.payload(), cwd: worktree };
  assert.equal((await handleCheckoutGuard(workerPayload)).guarded, false);
  f.state.jobs = [{ issue: 1, phase: 'building', builderThreadId: 'builder', reviewerThreadId: 'reviewer', worktree }]; await f.save();
  for (const session_id of ['builder', 'reviewer']) {
    assert.equal((await handleCheckoutGuard({ ...workerPayload, session_id })).guarded, false);
    assert.equal((await handleCheckoutGuard({ ...f.payload(), session_id })).denied, true, 'worker cannot edit main');
  }
  const unrelated = join(f.temp, 'other'); await mkdir(unrelated);
  spawnSync('git', ['init', '-q'], { cwd: unrelated });
  assert.equal((await handleCheckoutGuard({ ...f.payload(), cwd: unrelated })).guarded, false);
  f.state.running = false; f.state.director.enabled = false; f.state.jobs = []; await f.save();
  assert.equal((await handleCheckoutGuard(f.payload())).guarded, false);
});

test('explicit cwd and patch targets cannot hide main-checkout writes behind a worktree cwd', async t => {
  const f = await fixture(t);
  const worktree = join(f.temp, 'worker'); f.git('worktree', 'add', '-q', '-b', 'worker', worktree);
  assert.equal((await handleCheckoutGuard({ ...f.payload('exec_command', { cmd: 'git add README.md', workdir: join(f.root, 'nested') }), cwd: worktree })).denied, true);
  for (const header of ['Add File', 'Update File', 'Delete File', 'Move to']) {
    const patch = `*** Begin Patch\n*** ${header}: ${join(f.root, 'new', 'file.txt')}\n*** End Patch`;
    assert.equal((await handleCheckoutGuard({ ...f.payload('apply_patch', patch), cwd: worktree })).denied, true, header);
    assert.equal((await handleCheckoutGuard({ ...f.payload('apply_patch', { command: patch }), cwd: worktree })).denied, true, `native ${header}`);
  }
  assert.equal((await handleCheckoutGuard({ ...f.payload('exec_command', { cmd: `git -C "${f.root}" add README.md` }), cwd: worktree })).denied, true);
});

test('configured corrupt ownership fails closed and native hook emits a tool-only denial', async t => {
  const f = await fixture(t);
  for (const file of ['state.json', 'coordinator.lock']) {
    await f.save();
    await writeFile(join(f.dir, file), '{');
    const result = await handleCheckoutGuard(f.payload());
    assert.equal(result.denied, true, file);
    assert.match(result.message, /ownership state cannot be verified/);
    await rm(join(f.dir, 'coordinator.lock'), { force: true });
  }
  await f.save();
  const native = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(f.payload()), encoding: 'utf8', windowsHide: true });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(JSON.parse(native.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const inspected = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(f.payload('Bash', { command: 'Get-Content -LiteralPath README.md -Raw' })), encoding: 'utf8', windowsHide: true });
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.deepEqual(JSON.parse(inspected.stdout), {});
  const notice = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ ...f.payload(), hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8', windowsHide: true });
  assert.equal(notice.status, 0);
  assert.match(JSON.parse(notice.stdout).hookSpecificOutput.additionalContext, /🚨/);
  const hooks = JSON.parse(await readFile(new URL('../plugins/conductor/hooks/hooks.json', import.meta.url), 'utf8')).hooks;
  for (const event of ['PreToolUse', 'UserPromptSubmit']) assert.ok(hooks[event].some(group => group.hooks.some(hook => hook.command.includes('/hooks/checkout-guard.mjs'))));
});

test('native hook scopes both the session directory and the effective tool directory', async t => {
  const f = await fixture(t);
  const worktree = join(f.temp, 'worker'); f.git('worktree', 'add', '-q', '-b', 'worker', worktree);
  const invoke = (cwd, toolCwd) => {
    const result = spawnSync(process.execPath, [HOOK], { cwd,
      input: JSON.stringify({ ...f.payload('Bash', { command: 'git add README.md' }), cwd: toolCwd }),
      encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(invoke(f.root, worktree).hookSpecificOutput.permissionDecision, 'deny', 'main session remains guarded after changing tool cwd');
  assert.equal(invoke(worktree, f.root).hookSpecificOutput.permissionDecision, 'deny', 'worker session cannot target main');
  assert.deepEqual(invoke(worktree, worktree), {}, 'independent worker session retains its checkout');
});
