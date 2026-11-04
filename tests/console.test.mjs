import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchService, createReporter, activityLines, windowsArguments } from '../plugins/conductor/lib/console.mjs';

test('Windows console launch transports literal command arguments without shell interpolation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-console-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const args = ['C:\\a & b\\runner.mjs', 'a"b', 'trailing\\', '', '$(literal)'];
  const child = await launchService('C:\\Program Files\\nodejs\\node.exe', args, { cwd: dir, logPath: join(dir, 'service.log'), platform: 'win32', execute: async (_exe, argv, options) => {
    assert.ok(argv.includes('-EncodedCommand'));
    const program = Buffer.from(argv.at(-1), 'base64').toString('utf16le');
    assert.match(program, /Start-Process .* -WindowStyle Normal -PassThru/);
    const payload = JSON.parse(Buffer.from(options.env.CONDUCTOR_LAUNCH, 'base64').toString());
    assert.equal(payload.command, 'C:\\Program Files\\nodejs\\node.exe');
    assert.equal(payload.cwd, dir);
    assert.equal(payload.arguments, windowsArguments(args));
    assert.equal(program.includes('$(literal)'), false);
    return { stdout: '1234\r\n' };
  } });
  assert.equal(child.pid, 1234);
});

test('progress appears in console and retained log, including the exact resume action', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-console-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let displayed = '';
  const report = createReporter(join(dir, 'service.log'), { stdout: { write: value => { displayed += value; } } });
  const lines = activityLines({ running: true, runnerPause: { reason: 'Closed terminal' }, holds: [{ active: true, issues: [5], reason: 'Hardware choice' }], jobs: [{ issue: 36, phase: 'review', pr: 42 }], director: { interaction: { active: true } } });
  lines.forEach(line => report(line));
  assert.match(displayed, /PAUSED -- run conductor resume to continue/);
  assert.match(displayed, /Issue #5 ON HOLD -- Hardware choice/);
  assert.match(displayed, /WAITING FOR YOU/);
  assert.match(displayed, /Issue #36: review; PR #42/);
  assert.equal(await readFile(join(dir, 'service.log'), 'utf8'), displayed);
});
