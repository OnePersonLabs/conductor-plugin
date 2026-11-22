#!/usr/bin/env node
// Deterministic stand-in for `claude -p --output-format stream-json`.
// The prompt selects behavior: FAIL exits with an error result, SLEEP waits
// to be interrupted. Every invocation's argv is appended to FAKE_CLAUDE_LOG.
import { appendFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (Fake Claude Code)'); process.exit(0); }
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ args, prompt })}\n`);

const value = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const session = value('--session-id') ?? value('--resume');
const emit = message => process.stdout.write(`${JSON.stringify({ session_id: session, ...message })}\n`);

// Claude Code writes the transcript on the first turn; later turns resume it.
const transcriptDir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fake-project');
const transcript = join(transcriptDir, `${session}.jsonl`);
mkdirSync(transcriptDir, { recursive: true });
if (!existsSync(transcript)) writeFileSync(transcript, '');
appendFileSync(transcript, `${JSON.stringify({ type: 'user', cwd: process.cwd(), promptId: `p-${Date.now()}`, uuid: `u-${Date.now()}`, message: { role: 'user', content: prompt } })}\n`);

emit({ type: 'system', subtype: 'init', cwd: process.cwd() });
if (prompt.includes('SLEEP')) { setInterval(() => {}, 1000); }
else if (prompt.includes('FAIL')) {
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'fake failure' });
  process.exit(1);
} else {
  const text = args.includes('plan') ? '1. Read the code.\n2. Change it.' : 'done';
  emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } });
  const schema = value('--json-schema');
  emit({ type: 'result', subtype: 'success', is_error: false, result: text, ...(schema ? { structured_output: { ok: true } } : {}) });
}
