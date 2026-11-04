import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { run } from './process.mjs';
import { appendServiceLog, prepareServiceLog } from './state.mjs';
import { RUNNER_PAUSED_MESSAGE } from './runner-state.mjs';

// Start-Process flattens ArgumentList. Quote for Windows argv, not for a shell;
// the PowerShell program is fixed and receives all launch data through its env.
export function windowsArguments(args) {
  return args.map(arg => `"${String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`).join(' ');
}

export async function launchService(command, args, { cwd, logPath, env = process.env, platform = process.platform, execute = run } = {}) {
  await prepareServiceLog(logPath);
  const serviceEnv = { ...env, CONDUCTOR_SERVICE_LOG: logPath };
  if (platform !== 'win32') {
    const child = spawn(command, args, { cwd, env: serviceEnv, detached: true, windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    return child;
  }
  const script = `$ErrorActionPreference = 'Stop'
$launch = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CONDUCTOR_LAUNCH)) | ConvertFrom-Json
Remove-Item Env:\\CONDUCTOR_LAUNCH
$child = Start-Process -FilePath $launch.command -ArgumentList $launch.arguments -WorkingDirectory $launch.cwd -WindowStyle Normal -PassThru
$child.Id`;
  const payload = Buffer.from(JSON.stringify({ command, arguments: windowsArguments(args), cwd })).toString('base64');
  const result = await execute(join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { cwd, env: { ...serviceEnv, CONDUCTOR_LAUNCH: payload } });
  const pid = Number(result.stdout.trim());
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Windows did not return the runner process ID. Inspect status before retrying.');
  return { pid, unref() {} };
}

export function createReporter(logPath, { stdout = process.stdout, stderr = process.stderr } = {}) {
  return (message, { error = false } = {}) => {
    const now = Date.now(), text = String(message);
    appendServiceLog(logPath, text, now);
    (error ? stderr : stdout).write(`${new Date(now).toISOString()} ${text}\n`);
  };
}

export function activityLines(state) {
  const lines = [];
  if (state.runnerPause) lines.push(`${RUNNER_PAUSED_MESSAGE}${state.runnerPause.reason ? ` (${state.runnerPause.reason})` : ''}`);
  else if (state.admissionPaused) lines.push('PAUSED -- repository admission is paused; ask the director to activate it when ready');
  else lines.push(state.running ? 'RUNNING -- watching issues and coordinating eligible work' : 'STOPPED -- run conductor resume to continue');
  if (state.director?.interaction?.active) lines.push('WAITING FOR YOU -- answer the pending question in the director chat or its linked inbox');
  for (const hold of state.holds ?? []) if (hold.active) {
    lines.push(`${hold.all ? 'All issues' : (hold.issues ?? []).map(n => `Issue #${n}`).join(', ')} ON HOLD -- ${hold.reason ?? 'explicitly held'}; ask the director to release this hold`);
  }
  for (const job of state.jobs ?? []) {
    const detail = job.lastError ?? job.summary;
    lines.push(`Issue #${job.issue}: ${job.phase}${job.activeRole ? ` (${job.activeRole})` : ''}${job.pr ? `; PR #${job.pr}` : ''}${detail ? ` -- ${detail}` : ''}`);
  }
  return lines;
}
