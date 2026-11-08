import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateSetupConfig } from './config.mjs';
import { inspectRepository } from './worktrees.mjs';
import { git } from './process.mjs';

// Setup inheritance follows Git ownership, never arbitrary parent directories.
async function readSetup(repo, { optional = false } = {}) {
  let configPath = join(repo.root, 'conductor.json');
  let contents;
  try { contents = await readFile(configPath, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (repo.gitDir === repo.commonDir) {
      if (optional) return undefined;
      throw error;
    }
    // An untracked setup file need not be copied into every linked worktree.
    // Git owns this relationship; a parent directory is not setup inheritance.
    const entry = (await git(repo.root, 'worktree', 'list', '--porcelain', '-z')).split('\0')[0];
    if (!entry.startsWith('worktree ')) throw new Error('Cannot resolve the main checkout for repository setup.');
    const main = await inspectRepository(entry.slice('worktree '.length));
    if (main.commonDir !== repo.commonDir) throw new Error('Setup checkout belongs to a different Git repository.');
    configPath = join(main.root, 'conductor.json');
    try { contents = await readFile(configPath, 'utf8'); }
    catch (error) {
      if (optional && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }
  const config = validateSetupConfig(JSON.parse(contents));
  return { config, configPath };
}

async function githubRepository(repo) {
  const origin = await git(repo.root, 'remote', 'get-url', 'origin');
  const repository = origin.match(/^(?:https?:\/\/(?:[^/@]+@)?github\.com\/|ssh:\/\/(?:[^/@]+@)?github\.com\/|(?:[^/@]+@)?github\.com:)([\w.-]+\/[\w.-]+?)\/?$/i)?.[1]?.replace(/\.git$/i, '');
  if (!repository) throw new Error('origin must identify a GitHub owner/repository.');
  return repository;
}

// These probes remain local and read-only: no Store, runtime or GitHub client.
export async function checkRepositorySetup(cwd) {
  const repo = await inspectRepository(cwd);
  const { config, configPath } = await readSetup(repo);
  let repository;
  try { repository = await githubRepository(repo); }
  catch (cause) { throw new Error('origin does not match the repository in conductor.json.', { cause }); }
  if (repository?.toLowerCase() !== config.repository.toLowerCase()) throw new Error('origin does not match the repository in conductor.json.');
  return { configured: true, repository: config.repository, root: repo.root, configPath, authorized: config.authorized };
}

// Local phase work needs Git for authored plans and review baselines, not a
// GitHub runner. A present but invalid setup still blocks work: ignoring it
// could bypass the repository's configured identity or delivery constraints.
export async function checkWorkScope(cwd, scope = 'local') {
  if (!['local', 'issues', 'automation'].includes(scope)) throw new Error('scope must be local, issues or automation.');
  if (scope === 'automation') {
    const setup = await checkRepositorySetup(cwd);
    if (!setup.authorized) throw new Error('Automation requires authorized: true in conductor.json.');
    return { scope, ...setup };
  }
  const repo = await inspectRepository(cwd);
  const setup = await readSetup(repo, { optional: true });
  const result = { scope, root: repo.root, configured: Boolean(setup) };
  if (scope === 'issues' || setup) {
    result.repository = await githubRepository(repo);
    if (setup && result.repository.toLowerCase() !== setup.config.repository.toLowerCase()) {
      throw new Error('origin does not match the repository in conductor.json.');
    }
  }
  if (setup) Object.assign(result, { configPath: setup.configPath, authorized: setup.config.authorized });
  return result;
}
