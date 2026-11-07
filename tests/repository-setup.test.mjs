import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, run } from '../plugins/conductor/lib/process.mjs';
import { checkRepositorySetup } from '../plugins/conductor/lib/repository-setup.mjs';
import { loadConfig } from '../plugins/conductor/lib/config.mjs';

const cli = fileURLToPath(new URL('../plugins/conductor/bin/conductor.mjs', import.meta.url));
const config = { version: 2, repository: 'example/project', baseBranch: 'main', authorized: false, admissionPaused: true, checks: [{ command: 'node', args: ['--version'] }] };

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'conductor-setup-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'source café');
  await mkdir(root);
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'Test');
  await git(root, 'config', 'user.email', 'test@example.invalid');
  await git(root, 'remote', 'add', 'origin', 'git@github.com:example/project.git');
  await git(root, 'commit', '--allow-empty', '-m', 'initial');
  return { temp, root, path: join(root, 'conductor.json') };
}

test('setup CLI is read-only and accepts manual setup without execution authority', async t => {
  const { root, path } = await fixture(t);
  const contents = JSON.stringify(config);
  await writeFile(path, contents);
  const subdir = join(root, 'src');
  await mkdir(subdir);
  const before = await readdir(join(root, '.git'));
  const status = await git(root, 'status', '--porcelain');
  const result = JSON.parse((await run(process.execPath, [cli, 'check-setup'], { cwd: subdir })).stdout);
  assert.equal(result.configured, true);
  assert.equal(result.authorized, false);
  assert.equal(result.repository, config.repository);
  assert.equal(result.configPath, path);
  assert.equal(await readFile(path, 'utf8'), contents);
  assert.deepEqual(await readdir(join(root, '.git')), before);
  assert.equal(await git(root, 'status', '--porcelain'), status);
  await assert.rejects(loadConfig(root), /authorized: true/);
  await writeFile(path, JSON.stringify({ ...config, authorized: true }));
  assert.equal((await loadConfig(root)).authorized, true);
});

test('setup rejects missing, malformed, unsupported and wrong-repository configuration', async t => {
  const { root, temp, path } = await fixture(t);
  await assert.rejects(checkRepositorySetup(temp), /not a git repository/);
  await assert.rejects(checkRepositorySetup(root), /ENOENT/);
  for (const contents of ['{', JSON.stringify({ ...config, version: 1 }), JSON.stringify({ ...config, checks: [] }), JSON.stringify({ ...config, authorized: 'yes' }), JSON.stringify({ ...config, repository: 'other/project' })]) {
    await writeFile(path, contents);
    await assert.rejects(checkRepositorySetup(root));
  }
  const result = await run(process.execPath, [cli, 'check-setup'], { cwd: root, allowFailure: true });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /origin does not match/);
  assert.equal(result.stdout, '');
  await writeFile(path, JSON.stringify(config));
  for (const origin of ['https://github.com/example/project.git', 'ssh://git@github.com/example/project.git', 'git@github.com:EXAMPLE/PROJECT.git']) {
    await git(root, 'remote', 'set-url', 'origin', origin);
    assert.equal((await checkRepositorySetup(root)).configured, true);
  }
  await git(root, 'remote', 'set-url', 'origin', 'https://notgithub.com/example/project.git');
  await assert.rejects(checkRepositorySetup(root), /origin does not match/);
});

test('linked worktrees inherit only missing setup from their own main checkout', async t => {
  const { root, temp, path } = await fixture(t);
  await writeFile(path, JSON.stringify(config));
  const linked = join(temp, 'linked worktree');
  await git(root, 'worktree', 'add', '-b', 'linked', linked);
  assert.equal((await checkRepositorySetup(linked)).configPath, path);
  const local = join(linked, 'conductor.json');
  await writeFile(local, '{');
  await assert.rejects(checkRepositorySetup(linked), SyntaxError);
  await writeFile(local, JSON.stringify({ ...config, authorized: true }));
  assert.equal((await checkRepositorySetup(linked)).configPath, local);
  assert.equal((await checkRepositorySetup(linked)).authorized, true);
  const nested = join(root, 'other-repo');
  await mkdir(nested);
  await git(nested, 'init', '-b', 'main');
  await git(nested, 'remote', 'add', 'origin', 'https://github.com/example/project.git');
  await assert.rejects(checkRepositorySetup(nested), /ENOENT/);
});
