#!/usr/bin/env node
import { handleIssueMutation } from '../lib/issue-mutation-hook.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const payload = JSON.parse(input);
  await handleIssueMutation(payload);
} catch {
  // Hooks must not change the outcome of the GitHub operation they observed.
  // The director's periodic reconciliation remains the recovery path.
}
