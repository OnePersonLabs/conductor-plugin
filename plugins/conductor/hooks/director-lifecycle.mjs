#!/usr/bin/env node
import { handleDirectorLifecycle } from '../lib/director-lifecycle.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
let payload;
try { payload = JSON.parse(input); }
catch { process.stdout.write('{}\n'); process.exit(0); }

const event = payload?.hook_event_name;
try {
  const result = await handleDirectorLifecycle(payload);
  if (result.hookOutput) process.stdout.write(`${JSON.stringify(result.hookOutput)}\n`);
  else if (event === 'Stop' || event === 'Interrupt') process.stdout.write('{}\n');
  if (result.error) {
    process.stderr.write(`${result.error}\n`);
    if (event === 'UserPromptSubmit') process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`Conductor director activity hook failed: ${error.message}\n`);
  if (event === 'UserPromptSubmit') {
    process.exitCode = 2;
  } else if (event === 'Stop' || event === 'Interrupt') {
    process.stdout.write('{}\n');
  }
}
