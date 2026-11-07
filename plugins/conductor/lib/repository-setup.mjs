import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateSetupConfig } from './config.mjs';
import { inspectRepository } from './worktrees.mjs';
import { git } from './process.mjs';

// This probe must remain local and read-only: no Store, runtime or GitHub client.
export async function checkRepositorySetup(cwd) {
  const repo = await inspectRepository(cwd);
  let configPath = join(repo.root, 'conductor.json');
  let contents;
  try { contents = await readFile(configPath, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT' || repo.gitDir === repo.commonDir) throw error;
    // An untracked setup file need not be copied into every linked worktree.
    // Git owns this relationship; a parent directory is not setup inheritance.
    const entry = (await git(repo.root, 'worktree', 'list', '--porcelain', '-z')).split('\0')[0];
    if (!entry.startsWith('worktree ')) throw new Error('Cannot resolve the main checkout for repository setup.');
    const main = await inspectRepository(entry.slice('worktree '.length));
    if (main.commonDir !== repo.commonDir) throw new Error('Setup checkout belongs to a different Git repository.');
    configPath = join(main.root, 'conductor.json');
    contents = await readFile(configPath, 'utf8');
  }
  const config = validateSetupConfig(JSON.parse(contents));
  const origin = await git(repo.root, 'remote', 'get-url', 'origin');
  const repository = origin.match(/^(?:https?:\/\/(?:[^/@]+@)?github\.com\/|ssh:\/\/(?:[^/@]+@)?github\.com\/|(?:[^/@]+@)?github\.com:)([\w.-]+\/[\w.-]+?)\/?$/i)?.[1]?.replace(/\.git$/i, '');
  if (repository?.toLowerCase() !== config.repository.toLowerCase()) throw new Error('origin does not match the repository in conductor.json.');
  return { configured: true, repository: config.repository, root: repo.root, configPath, authorized: config.authorized };
}
