import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveIssue, parseIssueTargetArgs } from '../plugins/conductor/lib/issue-context.mjs';
import { GitHub } from '../plugins/conductor/lib/github.mjs';
import { parseArgs } from '../plugins/conductor/bin/conductor.mjs';

const repository = 'example/project';
const issue = (number, title, state = 'open') => ({ number, title, state, body: `Full issue ${number}`, labels: [] });

function fixture(pages, snapshots = []) {
  const calls = [];
  let listing = pages;
  const github = new GitHub(repository, { cwd: 'checkout', execute: async (command, args) => {
    calls.push({ command, args });
    assert.equal(command, 'gh');
    assert.equal(args[0], 'api');
    if (args[1] === `repos/${repository}/issues?state=all&per_page=100`) {
      assert.deepEqual(args.slice(2), ['--paginate', '--slurp']);
      return { stdout: JSON.stringify(listing) };
    }
    const found = snapshots.find(value => args[1] === `repos/${repository}/issues/${value.number}`);
    if (!found) throw new Error('gh failed: HTTP 404 Not Found');
    return { stdout: JSON.stringify(found) };
  } });
  const dependencies = { github, checkWorkScope: async (cwd, scope) => {
    assert.equal(cwd, 'checkout'); assert.equal(scope, 'issues');
    return { repository, root: cwd, configured: false };
  } };
  return { calls, dependencies, listing: value => { listing = value; } };
}

test('CLI parser preserves literal targets, validates current IDs and accepts no implicit target', () => {
  const args = ['--current', '42', '--target', '  New   query  '];
  assert.deepEqual(parseIssueTargetArgs(args), { current: 42, target: '  New   query  ' });
  assert.deepEqual(args, ['--current', '42', '--target', '  New   query  ']);
  assert.deepEqual(parseArgs(['resolve-issue', ...args]), { command: 'resolve-issue', overrides: {}, current: 42, target: '  New   query  ' });
  assert.deepEqual(parseIssueTargetArgs([]), {});
  for (const invalid of [['--current', '0'], ['--current', '#42'], ['--current', '1.5'], ['--target'], ['--target', ' '], ['--target', '--current', '42'], ['--target', 'a', '--target', 'b'], ['--write'], ['name']]) {
    assert.throws(() => parseIssueTargetArgs(invalid));
  }
});

test('explicit ID and URL win over current; only absent target uses established current', async () => {
  const one = issue(1, 'Current', 'closed'), two = issue(2, 'Requested');
  const h = fixture([], [one, two]);
  for (const target of ['2', '#2', 'https://github.com/EXAMPLE/PROJECT/issues/2?source=chat#issuecomment-1']) {
    const result = await resolveIssue('checkout', { target, current: 1 }, h.dependencies);
    assert.equal(result.status, 'resolved'); assert.equal(result.query, target);
    assert.deepEqual(result.issue, two);
  }
  const current = await resolveIssue('checkout', { current: 1 }, h.dependencies);
  assert.equal(current.currentUsed, 1); assert.deepEqual(current.issue, one);
  assert.equal(h.calls.length, 4);
});

test('fresh paginated all-state lookup resolves a normalized unique exact title over weaker partials', async () => {
  const exact = issue(7, '  ALPHA\t project ', 'closed');
  const h = fixture([[issue(3, 'Alpha project extra'), { ...issue(8, 'Alpha project'), pull_request: {} }], [exact]], [exact]);
  const result = await resolveIssue('checkout', { target: ' alpha  PROJECT ' }, h.dependencies);
  assert.equal(result.status, 'resolved'); assert.equal(result.query, ' alpha  PROJECT ');
  assert.deepEqual(result.issue, exact);
  assert.equal(h.calls.length, 2);
});

