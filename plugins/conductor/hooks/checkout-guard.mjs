#!/usr/bin/env node
import { handleCheckoutGuard } from '../lib/checkout-guard.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const result = await handleCheckoutGuard(JSON.parse(input));
  process.stdout.write(`${JSON.stringify(result.hookOutput ?? {})}\n`);
} catch (error) {
  // Exit 2 is a native PreToolUse denial; never silently turn an internal error
  // into permission to write. UserPromptSubmit remains a notice-only boundary.
  process.stderr.write(`🚨 Conductor checkout guard failed: ${error.message}. Inspect ownership from the recorded director chat.\n`);
  try { if (JSON.parse(input).hook_event_name === 'PreToolUse') process.exitCode = 2; } catch { process.exitCode = 2; }
}
