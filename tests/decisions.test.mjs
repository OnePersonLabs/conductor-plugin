import test from 'node:test';
import assert from 'node:assert/strict';
import { readDecisions, recordDecision } from '../plugins/conductor/lib/decisions.mjs';

function fixture() {
  const comments = [];
  let loseResponse = false;
  const github = { comments: async () => structuredClone(comments), api: async (_path, { fields }) => { comments.push({ body: fields.body }); if (loseResponse) { loseResponse = false; throw new Error('lost response'); } } };
  return { github, comments, lose: () => { loseResponse = true; } };
}
const pending = { context: 'Accepted goal: reopen the same session', question: 'Should reopening restore unfinished work?', status: 'pending' };

test('five integrated answers survive replacement; the sixth remains pending', async () => {
  const h = fixture();
  let state = await readDecisions(h.github, 23);
  for (let i = 1; i <= 6; i++) {
    const write = async record => { state = await recordDecision(h.github, 'owner/repo', { issue: 23, decisionId: `choice-${i}`, expectedRevision: state.revision, record }); };
    await write(pending);
    if (i <= 5) {
      await write({ ...pending, status: 'answered', answer: 'Yes, preserve it.' });
      await write({ ...pending, status: 'integrated', answer: 'Yes, preserve it.', integration: 'Acceptance and meaning updated; reread confirms persistence.' });
    }
  }
  const recovered = await readDecisions(h.github, 23);
  assert.equal(recovered.decisions.filter(x => x.record.status === 'integrated').length, 5);
  assert.deepEqual(recovered.decisions.filter(x => x.record.status === 'pending').map(x => x.decisionId), ['choice-6']);
});

test('lost write responses and duplicate submissions reconcile without duplicate records', async () => {
  const h = fixture();
  const state = await readDecisions(h.github, 18);
  const request = { issue: 18, decisionId: 'practice', expectedRevision: state.revision, record: pending };
  h.lose();
  const written = await recordDecision(h.github, 'owner/repo', request);
  assert.deepEqual(await recordDecision(h.github, 'owner/repo', request), written);
  assert.equal(h.comments.length, 1);
});

test('stale revisions, empty answers and skipped integration stages cannot erase progress', async () => {
  const h = fixture();
  let state = await readDecisions(h.github, 23);
  const write = record => recordDecision(h.github, 'owner/repo', { issue: 23, decisionId: 'save', expectedRevision: state.revision, record });
  const stale = state.revision;
  state = await write(pending);
  await assert.rejects(recordDecision(h.github, 'owner/repo', { issue: 23, decisionId: 'save', expectedRevision: stale, record: { ...pending, status: 'answered', answer: 'Yes' } }), /revision changed/);
  await assert.rejects(write({ ...pending, status: 'answered', answer: ' ' }), /nonempty/);
  await assert.rejects(write({ ...pending, status: 'integrated', answer: 'Yes', integration: 'done' }), /Persist the answer/);
  state = await write({ ...pending, status: 'answered', answer: 'Yes' });
  await assert.rejects(write(pending), /recorded answer/);
  state = await write({ ...pending, status: 'integrated', answer: 'Yes', integration: 'Verified issue and meaning' });
  await assert.rejects(write(pending), /materially changed/);
  state = await write({ ...pending, context: 'New requirement changes retention scope' });
  await assert.rejects(write({ ...pending, status: 'deferred', answer: 'Later' }), /return condition/);
  state = await write({ ...pending, status: 'deferred', answer: 'Later', returnCondition: 'After the next session trial' });
  assert.equal(state.decisions[0].record.status, 'deferred');
});
