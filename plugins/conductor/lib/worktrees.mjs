import { spawn } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OWNERSHIP_MARKER = 'conductor-owned-worktree';

async function git(cwd, args, { input, allow = [] } = {}) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    }));
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
  if (result.code !== 0 && !allow.includes(result.code)) {
    const detail = result.stderr.toString('utf8').trim();
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ` (exit ${result.code})`}`);
  }
  return result;
}

function text(result) {
  return result.stdout.toString('utf8').trim();
}

function nulList(buffer) {
  if (buffer.length === 0) return [];
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function repoPath(root, relative) {
  const normalized = relative.replaceAll('/', path.sep);
  const absolute = path.resolve(root, normalized);
  if (!isWithin(root, absolute)) throw new Error(`Git returned a path outside the repository: ${relative}`);
  return absolute;
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function validateInclude(contents) {
  for (const [index, raw] of contents.split(/\r?\n/).entries()) {
    const rule = raw.trimEnd();
    if (!rule || rule.startsWith('#')) continue;
    if (/^[A-Za-z]:/.test(rule) || rule.startsWith('\\\\') || rule.startsWith('//')) {
      throw new Error(`.worktreeinclude line ${index + 1} must be repository-relative`);
    }
    const components = rule.replace(/^\//, '').split('/');
    if (components.some((component) => component === '..')) {
      throw new Error(`.worktreeinclude line ${index + 1} contains a parent traversal`);
    }
  }
}

async function getManagedMarker(worktreePath) {
  const gitDir = text(await git(worktreePath, ['rev-parse', '--absolute-git-dir']));
  return path.join(gitDir, OWNERSHIP_MARKER);
}

export async function inspectRepository(cwd) {
  const working = path.resolve(cwd);
  const root = text(await git(working, ['rev-parse', '--show-toplevel']));
  const common = text(await git(working, ['rev-parse', '--git-common-dir']));
  const privateGit = text(await git(working, ['rev-parse', '--git-dir']));
  const absoluteRoot = await fs.realpath(root);
  return {
    root: absoluteRoot,
    commonDir: await fs.realpath(path.resolve(working, common)),
    gitDir: await fs.realpath(path.resolve(working, privateGit)),
  };
}

export async function createWorktree({ repoRoot, path: worktreePath, branch, baseRef }) {
  if (!repoRoot || !worktreePath || !branch || !baseRef) {
    throw new Error('repoRoot, path, branch, and baseRef are required');
  }
  const root = await fs.realpath(repoRoot);
  let target = path.resolve(worktreePath);
  if (isWithin(root, target) || isWithin(target, root)) {
    throw new Error('Worktrees must be outside and separate from the source checkout');
  }
  if (await lstatOrNull(target)) throw new Error(`Worktree path already exists: ${target}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  target = path.join(await fs.realpath(path.dirname(target)), path.basename(target));
  if (isWithin(root, target) || isWithin(target, root)) {
    throw new Error('Worktrees must be outside and separate from the source checkout');
  }
  await git(root, ['worktree', 'add', '--no-guess-remote', target, '-b', branch, baseRef]);
  try {
    const marker = await getManagedMarker(target);
    await fs.writeFile(marker, `${root}\n`, { flag: 'wx' });
  } catch (error) {
    // Never force removal: if Git or another process made the new checkout dirty,
    // leave it in place for recovery instead of destroying user data.
    try { await git(root, ['worktree', 'remove', target]); } catch { /* surfaced below */ }
    throw new Error(`Could not mark the new worktree as Conductor owned: ${error.message}`);
  }
  return {
    path: target,
    branch,
    head: text(await git(target, ['rev-parse', 'HEAD'])),
  };
}

