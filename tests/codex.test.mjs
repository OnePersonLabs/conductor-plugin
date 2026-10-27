import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CodexClient } from '../plugins/symphony-lite/lib/codex.mjs';

const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url));

function createClient(mode = 'normal', command = process.execPath, args = [fixture]) {
  return new CodexClient({
    cwd: process.cwd(),
    command,
    args,
    env: { ...process.env, CODEX_FAKE_MODE: mode },
  });
}

async function withClient(mode, callback, command = process.execPath, args = [fixture]) {
  const client = createClient(mode, command, args);
  try {
    await client.connect();
    assert.ok(client.pid > 0);
    await callback(client);
  } finally {
    await client.close();
  }
}

function nextMatching(client, eventName, predicate = () => true) {
  return new Promise((resolveEvent, rejectEvent) => {
    const timer = setTimeout(() => {
      client.off(eventName, onEvent);
      rejectEvent(new Error(`Timed out waiting for ${eventName}`));
    }, 2000);
    const onEvent = (value) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      client.off(eventName, onEvent);
      resolveEvent(value);
    };
    client.on(eventName, onEvent);
  });
}

test('connects, starts and resumes threads, and uses configured cwd defaults', async () => {
  await withClient('normal', async (client) => {
    const thread = await client.startThread();
    assert.equal(thread.id, 'thread-new');
    assert.equal(thread.cwd, process.cwd());

    const resumed = await client.resumeThread({ threadId: 'thread-existing', cwd: process.cwd() });
    assert.equal(resumed.id, 'thread-existing');
    assert.equal(resumed.resumed, true);
  });
});

test('starts a read-only session and names it by its durable thread ID', async () => {
  await withClient('normal', async client => {
    const configured = await client.readConfig({ cwd: process.cwd() });
    assert.deepEqual(Object.keys(configured.config.additional), ['mcp_servers', 'apps', 'plugins']);
    const started = nextMatching(client, 'notification', item => item.method === 'fixture/threadStarted');
    const isolation = { 'apps._default.enabled': false, 'plugins._default.enabled': false, 'mcp_servers.github': { enabled: false }, 'mcp_servers.linear': { enabled: false }, 'apps.github.enabled': false, 'plugins.review-tools@local.enabled': false };
    const thread = await client.startThread({ cwd: process.cwd(), sandbox: 'read-only', approvalPolicy: 'never', config: isolation });
    assert.deepEqual((await started).params, { cwd: process.cwd(), sandbox: 'read-only', approvalPolicy: 'never', config: isolation });
    const named = nextMatching(client, 'notification', item => item.method === 'fixture/threadNamed');
    await client.setThreadName({ threadId: thread.id, name: 'example/project #42 - reviewer' });
    assert.deepEqual((await named).params, { threadId: 'thread-new', name: 'example/project #42 - reviewer' });
  });
});

test('resolves an npm-style Windows codex shim to its JavaScript launcher', { skip: process.platform !== 'win32' }, async () => {
  const shim = fileURLToPath(new URL('./fixtures/codex-app-server-shim.cmd', import.meta.url));
  await withClient('normal', async (client) => {
    const thread = await client.startThread();
    assert.equal(thread.id, 'thread-new');
  }, shim, []);
});

test('routes out-of-order responses to their matching calls and sends skill input', async () => {
  await withClient('out-of-order', async (client) => {
    const inputPromise = nextMatching(client, 'notification', (item) => item.method === 'fixture/turnInput' && item.params.input.some((input) => input.type === 'text' && input.text === 'slow'));
    const slow = client.startTurn({
      threadId: 'thread',
      prompt: 'slow',
      skillPath: 'C:/skills/github-workflow/SKILL.md',
      outputSchema: { type: 'object' },
    });
    const fast = client.startTurn({ threadId: 'thread', prompt: 'fast' });
    const [slowTurn, fastTurn] = await Promise.all([slow, fast]);
    assert.equal(slowTurn.id, 'turn-slow');
    assert.equal(fastTurn.id, 'turn-fast');
    const sent = await inputPromise;
    assert.deepEqual(sent.params.input[0], {
      type: 'skill',
      name: 'github-workflow',
      path: resolve('C:/skills/github-workflow/SKILL.md'),
    });
    assert.deepEqual(sent.params.input[1], { type: 'text', text: 'slow' });
    assert.deepEqual(sent.params.outputSchema, { type: 'object' });
  });
});

test('surfaces approval requests and requires an explicit response', async () => {
  await withClient('request', async (client) => {
    const requestPromise = nextMatching(client, 'request', (request) => request.method === 'item/commandExecution/requestApproval');
    const turn = await client.startTurn({ threadId: 'thread', prompt: 'approval-check' });
    assert.equal(turn.id, 'turn-approval-check');
    const request = await requestPromise;
    assert.equal(request.id, 'approval:one');
    assert.deepEqual(client.pendingRequests, [request]);

    const receivedPromise = nextMatching(client, 'notification', (notification) => notification.method === 'fixture/responseReceived');
    await client.respond(request.id, { decision: 'decline' });
    assert.deepEqual((await receivedPromise).params.result, { decision: 'decline' });
    assert.deepEqual(client.pendingRequests, []);
    await assert.rejects(client.respond(request.id, {}), /No pending Codex server request/);
  });
});

test('sends a turn interrupt with both owning identifiers', async () => {
  await withClient('normal', async (client) => {
    const notification = nextMatching(client, 'notification', (item) => item.method === 'fixture/interruptReceived');
    await client.interrupt({ threadId: 'thread-1', turnId: 'turn-2' });
    assert.deepEqual((await notification).params, { threadId: 'thread-1', turnId: 'turn-2' });
  });
});

test('preserves terminal agentMessage text in item/completed notifications', async () => {
  await withClient('terminal', async (client) => {
    const completed = nextMatching(client, 'notification', (item) => item.method === 'item/completed');
    await client.startTurn({ threadId: 'thread', prompt: 'terminal' });
    const notification = await completed;
    assert.equal(notification.params.item.type, 'agentMessage');
    assert.equal(notification.params.item.text, 'finished response');
  });
});

test('rejects JSON-RPC errors with method and diagnostic data', async () => {
  await withClient('error', async (client) => {
    await assert.rejects(client.startThread(), (error) => {
      assert.match(error.message, /fixture failure/);
      assert.equal(error.code, -32001);
      assert.deepEqual(error.data, { retryable: false });
      assert.equal(error.method, 'thread/start');
      return true;
    });
  });
});

test('reports child exit and rejects an in-flight operation', async () => {
  const client = createClient('exit');
  const exitPromise = once(client, 'exit');
  await client.connect();
  const operation = client.startTurn({ threadId: 'thread', prompt: 'exit-now' });
  const [exit] = await exitPromise;
  assert.equal(exit.code, 7);
  await assert.rejects(operation, /exited \(code 7\)/);
  await client.close();
});

test('accepts partial stdout frames and records malformed frames without an error listener', async () => {
  await withClient('malformed', async (client) => {
    await delay(40);
    assert.match(client.lastError.message, /Invalid JSON/);
    const thread = await client.startThread();
    assert.equal(thread.id, 'thread-new');
  });
});

