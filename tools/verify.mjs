import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = join(root, 'plugins', 'conductor');
const marketplaceName = 'conductor';
const pluginId = `${marketplaceName}@${marketplaceName}`;
const mode = process.argv[2] ?? 'verify';

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { fail(`Cannot read valid JSON from ${relative(root, path)}: ${error.message}`); }
}

function filesUnder(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) fail(`Unexpected symbolic link in package: ${relative(root, path)}`);
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__') fail(`Generated Python cache must not ship: ${relative(root, path)}`);
      files.push(...filesUnder(path));
    } else if (entry.isFile()) files.push(path);
  }
  return files;
}

function inventory(directory) {
  return new Map(filesUnder(directory).map((path) => [
    relative(directory, path).split(sep).join('/'),
    createHash('sha256').update(readFileSync(path)).digest('hex'),
  ]));
}

function compareInventory(source, installed) {
  const expected = inventory(source);
  const actual = inventory(installed);
  const differences = [];
  for (const [path, hash] of expected) if (actual.get(path) !== hash) differences.push(`${path}: missing or different in installed copy`);
  for (const path of actual.keys()) if (!expected.has(path)) differences.push(`${path}: unexpected installed file`);
  if (differences.length) fail(`Installed plugin differs from source:\n${differences.join('\n')}`);
}

function run(executable, args, { env = process.env, cwd = root, label = `${executable} ${args.join(' ')}` } = {}) {
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', windowsHide: true });
  if (result.error) fail(`${label} could not run: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} failed (${result.status ?? result.signal}): ${result.stderr?.trim() || result.stdout?.trim() || 'no diagnostic output'}`);
  return result.stdout;
}

function pythonCommand() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function validatePackage() {
  const packageJson = readJson(join(root, 'package.json'));
  const pluginJson = readJson(join(plugin, '.codex-plugin', 'plugin.json'));
  const marketplace = readJson(join(root, '.agents', 'plugins', 'marketplace.json'));
  if (packageJson.name !== 'conductor' || packageJson.version !== '0.1.0') fail('root package identity/version differs from conductor@0.1.0');
  const binEntry = packageJson.bin?.['conductor'];
  if (binEntry !== 'plugins/conductor/bin/conductor.mjs' || !existsSync(resolve(root, binEntry ?? ''))) {
    fail('package bin entry must point to an existing Conductor CLI source file');
  }
  if (pluginJson.name !== 'conductor' || pluginJson.version !== '0.1.0') fail('plugin manifest identity/version differs from conductor@0.1.0');
  if (pluginJson.skills !== './skills/') fail('plugin manifest must expose the shipped skills directory');
  if (marketplace.name !== marketplaceName || marketplace.plugins?.length !== 1) fail('marketplace must expose exactly one conductor plugin');
  const entry = marketplace.plugins[0];
  if (entry.name !== marketplaceName || entry.source?.source !== 'local' || entry.source.path !== './plugins/conductor') fail('marketplace plugin identity/source path is incorrect');

  const expected = new Map([
    ['github-workflow', true],
    ['setup-repo-workflow', false],
  ]);
  for (const [name, implicit] of expected) {
    const skill = join(plugin, 'skills', name);
    if (!existsSync(join(skill, 'SKILL.md')) || !existsSync(join(skill, 'agents', 'openai.yaml'))) fail(`${name}: SKILL.md or activation metadata missing`);
    const metadata = readFileSync(join(skill, 'agents', 'openai.yaml'), 'utf8');
    if (!metadata.includes(`$conductor:${name}`)) fail(`${name}: activation prompt does not use the conductor namespace`);
    if (!metadata.includes(`allow_implicit_invocation: ${implicit}`)) fail(`${name}: unexpected implicit invocation policy`);
  }
}

function runUnit() {
  const nodeTests = readdirSync(join(root, 'tests')).filter((name) => name.endsWith('.test.mjs')).map((name) => join('tests', name));
  if (nodeTests.length) run(process.execPath, ['--test', ...nodeTests], { label: 'Node unit tests' });
  run(pythonCommand(), ['-B', 'tests/test_pr_feedback.py'], { label: 'PR feedback receipt tests' });
}

function jsonCommand(args, env) {
  const output = run(process.env.CODEX_BIN || 'codex', args, { env, label: `codex ${args.join(' ')}` });
  try { return JSON.parse(output); }
  catch (error) { fail(`codex ${args.join(' ')} returned invalid JSON: ${error.message}`); }
}

function runInstalled() {
  validatePackage();
  runUnit();
  const home = mkdtempSync(join(tmpdir(), 'conductor-codex-home-'));
  const env = { ...process.env, CODEX_HOME: home };
  try {
    const initial = jsonCommand(['plugin', 'list', '--json'], env);
    if ((initial.installed ?? []).length) fail('isolated Codex home unexpectedly contains installed plugins');
    jsonCommand(['plugin', 'marketplace', 'add', root, '--json'], env);
    const available = jsonCommand(['plugin', 'list', '--marketplace', marketplaceName, '--available', '--json'], env);
    const availableEntries = available.available ?? available.plugins ?? [];
    if (!availableEntries.some((item) => item.pluginId === pluginId || item.name === marketplaceName)) fail('Codex did not discover conductor from the local marketplace');
    const added = jsonCommand(['plugin', 'add', pluginId, '--json'], env);
    if (typeof added.installedPath !== 'string' || !existsSync(added.installedPath)) fail('Codex plugin add did not return an installedPath');
    const installedPath = realpathSync(added.installedPath);
    const installedList = jsonCommand(['plugin', 'list', '--json'], env);
    if (!(installedList.installed ?? []).some((item) => item.pluginId === pluginId)) fail('Codex installed-plugin discovery does not list conductor');
    compareInventory(plugin, installedPath);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function main() {
  if (!['contract', 'unit', 'installed', 'verify'].includes(mode)) fail(`Unknown verification mode: ${mode}`);
  if (mode === 'contract' || mode === 'verify' || mode === 'installed') validatePackage();
  if (mode === 'unit' || mode === 'verify') runUnit();
  if (mode === 'installed') runInstalled();
}

try { main(); }
catch (error) {
  console.error(`verify: ${error.message}`);
  process.exitCode = 1;
}
