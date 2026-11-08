import { GitHub } from './github.mjs';
import { checkWorkScope } from './repository-setup.mjs';

const normalizedTitle = title => title.trim().replace(/\s+/gu, ' ').toLowerCase();

export function parseIssueTargetArgs(args) {
  const values = [...args], options = {};
  while (values.length) {
    const flag = values.shift();
    const key = flag === '--target' ? 'target' : flag === '--current' ? 'current' : undefined;
    if (!key) throw new Error(`resolve-issue does not accept ${flag}.`);
    if (options[key] !== undefined) throw new Error(`resolve-issue accepts ${flag} only once.`);
    const value = values.shift();
    if (typeof value !== 'string' || !value.trim() || ['--target', '--current'].includes(value)) throw new Error(`${flag} requires a value.`);
    options[key] = key === 'current' ? issueNumber(value, '--current') : value;
  }
  return options;
}

function issueNumber(value, label) {
  const number = typeof value === 'number' ? value : /^\d+$/.test(value ?? '') ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} must be a positive issue number.`);
  return number;
}

function explicitTarget(target, repository) {
  if (typeof target !== 'string' || !target.trim()) throw new Error('--target requires a nonempty issue number, URL or name.');
  const value = target.trim();
  if (/^#?\d+$/.test(value)) return { number: issueNumber(value.replace(/^#/, ''), '--target') };
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) || /^https?:/i.test(value)) {
    let url;
    try { url = new URL(value); } catch { throw new Error('--target is not a valid GitHub issue URL.'); }
    const match = url.pathname.match(/^\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/?$/);
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'github.com' || url.port || url.username || url.password || !match) {
      throw new Error('--target must be a GitHub issue URL in the inspected repository.');
    }
    if (match[1].toLowerCase() !== repository.toLowerCase()) throw new Error('Issue URL belongs to a different repository; no checkout switch or current-issue fallback was attempted.');
    return { number: issueNumber(match[2], '--target') };
  }
  return { name: normalizedTitle(value) };
}

function listIssue(issue) {
  if (!issue || !Number.isSafeInteger(issue.number) || issue.number < 1 || typeof issue.title !== 'string') {
    throw new Error('GitHub returned a malformed issue; resolution was not completed.');
  }
  return issue;
}

async function readIssue(github, number) {
  const issue = listIssue(await github.issue(number));
  if (issue.number !== number || !['open', 'closed'].includes(issue.state)) throw new Error('GitHub returned an unexpected issue snapshot.');
  if (issue.pull_request) throw new Error(`#${number} is a pull request, not an issue.`);
  return issue;
}

// This capability resolves identity only. Every invocation reads fresh GitHub
// state; it neither stores a current issue nor grants authority to mutate one.
export async function resolveIssue(cwd, { target, current } = {}, dependencies = {}) {
  const scope = await (dependencies.checkWorkScope ?? checkWorkScope)(cwd, 'issues');
  const repository = scope.repository;
  const github = dependencies.github ?? new GitHub(repository, { cwd: scope.root });
  const currentNumber = current === undefined ? undefined : issueNumber(current, '--current');
  const explicit = target === undefined ? undefined : explicitTarget(target, repository);
  const number = explicit?.number ?? (explicit === undefined ? currentNumber : undefined);
  if (number !== undefined) {
    const issue = await readIssue(github, number);
    return { status: 'resolved', repository, ...(target === undefined ? { currentUsed: currentNumber } : { query: target }), issue };
  }

  // Fetch every page across both states before matching. State is a later action
  // decision; it must not hide a candidate or select among duplicate titles.
  const values = await github.pages(`repos/${repository}/issues?state=all&per_page=100`);
  if (!Array.isArray(values)) throw new Error('GitHub returned a malformed issue listing.');
  const issues = values.map(listIssue).filter(issue => !issue.pull_request);
  let matches = issues;
  if (explicit) {
    const exact = issues.filter(issue => normalizedTitle(issue.title) === explicit.name);
    if (exact.length === 1) {
      const issue = await readIssue(github, exact[0].number);
      if (normalizedTitle(issue.title) !== explicit.name) throw new Error('Issue title changed during resolution; repeat the literal request before acting.');
      return { status: 'resolved', repository, query: target, issue };
    }
    matches = exact.length ? exact : issues.filter(issue => normalizedTitle(issue.title).includes(explicit.name));
    if (!matches.length) return { status: 'not-found', repository, target };
  }

  const candidates = matches.map(({ number, title }) => ({ number, title })).sort((a, b) => b.number - a.number);
  return {
    status: 'selection-required', repository,
    ...(target === undefined ? {} : { target }), ...(currentNumber === undefined ? {} : { current: currentNumber }),
    candidates, selection: candidates.map(issue => `[${issue.number}]: ${issue.title}`).join('\n'),
  };
}
