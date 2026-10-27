import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CodexClient } from '../plugins/conductor/lib/codex.mjs';

const fixture = fileURLToPath(new URL('./fixtures/codex-websocket-proxy.mjs', import.meta.url));

test('shared app-server proxy performs WebSocket upgrade and JSON-RPC exchange', async () => {
  const client = new CodexClient({ command: process.execPath, args: [fixture], cwd: process.cwd(), transport: 'proxy' });
  try {
    await client.connect();
    assert.deepEqual(await client.listThreads(), []);
  } finally {
    await client.close();
  }
});

