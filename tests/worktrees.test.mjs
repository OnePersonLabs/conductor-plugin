import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupWorktrees } from '../plugins/conductor/lib/cleanup.mjs';
import {
  copyWorktreeIncludes,
  createWorktree,
  inspectRepository,
  refreshBranch,
  removeWorktree,
} from '../plugins/conductor/lib/worktrees.mjs';

async function run(command, args, cwd, options = {}) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8').trim(),
      stderr: Buffer.concat(stderr).toString('utf8').trim(),
    }));
    child.stdin.end(options.input);
  });
  if (result.code !== 0) throw new Error(`${command} ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}

async function git(root, ...args) {
  return run('git', args, root);
}

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'conductor-worktrees-test-'));
  const root = path.join(temp, 'source repo');
  await fs.mkdir(root);
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'Test');
  await git(root, 'config', 'user.email', 'test@example.invalid');
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored/\ncache/\nsecrets/\n');
  await fs.writeFile(path.join(root, 'tracked.txt'), 'base\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'initial');
  const worktreePath = path.join(temp, 'work trees', 'issue α');
  t.after(async () => fs.rm(temp, { recursive: true, force: true }));
  return { temp, root, worktreePath };
}

async function write(root, relative, contents) {
  const target = path.join(root, ...relative.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}

test('inspectRepository resolves checkout, common Git directory, and private directory', async (t) => {
  const { root } = await fixture(t);
  const result = await inspectRepository(root);
  assert.equal(result.root, await fs.realpath(root));
  assert.equal(await fs.stat(result.commonDir).then((stat) => stat.isDirectory()), true);
  assert.equal(await fs.stat(result.gitDir).then((stat) => stat.isDirectory()), true);
});

test('copies only ignored files selected by Git-compatible ordered include rules', async (t) => {
  const { root, worktreePath } = await fixture(t);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await git(root, 'worktree', 'add', worktreePath, '-b', 'issue/include', 'main');
  await fs.writeFile(path.join(root, '.worktreeinclude'), [
    '# local test files',
    'ignored/',
    '!ignored/',
    'ignored/*',
    '!ignored/private/',
    '!ignored/private/**',
    'cache/*.txt',
    '/secrets/allow.txt',
  ].join('\n'));
  await write(root, 'ignored/settings.json', '{"local":true}\n');
  await write(root, 'ignored/private/token.txt', 'excluded by final negation\n');
  await write(root, 'cache/config.txt', 'included\n');
  await write(root, 'cache/notes.md', 'not included\n');
  await write(root, 'secrets/allow.txt', 'root anchored\n');
  await write(root, 'secrets/no.txt', 'not included\n');
  await write(root, 'ordinary-untracked.txt', 'not ignored\n');
  const result = await copyWorktreeIncludes({ repoRoot: root, worktreePath });
  assert.deepEqual(result.copied.sort(), ['cache/config.txt', 'ignored/settings.json', 'secrets/allow.txt']);
  assert.deepEqual(result.skipped.sort(), ['cache/notes.md', 'ignored/private/token.txt', 'secrets/no.txt']);
  assert.equal(await fs.readFile(path.join(worktreePath, 'ignored/settings.json'), 'utf8'), '{"local":true}\n');
  await assert.rejects(fs.stat(path.join(worktreePath, 'ordinary-untracked.txt')), { code: 'ENOENT' });
});

test('automatically copies ignored AGENTS.override.md, while leaving existing destinations alone', async (t) => {
  const { root, worktreePath } = await fixture(t);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await git(root, 'worktree', 'add', worktreePath, '-b', 'issue/override', 'main');
  await write(root, 'ignored/AGENTS.override.md', 'local instructions\n');
  await write(root, 'ignored/another.txt', 'ignored\n');
  const first = await copyWorktreeIncludes({ repoRoot: root, worktreePath });
  assert.deepEqual(first.copied, ['ignored/AGENTS.override.md']);
  await fs.writeFile(path.join(worktreePath, 'ignored/AGENTS.override.md'), 'worktree value\n');
  const second = await copyWorktreeIncludes({ repoRoot: root, worktreePath });
  assert.deepEqual(second.copied, []);
  assert.equal(await fs.readFile(path.join(worktreePath, 'ignored/AGENTS.override.md'), 'utf8'), 'worktree value\n');
  assert.deepEqual(second.skipped, ['ignored/AGENTS.override.md', 'ignored/another.txt']);
});

test('does not replace a tracked destination with an ignored source file at the same path', async (t) => {
  const { root, worktreePath } = await fixture(t);
  await write(root, 'cache/preserved.txt', 'tracked version\n');
  await git(root, 'add', '-f', 'cache/preserved.txt');
  await git(root, 'commit', '-m', 'track the worktree destination');
  const trackedBase = await git(root, 'rev-parse', 'HEAD');
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await git(root, 'worktree', 'add', worktreePath, '-b', 'issue/tracked-destination', trackedBase);
  await git(root, 'rm', 'cache/preserved.txt');
  await write(root, 'cache/preserved.txt', 'source local value\n');
  await git(root, 'add', '.gitignore');
  await git(root, 'commit', '-m', 'remove tracked destination from base');
  await fs.writeFile(path.join(root, '.worktreeinclude'), 'cache/\n');
  const result = await copyWorktreeIncludes({ repoRoot: root, worktreePath });
  assert.deepEqual(result.copied, []);
  assert.deepEqual(result.skipped, ['cache/preserved.txt']);
  assert.equal(await fs.readFile(path.join(worktreePath, 'cache/preserved.txt'), 'utf8'), 'tracked version\n');
});

test('missing include is valid and copies no ordinary ignored files', async (t) => {
  const { root, worktreePath } = await fixture(t);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await git(root, 'worktree', 'add', worktreePath, '-b', 'issue/noinclude', 'main');
  await write(root, 'ignored/value.txt', 'ignored\n');
  assert.deepEqual(await copyWorktreeIncludes({ repoRoot: root, worktreePath }), {
    copied: [], skipped: ['ignored/value.txt'],
  });
});

test('rejects traversal, drive, and UNC patterns before copying', async (t) => {
  const { root, worktreePath } = await fixture(t);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await git(root, 'worktree', 'add', worktreePath, '-b', 'issue/unsafe', 'main');
  for (const rule of ['../outside', 'cache/../../secret', 'C:/private', '//server/share', '\\\\server\\share']) {
    await fs.writeFile(path.join(root, '.worktreeinclude'), rule);
    await assert.rejects(copyWorktreeIncludes({ repoRoot: root, worktreePath }), /repository-relative|parent traversal/);
  }
});

test('does not follow source symlink directories or copy symlink files', async (t) => {
  const { root, worktreePath, temp } = await fixture(t);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await git(root, 'worktree', 'add', worktreePath, '-b', 'issue/symlink', 'main');
  await fs.writeFile(path.join(root, '.worktreeinclude'), 'ignored/\n');
  await write(root, 'outside/secret.txt', 'outside\n');
  await fs.mkdir(path.join(root, 'ignored'), { recursive: true });
  try {
    await fs.symlink(path.join(temp, 'outside'), path.join(root, 'ignored/outside-link'), 'junction');
    await fs.symlink(path.join(temp, 'outside/secret.txt'), path.join(root, 'ignored/secret-link.txt'), 'file');
  } catch (error) {
    t.skip(`Windows does not allow creating a symlink here: ${error.code}`);
    return;
  }
  const result = await copyWorktreeIncludes({ repoRoot: root, worktreePath });
  assert.deepEqual(result.copied, []);
  assert.equal(result.copied.includes('ignored/outside-link'), false);
  assert.equal(result.copied.includes('ignored/secret-link.txt'), false);
  await assert.rejects(fs.stat(path.join(worktreePath, 'ignored/outside-link')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(worktreePath, 'ignored/secret-link.txt')), { code: 'ENOENT' });
});

test('reports destination path conflicts instead of silently skipping or starting work', async (t) => {
  const { root, worktreePath } = await fixture(t);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await git(root, 'worktree', 'add', worktreePath, '-b', 'issue/copy-failure', 'main');
  await fs.writeFile(path.join(root, '.worktreeinclude'), 'cache/\n');
  await write(root, 'cache/child.txt', 'copy this\n');
  await fs.writeFile(path.join(worktreePath, 'cache'), 'parent is a file');
  await assert.rejects(copyWorktreeIncludes({ repoRoot: root, worktreePath }), /Unsafe destination parent/);
});

test('rejects destination junctions that resolve outside the worktree', async (t) => {
  const { root, worktreePath, temp } = await fixture(t);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await git(root, 'worktree', 'add', worktreePath, '-b', 'issue/destination-junction', 'main');
  await fs.writeFile(path.join(root, '.worktreeinclude'), 'cache/\n');
  await write(root, 'cache/child.txt', 'copy this\n');
  await fs.mkdir(path.join(temp, 'outside-destination'));
  try {
    await fs.symlink(path.join(temp, 'outside-destination'), path.join(worktreePath, 'cache'), 'junction');
  } catch (error) {
    t.skip(`Windows does not allow creating a directory junction here: ${error.code}`);
    return;
  }
  await assert.rejects(
    copyWorktreeIncludes({ repoRoot: root, worktreePath }),
    /Unsafe destination parent|Destination parent escapes worktree/,
  );
  await assert.rejects(fs.stat(path.join(temp, 'outside-destination', 'child.txt')), { code: 'ENOENT' });
});

test('worktree uses its own branch, refresh merges accepted base, and clean owned worktrees can be removed', async (t) => {
  const { root, worktreePath } = await fixture(t);
  const created = await createWorktree({ repoRoot: root, path: worktreePath, branch: 'issue/101', baseRef: 'main' });
  assert.equal(created.branch, 'issue/101');
  assert.equal(created.head, await git(worktreePath, 'rev-parse', 'HEAD'));
  await fs.writeFile(path.join(root, 'base-update.txt'), 'new base\n');
  await git(root, 'add', 'base-update.txt');
  await git(root, 'commit', '-m', 'advance base');
  const refresh = await refreshBranch({ repoRoot: root, worktreePath, baseRef: 'main' });
  assert.equal(refresh.changed, true);
  assert.equal(await fs.readFile(path.join(worktreePath, 'base-update.txt'), 'utf8'), 'new base\n');
  await write(worktreePath, 'ignored/dependencies/library.txt', 'prepared dependencies\n');
  const options = { repoRoot: root, worktreePath, branch: created.branch, head: refresh.head };
  assert.deepEqual(await removeWorktree({ ...options, preview: true }), { status: 'candidate' });
  assert.equal(await fs.readFile(path.join(worktreePath, 'ignored/dependencies/library.txt'), 'utf8'), 'prepared dependencies\n');
  assert.deepEqual(await removeWorktree(options), { status: 'removed' });
  await assert.rejects(fs.stat(worktreePath), { code: 'ENOENT' });
  assert.equal(await git(root, 'rev-parse', 'refs/heads/issue/101'), refresh.head);
  assert.deepEqual(await removeWorktree(options), { status: 'absent' });
});

test('refresh leaves merge conflicts for the original issue builder', async (t) => {
  const { root, worktreePath } = await fixture(t);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await git(root, 'worktree', 'add', worktreePath, '-b', 'issue/conflict', 'main');
  await fs.writeFile(path.join(worktreePath, 'tracked.txt'), 'issue version\n');
  await git(worktreePath, 'add', 'tracked.txt');
  await git(worktreePath, 'commit', '-m', 'issue edit');
  await fs.writeFile(path.join(root, 'tracked.txt'), 'base version\n');
  await git(root, 'add', 'tracked.txt');
  await git(root, 'commit', '-m', 'base edit');
  const refresh = await refreshBranch({ repoRoot: root, worktreePath, baseRef: 'main' });
  assert.equal(refresh.changed, false);
  assert.deepEqual(refresh.conflict.paths, ['tracked.txt']);
  assert.equal((await git(worktreePath, 'status', '--porcelain')).includes('UU tracked.txt'), true);
});

test('refuses removal of dirty or unowned worktrees', async (t) => {
  const { root, worktreePath } = await fixture(t);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await git(root, 'worktree', 'add', worktreePath, '-b', 'issue/dirty', 'main');
  const head = await git(root, 'rev-parse', 'HEAD');
  const unowned = { repoRoot: root, worktreePath, branch: 'issue/dirty', head };
  assert.match((await removeWorktree(unowned)).reason, /ownership marker/);
  const ownedPath = path.join(path.dirname(worktreePath), 'owned');
  const owned = await createWorktree({ repoRoot: root, path: ownedPath, branch: 'issue/dirty-owned', baseRef: 'main' });
  const options = { repoRoot: root, worktreePath: ownedPath, branch: owned.branch, head };
  await fs.writeFile(path.join(ownedPath, 'local.txt'), 'preserve me\n');
  await git(ownedPath, 'config', 'status.showUntrackedFiles', 'no');
  assert.match((await removeWorktree(options)).reason, /uncommitted or untracked/);
  await fs.unlink(path.join(ownedPath, 'local.txt'));
  await git(ownedPath, 'update-index', '--assume-unchanged', 'tracked.txt');
  await fs.writeFile(path.join(ownedPath, 'tracked.txt'), 'hidden change\n');
  assert.match((await removeWorktree(options)).reason, /index flags/);
  assert.equal(await fs.readFile(path.join(ownedPath, 'tracked.txt'), 'utf8'), 'hidden change\n');
});

test('removes only the proven missing worktree registration and preserves other stale registrations', async (t) => {
  const { root, worktreePath, temp } = await fixture(t);
  const owned = await createWorktree({ repoRoot: root, path: worktreePath, branch: 'issue/missing', baseRef: 'main' });
  const otherPath = path.join(path.dirname(worktreePath), 'other');
  await git(root, 'worktree', 'add', otherPath, '-b', 'issue/other', 'main');
  await fs.rename(worktreePath, path.join(temp, 'removed checkout'));
  await fs.rename(otherPath, path.join(temp, 'other removed checkout'));
  const options = { repoRoot: root, worktreePath, branch: owned.branch, head: owned.head };
  const other = { ...options, worktreePath: otherPath, branch: 'issue/other' };

  assert.match((await removeWorktree({ ...options, branch: 'issue/wrong' })).reason, /branch does not match/);
  assert.match((await removeWorktree({ ...options, head: '0'.repeat(owned.head.length) })).reason, /HEAD does not match/);
  assert.match((await removeWorktree(other)).reason, /ownership marker/);
  assert.deepEqual(await removeWorktree(options), { status: 'removed' });
  assert.deepEqual(await removeWorktree(options), { status: 'absent' });
  assert.match(await git(root, 'worktree', 'list', '--porcelain'), /branch refs\/heads\/issue\/other/);
});

test('keeps a checkout at the wrong delivered head and a path left without registration', async (t) => {
  const { root, worktreePath } = await fixture(t);
  const owned = await createWorktree({ repoRoot: root, path: worktreePath, branch: 'issue/advanced', baseRef: 'main' });
  const options = { repoRoot: root, worktreePath, branch: owned.branch, head: owned.head };
  await git(worktreePath, 'commit', '--allow-empty', '-m', 'local work after delivery');
  assert.match((await removeWorktree(options)).reason, /HEAD does not match/);
  assert.equal(await fs.readFile(path.join(worktreePath, 'tracked.txt'), 'utf8'), 'base\n');

  const moved = path.join(path.dirname(worktreePath), 'moved worktree');
  await git(root, 'worktree', 'move', worktreePath, moved);
  assert.match((await removeWorktree(options)).reason, /checked out at another registered path/);
  assert.equal(await fs.readFile(path.join(moved, 'tracked.txt'), 'utf8'), 'base\n');
  await git(root, 'worktree', 'remove', moved);
  await write(worktreePath, 'surviving-file.txt', 'preserve me\n');
  const result = await removeWorktree(options);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /without an exact Git worktree registration/);
  assert.equal(await fs.readFile(path.join(worktreePath, 'surviving-file.txt'), 'utf8'), 'preserve me\n');
});

test('preserves external junction targets and reports any leftover checkout', async (t) => {
  const { root, worktreePath, temp } = await fixture(t);
  const owned = await createWorktree({ repoRoot: root, path: worktreePath, branch: 'issue/junction', baseRef: 'main' });
  await write(temp, 'external/keep.txt', 'outside the checkout\n');
  await fs.mkdir(path.join(worktreePath, 'ignored'));
  await fs.symlink(path.join(temp, 'external'), path.join(worktreePath, 'ignored/dependency'), 'junction');

  const options = { repoRoot: root, worktreePath, branch: owned.branch, head: owned.head };
  const result = await removeWorktree(options);
  const leftover = await fs.stat(worktreePath).then(() => true).catch(error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  assert.equal(result.status, leftover ? 'failed' : 'removed');
  assert.equal(await fs.readFile(path.join(temp, 'external/keep.txt'), 'utf8'), 'outside the checkout\n');
  if (leftover) {
    const retry = await removeWorktree({ ...options, previousGitDir: result.gitDir });
    assert.equal(retry.status, 'failed');
  }
});

test('cleanup applies only to inactive, unheld jobs with verified delivery evidence', async (t) => {
  const { root, worktreePath } = await fixture(t);
  const owned = await createWorktree({ repoRoot: root, path: worktreePath, branch: 'issue/complete', baseRef: 'main' });
  const complete = {
    issue: 1, worktree: worktreePath, branch: owned.branch, phase: 'complete',
    acceptanceComplete: true, mergedCommit: 'merge-commit', deliveredHead: owned.head,
    builderThreadId: 'builder-thread',
  };
  const jobs = [
    complete,
    { ...complete, issue: 2, phase: 'cancelled' },
    { ...complete, issue: 3, phase: 'paused' },
    { ...complete, issue: 4, phase: 'blocked' },
    { ...complete, issue: 5, phase: 'uncertain' },
    { ...complete, issue: 6, deliveryReconciliationRequired: true },
    { ...complete, issue: 7, deliveredHead: undefined },
    { ...complete, issue: 8, childPid: process.pid },
    { ...complete, issue: 9 },
    { ...complete, issue: 10 },
  ];
  let writes = 0;
  const notices = [];
  const options = {
    repoRoot: root, jobs, busyIssues: [9], holds: [{ active: true, issues: [10] }],
    resolveParents: async () => [],
    save: async () => { writes++; }, notice: message => notices.push(message),
  };

  const preview = await cleanupWorktrees({ ...options, preview: true });
  assert.deepEqual(preview.candidates.map(item => item.issue), [1]);
  assert.deepEqual(preview.retained.map(item => item.issue), [2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(writes, 0);

  const first = await cleanupWorktrees(options);
  assert.deepEqual(first.removed.map(item => item.issue), [1]);
  assert.equal(writes, 1);
  assert.deepEqual(complete.worktreeCleanup, { status: 'removed' });
  assert.equal(complete.builderThreadId, 'builder-thread');
  assert.equal(complete.mergedCommit, 'merge-commit');

  const retry = await cleanupWorktrees(options);
  assert.deepEqual(retry.absent.map(item => item.issue), [1]);
  assert.equal(writes, 1);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /cleanup removed/);
});

test('cleanup preserves descendants of held issues and retains worktrees when ancestry is unknown', async (t) => {
  const { root, worktreePath } = await fixture(t);
  const owned = await createWorktree({ repoRoot: root, path: worktreePath, branch: 'issue/descendant', baseRef: 'main' });
  const job = {
    issue: 3, worktree: worktreePath, branch: owned.branch, phase: 'complete',
    acceptanceComplete: true, mergedCommit: 'merge-commit', deliveredHead: owned.head,
  };
  const notices = [];
  const options = {
    repoRoot: root, jobs: [job], holds: [{ active: true, issues: [1] }],
    save: async () => {}, notice: message => notices.push(message),
  };
  const direct = await cleanupWorktrees({ ...options, preview: true, holds: [{ active: true, issues: [3] }] });
  assert.match(direct.retained[0].reason, /Job is held/);
  const all = await cleanupWorktrees({ ...options, preview: true, holds: [{ active: true, all: true }] });
  assert.match(all.retained[0].reason, /Job is held/);

  const inherited = await cleanupWorktrees({
    ...options,
    resolveParents: async issue => {
      assert.equal(issue, 3);
      return [{ number: 2 }, { number: 1 }];
    },
  });
  assert.match(inherited.retained[0].reason, /Job is held/);
  const noResolver = await cleanupWorktrees({ ...options, preview: true });
  assert.match(noResolver.retained[0].reason, /without repository configuration/);
  const unavailable = { ...options, resolveParents: async () => { throw new Error('GitHub unavailable'); } };
  for (let retry = 0; retry < 2; retry++) {
    const result = await cleanupWorktrees(unavailable);
    assert.match(result.retained[0].reason, /Could not verify parent holds: GitHub unavailable/);
  }
  assert.equal(notices.length, 1);
  assert.equal(job.phase, 'complete');
  assert.equal(await fs.readFile(path.join(worktreePath, 'tracked.txt'), 'utf8'), 'base\n');
  const allowed = await cleanupWorktrees({ ...options, resolveParents: async () => [{ number: 2 }] });
  assert.equal(allowed.removed.length, 1);
});

test('cleanup keeps delivery complete and reports a retained worktree only when its reason changes', async (t) => {
  const { root, worktreePath } = await fixture(t);
  const owned = await createWorktree({ repoRoot: root, path: worktreePath, branch: 'issue/retained', baseRef: 'main' });
  const job = {
    issue: 1, worktree: worktreePath, branch: owned.branch, phase: 'complete',
    acceptanceComplete: true, mergedCommit: 'merge-commit', deliveredHead: owned.head,
  };
  await write(worktreePath, 'local.txt', 'preserve me\n');
  const notices = [];
  let writes = 0;
  const options = { repoRoot: root, jobs: [job], save: async () => { writes++; }, notice: message => notices.push(message) };
  for (let retry = 0; retry < 2; retry++) {
    const outcome = await cleanupWorktrees(options);
    assert.equal(outcome.retained.length, 1);
    assert.equal(job.phase, 'complete');
    assert.equal(job.worktreeCleanup.status, 'retained');
  }
  assert.equal(writes, 1);
  assert.equal(notices.length, 1);
  assert.equal(await fs.readFile(path.join(worktreePath, 'local.txt'), 'utf8'), 'preserve me\n');
  await fs.unlink(path.join(worktreePath, 'local.txt'));
  assert.equal((await cleanupWorktrees(options)).removed.length, 1);
  assert.deepEqual(job.worktreeCleanup, { status: 'removed' });
});
