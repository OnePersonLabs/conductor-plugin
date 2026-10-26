import { spawn } from 'node:child_process';

export function run(command, args, { cwd, env = process.env, input, signal, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, signal, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    child.stdout.on('data', b => out.push(b));
    child.stderr.on('data', b => err.push(b));
    child.once('error', reject);
    child.once('close', (code, terminationSignal) => {
      const result = { code, signal: terminationSignal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
      if (code !== 0 && !allowFailure) reject(Object.assign(new Error(`${command} failed (${code ?? terminationSignal}): ${result.stderr.trim()}`), { result }));
      else resolve(result);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function git(cwd, ...args) { return (await run('git', args, { cwd })).stdout.trim(); }
