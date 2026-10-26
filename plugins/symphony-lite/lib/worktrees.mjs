import { spawn } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OWNERSHIP_MARKER = 'symphony-lite-owned-worktree';

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
    throw new Error(`Could not mark the new worktree as Symphony Lite owned: ${error.message}`);
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
    const matcherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-lite-gitignore-'));
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

export async function removeWorktree({ repoRoot, worktreePath }) {
  const root = await fs.realpath(repoRoot);
  const worktree = path.resolve(worktreePath);
  if (samePath(root, worktree)) {
    throw new Error('Refusing to remove the source checkout');
  }
  const actualRoot = text(await git(worktree, ['rev-parse', '--show-toplevel']));
  if (!samePath(actualRoot, worktree)) {
    throw new Error('Requested path is not the root of a Git worktree');
  }
  const marker = await getManagedMarker(worktree);
  let owner;
  try { owner = (await fs.readFile(marker, 'utf8')).trim(); } catch {
    throw new Error('Refusing to remove a worktree without Symphony Lite ownership metadata');
  }
  if (!samePath(owner, root)) {
    throw new Error('Worktree ownership metadata does not match this repository');
  }
  const dirty = text(await git(worktree, ['status', '--porcelain', '--untracked-files=all']));
  if (dirty) throw new Error('Refusing to remove a worktree with uncommitted changes');
  await git(root, ['worktree', 'remove', worktree]);
  return { path: worktree, removed: true };
}