test('duplicate exact tier and a later broader request each return their complete fresh choices', async () => {
  const first = issue(1, 'Qualification selection alpha');
  const second = issue(2, 'Qualification selection alpha', 'closed');
  const third = issue(3, 'Qualification selection alphabet');
  const h = fixture([[first, third], [second]]);
  const exact = await resolveIssue('checkout', { target: 'Qualification selection alpha', current: 99 }, h.dependencies);
  assert.equal(exact.status, 'selection-required'); assert.equal(exact.current, 99);
  assert.deepEqual(exact.candidates, [{ number: 2, title: second.title }, { number: 1, title: first.title }]);
  assert.equal(exact.selection, `[2]: ${second.title}\n[1]: ${first.title}`);
  h.listing([[first, second], [third, { ...issue(4, 'Qualification selection'), pull_request: {} }]]);
  const broad = await resolveIssue('checkout', { target: 'Qualification selection', current: 99 }, h.dependencies);
  assert.equal(broad.target, 'Qualification selection');
  assert.deepEqual(broad.candidates, [{ number: 3, title: third.title }, { number: 2, title: second.title }, { number: 1, title: first.title }]);
  assert.equal(broad.selection, `[3]: ${third.title}\n[2]: ${second.title}\n[1]: ${first.title}`);
  assert.equal(h.calls.length, 2);
});

test('a repeated literal partial query sees candidates added since the previous request', async () => {
  const first = issue(1, 'Qualification selection alpha'), second = issue(2, 'Qualification selection alpha');
  const third = issue(3, 'Qualification selection alphabet', 'closed');
  const h = fixture([[first], [second]]);
  const options = { target: 'Qualification selection' };
  assert.deepEqual((await resolveIssue('checkout', options, h.dependencies)).candidates.map(value => value.number), [2, 1]);
  h.listing([[first, second], [third]]);
  const fresh = await resolveIssue('checkout', options, h.dependencies);
  assert.deepEqual(fresh.candidates.map(value => value.number), [3, 2, 1]);
  assert.equal(fresh.selection, `[3]: ${third.title}\n[2]: ${second.title}\n[1]: ${first.title}`);
  assert.equal(h.calls.length, 2);
});

test('partial-only matches and missing context require selection even for one available issue', async () => {
  const only = issue(5, 'The alpha implementation', 'closed');
  const h = fixture([[only]]);
  for (const options of [{ target: 'alpha' }, {}]) {
    const result = await resolveIssue('checkout', options, h.dependencies);
    assert.equal(result.status, 'selection-required');
    assert.deepEqual(result.candidates, [{ number: 5, title: only.title }]);
    assert.equal(result.selection, '[5]: The alpha implementation');
  }
  h.listing([]);
  assert.deepEqual(await resolveIssue('checkout', {}, h.dependencies), { status: 'selection-required', repository, candidates: [], selection: '' });
});

test('only a successful unmatched name is not-found; it never falls back to current', async () => {
  const h = fixture([[issue(1, 'Current')]], [issue(1, 'Current')]);
  assert.deepEqual(await resolveIssue('checkout', { target: 'missing', current: 1 }, h.dependencies), { status: 'not-found', repository, target: 'missing' });
  await assert.rejects(resolveIssue('checkout', { target: '#99', current: 1 }, h.dependencies), /HTTP 404/);
  assert.equal(h.calls.length, 2);
});

test('foreign URLs, invalid targets, pull requests, API failures and malformed scope remain errors', async () => {
  const h = fixture([], [{ ...issue(4, 'A PR'), pull_request: {} }]);
  for (const target of ['https://github.com/other/project/issues/1', 'https://github.com/example/project/pull/1', 'https://notgithub.com/example/project/issues/1', 'https://github.com:8443/example/project/issues/1', '#0', 'https:/broken', '']) {
    await assert.rejects(resolveIssue('checkout', { target, current: 1 }, h.dependencies));
  }
  assert.equal(h.calls.length, 0);
  await assert.rejects(resolveIssue('checkout', { target: '#4', current: 1 }, h.dependencies), /pull request/);
  const failures = ['authentication failed', 'transport failed'];
  for (const message of failures) {
    const dependencies = { ...h.dependencies, github: { pages: async () => { throw new Error(message); } } };
    await assert.rejects(resolveIssue('checkout', { target: 'name', current: 1 }, dependencies), new RegExp(message));
  }
  await assert.rejects(resolveIssue('checkout', { target: '#1' }, { checkWorkScope: async () => { throw new SyntaxError('malformed conductor.json'); } }), /malformed conductor.json/);
});
