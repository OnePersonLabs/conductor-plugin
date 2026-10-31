import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDesignHandoff } from '../plugins/conductor/lib/design-handoff.mjs';

function packet() {
  return { format: 'conceptor-design-handoff/1', status: 'ready', bindings: { repository: { kind: 'git', commonDir: process.cwd() }, sourceIdentity: 'issue', requestRevision: 'revision', targetRoot: process.cwd(), scopeHash: 'scope', designHash: 'design', incrementHash: 'increment', plannerId: 'planner' }, implementation: { capabilities: [], sources: [], proposal: {}, increment: {}, context: { sections: [], governing: [] } }, review: { reviewerId: 'reviewer', summary: 'Reviewed governing cases.' } };
}
const request = execute => ({ config: { command: 'adapter', args: ['--request', '-'] }, payload: { review: 'saved' }, sourceIdentity: 'issue', requestRevision: 'revision', worktree: process.cwd(), execute });

test('adapter transports the current request and rejects malformed, stale and unsupported results', async () => {
  const valid = packet();
  const result = await validateDesignHandoff(request(async (command, args, options) => {
    assert.equal(command, 'adapter'); assert.deepEqual(args, ['--request', '-']);
    assert.deepEqual(JSON.parse(options.input), { review: 'saved', sourceIdentity: 'issue', requestRevision: 'revision' });
    assert.equal(options.cwd, process.cwd());
    return { code: 0, stdout: JSON.stringify(valid) };
  }));
  assert.deepEqual(result.implementation, valid.implementation);
  for (const mutate of [p => { p.status = 'stale'; }, p => { p.bindings.requestRevision = 'older'; }, p => { p.bindings.sourceIdentity = 'another issue'; }, p => { p.bindings.targetRoot = process.cwd() + '-missing'; }, p => { p.review.reviewerId = 'planner'; }, p => { delete p.implementation.context; }]) {
    const changed = packet(); mutate(changed);
    await assert.rejects(validateDesignHandoff(request(async () => ({ code: 0, stdout: JSON.stringify(changed) }))));
  }
  await assert.rejects(validateDesignHandoff(request(async () => ({ code: 0, stdout: 'not JSON' }))), /valid JSON/);
  await assert.rejects(validateDesignHandoff(request(async () => ({ code: 2, stdout: JSON.stringify({ status: 'unresolved', issues: [{ reason: 'missing source binding' }] }), stderr: '' }))), /missing source binding/);
  await assert.rejects(validateDesignHandoff(request(async () => { throw new Error('Adapter unavailable'); })), /Adapter unavailable/);
});