export async function copyWorktreeIncludes({ repoRoot, worktreePath }) {
  const root = await fs.realpath(repoRoot);
  const destinationRoot = await fs.realpath(worktreePath);
  if (isWithin(root, destinationRoot) || isWithin(destinationRoot, root)) {
    throw new Error('The source checkout and worktree destination must be separate');
  }
  const includePath = path.join(root, '.worktreeinclude');
  let includeContents = '';
  try {
    includeContents = await fs.readFile(includePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read .worktreeinclude: ${error.message}`);
  }
  validateInclude(includeContents);

  const candidates = nulList((await git(root, [
    'ls-files', '--others', '--ignored', '--exclude-standard', '-z',
  ])).stdout);
  if (!candidates.length) return { copied: [], skipped: [] };

  const includeMatches = new Set();
  if (includeContents.trim()) {
    const matcherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'conductor-gitignore-'));
    const matcherGitDir = path.join(matcherRoot, '.git');
    const emptyExcludes = path.join(matcherRoot, 'empty-excludes');
    try {
      await git(matcherRoot, ['init', '--bare', matcherGitDir]);
      await fs.writeFile(path.join(matcherRoot, '.gitignore'), includeContents, 'utf8');
      await fs.writeFile(emptyExcludes, '', 'utf8');
      const matched = await git(matcherRoot, [
        '-c', `core.excludesFile=${emptyExcludes}`,
        `--git-dir=${matcherGitDir}`,
        `--work-tree=${matcherRoot}`,
        'check-ignore', '-z', '--stdin',
      ], { input: Buffer.from(`${candidates.join('\0')}\0`), allow: [1] });
      for (const candidate of nulList(matched.stdout)) includeMatches.add(candidate);
    } finally {
      await fs.rm(matcherRoot, { recursive: true, force: true });
    }
  }

  const tracked = new Set(nulList((await git(destinationRoot, ['ls-files', '--full-name', '-z'])).stdout));
  const copied = [];
  const skipped = [];
  const sourceRealRoot = await fs.realpath(root);
  const destinationRealRoot = await fs.realpath(destinationRoot);

  for (const relative of candidates) {
    const autoInclude = path.posix.basename(relative) === 'AGENTS.override.md';
    if (!includeMatches.has(relative) && !autoInclude) {
      skipped.push(relative);
      continue;
    }
    const source = repoPath(root, relative);
    let cursor = root;
    let sourceSafe = true;
    for (const part of relative.split('/')) {
      cursor = path.join(cursor, part);
      const stat = await lstatOrNull(cursor);
      if (!stat || stat.isSymbolicLink() || (cursor !== source && !stat.isDirectory())) {
        sourceSafe = false;
        break;
      }
    }
    if (!sourceSafe) {
      skipped.push(relative);
      continue;
    }
    const sourceStat = await fs.lstat(source);
    if (!sourceStat.isFile()) {
      skipped.push(relative);
      continue;
    }
    const sourceReal = await fs.realpath(source);
    if (!isWithin(sourceRealRoot, sourceReal)) throw new Error(`Source path escapes repository: ${relative}`);

    const normalizedRelative = relative.replaceAll('\\', '/');
    if (tracked.has(normalizedRelative)) {
      skipped.push(relative);
      continue;
    }
    const destination = repoPath(destinationRoot, relative);
    if (!isWithin(destinationRealRoot, path.resolve(destination))) {
      throw new Error(`Destination path escapes worktree: ${relative}`);
    }

    let parent = destinationRoot;
    for (const part of path.dirname(relative).split('/').filter((item) => item && item !== '.')) {
      parent = path.join(parent, part);
      const stat = await lstatOrNull(parent);
      if (!stat) continue;
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Unsafe destination parent for included file: ${relative}`);
      }
      if (!isWithin(destinationRealRoot, await fs.realpath(parent))) {
        throw new Error(`Destination parent escapes worktree: ${relative}`);
      }
    }

    const existing = await lstatOrNull(destination);
    if (existing) {
      skipped.push(relative);
      continue;
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    let created = false;
    try {
      await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
      created = true;
      await fs.chmod(destination, sourceStat.mode & 0o777);
      copied.push(relative);
    } catch (error) {
      if (created) await fs.rm(destination, { force: true }).catch(() => {});
      throw new Error(`Could not copy included file ${relative}: ${error.message}`);
    }
  }
  return { copied, skipped };
}

