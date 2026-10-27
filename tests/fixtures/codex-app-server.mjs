import { createInterface } from 'node:readline';

const mode = process.env.CODEX_FAKE_MODE ?? 'normal';
const input = createInterface({ input: process.stdin });
let outputQueue = Promise.resolve();

function frame(message, { partial = true } = {}) {
  const text = `${JSON.stringify(message)}\n`;
  outputQueue = outputQueue.then(() => new Promise((resolveWrite) => {
    if (!partial || text.length < 4) {
      process.stdout.write(text, resolveWrite);
      return;
    }
    const midpoint = Math.floor(text.length / 2);
    process.stdout.write(text.slice(0, midpoint), () => {
      setTimeout(() => process.stdout.write(text.slice(midpoint), resolveWrite), 1);
    });
  }));
}

input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write(`invalid input: ${line}\n`);
    return;
  }

  if (message.method === 'initialize') {
    frame({ id: message.id, result: {} });
    if (mode === 'malformed') setTimeout(() => process.stdout.write('not-json\n'), 20);
    return;
  }

  if (message.method === 'thread/start' && mode === 'error') {
    frame({ id: message.id, error: { code: -32001, message: 'fixture failure', data: { retryable: false } } });
    return;
  }

  if (message.method === 'config/read') {
    frame({ id: message.id, result: { config: { additional: { mcp_servers: { github: { enabled: true }, linear: { enabled: true } }, apps: { github: { enabled: true } }, plugins: { 'review-tools@local': { enabled: true } } } } } });
    return;
  }

  if (message.method === 'thread/start') {
    frame({ method: 'fixture/threadStarted', params: message.params });
    frame({ id: message.id, result: { thread: { id: 'thread-new', cwd: message.params.cwd } } });
    return;
  }

  if (message.method === 'thread/name/set') {
    frame({ method: 'fixture/threadNamed', params: message.params });
    frame({ id: message.id, result: {} });
    return;
  }

  if (message.method === 'thread/resume') {
    frame({ id: message.id, result: { thread: { id: message.params.threadId, cwd: message.params.cwd, resumed: true } } });
    return;
  }

  if (message.method === 'turn/start') {
    const text = message.params.input.find((item) => item.type === 'text')?.text ?? 'unknown';
    frame({
      method: 'fixture/turnInput',
      params: { input: message.params.input, cwd: message.params.cwd, outputSchema: message.params.outputSchema },
    });
    if (mode === 'terminal') {
      frame({
        method: 'item/completed',
        params: { threadId: message.params.threadId, turnId: 'terminal-turn', item: { type: 'agentMessage', text: 'finished response' } },
      });
    }
    if (mode === 'request' && !globalThis.sentApproval) {
      globalThis.sentApproval = true;
      frame({
        id: 'approval:one',
        method: 'item/commandExecution/requestApproval',
        params: { command: ['git', 'status'], reason: 'fixture approval request' },
      });
    }
    if (mode === 'exit') {
      setTimeout(() => process.exit(7), 15);
      return;
    }
    const complete = () => frame({ id: message.id, result: { turn: { id: `turn-${text}`, status: 'inProgress' } } });
    if (mode === 'out-of-order') setTimeout(complete, text === 'slow' ? 35 : 2);
    else complete();
    return;
  }

  if (message.method === 'turn/interrupt') {
    frame({ method: 'fixture/interruptReceived', params: message.params });
    frame({ id: message.id, result: {} });
    return;
  }

  if (Object.hasOwn(message, 'id') && message.id === 'approval:one') {
    frame({ method: 'fixture/responseReceived', params: { id: message.id, result: message.result } });
  }
});

input.on('close', () => process.exit(0));