export async function refreshBranch({ repoRoot, worktreePath, baseRef }) {
  const source = await inspectRepository(repoRoot);
  const worktree = await fs.realpath(worktreePath);
  const targetRepo = await inspectRepository(worktree);
  if (!samePath(source.commonDir, targetRepo.commonDir)) {
    throw new Error('Worktree belongs to a different Git repository');
  }
  const dirty = text(await git(worktree, ['status', '--porcelain', '--untracked-files=all']));
  if (dirty) throw new Error('Cannot refresh a worktree with uncommitted changes');
  const headBefore = text(await git(worktree, ['rev-parse', 'HEAD']));
  const alreadyCurrent = await git(worktree, ['merge-base', '--is-ancestor', baseRef, 'HEAD'], { allow: [1] });
  if (alreadyCurrent.code === 0) return { head: headBefore, changed: false };

  const merge = await git(worktree, ['merge', '--no-edit', baseRef], { allow: [1, 2] });
  if (merge.code === 0) {
    const head = text(await git(worktree, ['rev-parse', 'HEAD']));
    return { head, changed: head !== headBefore };
  }
  const mergeHead = await git(worktree, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], { allow: [1] });
  if (mergeHead.code !== 0) {
    const detail = merge.stderr.toString('utf8').trim();
    throw new Error(`Could not refresh worktree${detail ? `: ${detail}` : ` (exit ${merge.code})`}`);
  }
  const conflictedPaths = nulList((await git(worktree, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout);
  return {
    head: headBefore,
    changed: false,
    conflict: { paths: conflictedPaths, message: 'Merge conflicts require resolution in the original issue worktree.' },
  };
}

async function registrations(root) {
  const { stdout } = await git(root, ['worktree', 'list', '--porcelain', '-z']);
  return stdout.toString('utf8').split('\0\0')
    .map(record => record.split('\0'))
    .filter(([line]) => line.startsWith('worktree '));
}

function atWorktree(registration, worktree) {
  return samePath(registration[0].slice(9), worktree);
}

async function readRegularFile(target) {
  if (!(await lstatOrNull(target))?.isFile()) return null;
  return (await fs.readFile(target, 'utf8')).trimEnd();
}

async function findWorktreeGitDir(commonDir, worktree) {
  const linkedDir = path.join(commonDir, 'worktrees');
  if (!(await lstatOrNull(linkedDir))?.isDirectory()) return null;
  const candidates = [];
  for (const entry of await fs.readdir(linkedDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const gitDir = path.join(linkedDir, entry.name);
    const backlink = await readRegularFile(path.join(gitDir, 'gitdir'));
    if (backlink && samePath(path.resolve(gitDir, backlink), path.join(worktree, '.git'))) {
      candidates.push(gitDir);
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function retained(reason) {
  return { status: 'retained', reason };
}

export async function removeWorktree({ repoRoot, worktreePath, branch, head, preview, previousGitDir }) {
  if (!path.isAbsolute(worktreePath) || !branch || !head) {
    throw new Error('An absolute worktree path, branch, and delivered head are required');
  }
  const source = await inspectRepository(repoRoot);
  const worktree = path.resolve(worktreePath);
  if (!samePath(source.root, await fs.realpath(repoRoot))) {
    return retained('Source path does not match the Git repository root');
  }
  if (isWithin(source.root, worktree) || isWithin(worktree, source.root) ||
      isWithin(source.commonDir, worktree) || isWithin(worktree, source.commonDir)) {
    return retained('Worktree is not separate from the source checkout and its Git directory');
  }
  const stat = await lstatOrNull(worktree);
  const registered = await registrations(source.root);
  const matches = registered.filter(record => atWorktree(record, worktree));
  const expectedBranch = `branch refs/heads/${branch}`;
  if (!matches.length) {
    if (stat) return { status: 'failed', reason: 'A filesystem entry remains without an exact Git worktree registration' };
    if (previousGitDir &&
        samePath(path.dirname(previousGitDir), path.join(source.commonDir, 'worktrees')) &&
        await lstatOrNull(previousGitDir)) {
      return { status: 'failed', reason: 'Git administrative files remain after worktree removal', gitDir: previousGitDir };
    }
    if (registered.some(record => record.includes(expectedBranch))) {
      return retained('Recorded issue branch is still checked out at another registered path');
    }
    return { status: 'absent' };
  }
  if (matches.length !== 1) return retained('Git lists multiple registrations at the recorded worktree path');
  const [registeredPath, ...fields] = matches[0];
  if (fields.some(field => field === 'locked' || field.startsWith('locked '))) {
    return retained('Git worktree is locked');
  }
  if (!fields.includes(expectedBranch)) {
    return retained('Worktree branch does not match the recorded issue branch');
  }
  if (!fields.includes(`HEAD ${head}`)) return retained('Worktree HEAD does not match the delivered pull request head');

  // The backlink identifies the administrative directory even when the
  // checkout and its .git file are already gone.
  const gitDir = await findWorktreeGitDir(source.commonDir, worktree);
  if (!gitDir || !samePath(gitDir, await fs.realpath(gitDir))) {
    return retained('Git registration has no verifiable administrative directory');
  }
  const commonDir = await readRegularFile(path.join(gitDir, 'commondir'));
  if (!commonDir || !samePath(path.resolve(gitDir, commonDir), source.commonDir)) {
    return retained('Worktree belongs to a different Git repository');
  }
  const owner = await readRegularFile(path.join(gitDir, OWNERSHIP_MARKER));
  if (!owner || !path.isAbsolute(owner) || !samePath(owner, source.root)) {
    return retained('Worktree has no matching Conductor ownership marker');
  }

  if (stat) {
    if (!stat.isDirectory() || !samePath(worktree, await fs.realpath(worktree)) ||
        !(await lstatOrNull(path.join(worktree, '.git')))?.isFile()) {
      return retained('Recorded worktree path is not a real linked checkout');
    }
    const target = await inspectRepository(worktree);
    if (!samePath(target.root, worktree) || !samePath(target.commonDir, source.commonDir) ||
        !samePath(target.gitDir, gitDir)) {
      return retained('Checkout does not match its Git registration');
    }
    // These index flags can hide local modifications from Git status.
    const indexed = nulList((await git(worktree, ['ls-files', '-v', '-z'])).stdout);
    if (indexed.some(entry => /^[a-zS] /.test(entry))) {
      return retained('Git index flags can hide changes to tracked files');
    }
    const dirty = text(await git(worktree, [
      '--no-optional-locks', '-c', 'core.fsmonitor=false', 'status',
      '--porcelain', '--untracked-files=all', '--ignore-submodules=none',
    ]));
    if (dirty) return retained('Worktree has uncommitted or untracked files');
  }
  if (preview) return { status: 'candidate' };

  const current = (await registrations(source.root)).filter(record => atWorktree(record, worktree));
  if (current.length !== 1 || current[0].join('\0') !== matches[0].join('\0') ||
      owner !== await readRegularFile(path.join(gitDir, OWNERSHIP_MARKER))) {
    return retained('Worktree registration or ownership changed during cleanup');
  }
  try {
    await git(source.root, ['worktree', 'remove', '--', registeredPath.slice(9)]);
    if (await lstatOrNull(worktree) || await lstatOrNull(gitDir) ||
        (await registrations(source.root)).some(record => atWorktree(record, worktree))) {
      throw new Error('Worktree path or Git registration remains after removal');
    }
    return { status: 'removed' };
  } catch (error) {
    // Git can remove the registration even when it cannot remove the directory.
    // Keep the known administrative path for checking a partial removal on retry.
    return { status: 'failed', reason: error.message, gitDir };
  }
}
