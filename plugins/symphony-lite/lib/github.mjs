import { run } from './process.mjs';
import { createHash } from 'node:crypto';

export class GitHub {
  constructor(repository, { cwd, execute = run } = {}) { this.repository = repository; this.cwd = cwd; this.execute = execute; }
  async gh(args) { return (await this.execute('gh', args, { cwd: this.cwd })).stdout.trim(); }
  async api(path, { method, fields } = {}) {
    const args = ['api', path, '-H', 'Accept: application/vnd.github+json'];
    if (method) args.push('--method', method);
    for (const [key, value] of Object.entries(fields ?? {})) args.push('-f', `${key}=${value}`);
    const text = await this.gh(args); return text ? JSON.parse(text) : null;
  }
  async pages(path) { const text = await this.gh(['api', path, '--paginate', '--slurp']); return JSON.parse(text).flat(); }
  async ready(label) {
    return (await this.pages(`repos/${this.repository}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`)).filter(x => !x.pull_request);
  }
  async issue(number) { return this.api(`repos/${this.repository}/issues/${number}`); }
  async blockers(number) { return (await this.pages(`repos/${this.repository}/issues/${number}/dependencies/blocked_by?per_page=100`)).filter(x => x.state === 'open'); }
  async pullForBranch(branch) {
    const head = `${this.repository.split('/')[0]}:${branch}`;
    const pulls = await this.pages(`repos/${this.repository}/pulls?state=all&head=${encodeURIComponent(head)}&per_page=100`);
    if (pulls.length > 1) throw new Error(`Multiple PRs own branch ${branch}; reconcile before continuing.`);
    return pulls[0] ?? null;
  }
  async pull(number) {
    return JSON.parse(await this.gh(['pr', 'view', String(number), '--repo', this.repository, '--json', 'number,url,state,isDraft,headRefOid,baseRefName,mergeCommit,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,autoMergeRequest']));
  }
  async feedback(number, head) {
    const [reviews, comments, conversation] = await Promise.all([
      this.pages(`repos/${this.repository}/pulls/${number}/reviews?per_page=100`),
      this.pages(`repos/${this.repository}/pulls/${number}/comments?per_page=100`),
      this.pages(`repos/${this.repository}/issues/${number}/comments?per_page=100`),
    ]);
    const human = items => items.filter(x => x.user?.type !== 'Bot' && !x.body?.startsWith('<!-- symphony-lite:'));
    const items = [
      ...human(reviews).filter(x => x.state === 'CHANGES_REQUESTED' && (!head || x.commit_id === head)).map(x => ({ kind: 'review', id: x.id, body: x.body, head: x.commit_id, updated: x.submitted_at })),
      ...human(comments).filter(x => (!head || x.commit_id === head) && x.position !== null).map(x => ({ kind: 'comment', id: x.id, body: x.body, head: x.commit_id, updated: x.updated_at })),
      ...human(conversation).map(x => ({ kind: 'conversation', id: x.id, body: x.body, updated: x.updated_at })),
    ].sort((a,b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
    return { items, hash: createHash('sha256').update(JSON.stringify(items)).digest('hex') };
  }
  async createPull(job, issue) {
    const existing = await this.pullForBranch(job.branch);
    if (existing) return existing;
    // No closing keyword: the coordinator reconciles acceptance after actual landing.
    const body = `Addresses #${issue.number}.\n\n${job.summary ?? 'Implementation and verification by Symphony Lite.'}\n\nSymphony Lite retains the original builder for repairs. Issue closure follows verified landing and acceptance.`;
    try { await this.gh(['pr', 'create', '--repo', this.repository, '--base', job.baseBranch, '--head', job.branch, '--title', issue.title, '--body', body]); }
    catch (error) { const found = await this.pullForBranch(job.branch); if (!found) throw error; return found; }
    const found = await this.pullForBranch(job.branch);
    if (!found) throw new Error('PR creation outcome is uncertain; no replacement PR was created.');
    return found;
  }
  async approvals(number) {
    const latest = new Map();
    for (const review of await this.pages(`repos/${this.repository}/pulls/${number}/reviews?per_page=100`)) {
      if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latest.set(review.user.login, review.state);
    }
    return { approved: [...latest.values()].filter(x => x === 'APPROVED').length, changesRequested: [...latest.values()].includes('CHANGES_REQUESTED') };
  }
  async progress(job) {
    const marker = `<!-- symphony-lite:${job.issue} -->`;
    const comments = await this.pages(`repos/${this.repository}/issues/${job.issue}/comments?per_page=100`);
    const existing = comments.filter(x => x.body?.startsWith(marker));
    if (existing.length > 1) throw new Error(`Multiple Symphony Lite ownership records for issue ${job.issue}; reconcile them.`);
    const body = `${marker}\nSymphony Lite: **${job.phase}**\n\nBranch: \`${job.branch}\`${job.pr ? `; PR #${job.pr}` : ''}.\n\n${job.summary ?? 'Original builder owns this issue through delivery.'}`;
    if (existing[0]?.body === body) return;
    const path = existing[0] ? `repos/${this.repository}/issues/comments/${existing[0].id}` : `repos/${this.repository}/issues/${job.issue}/comments`;
    try { await this.api(path, { method: existing[0] ? 'PATCH' : 'POST', fields: { body } }); }
    catch (error) {
      const after = await this.pages(`repos/${this.repository}/issues/${job.issue}/comments?per_page=100`);
      if (!after.some(x => x.body === body)) throw error;
    }
  }
  async merge(number, head, method) { return this.gh(['pr', 'merge', String(number), '--repo', this.repository, '--auto', `--${method}`, '--match-head-commit', head]); }
  async disableAutoMerge(number) { return this.gh(['pr', 'merge', String(number), '--repo', this.repository, '--disable-auto']); }
  async closeIssue(number, summary) {
    if ((await this.issue(number)).state === 'closed') return;
    await this.gh(['issue', 'close', String(number), '--repo', this.repository, '--reason', 'completed', '--comment', summary]);
  }
}

export function checkState(pull) {
  const checks = pull.statusCheckRollup ?? [];
  const failed = checks.filter(x => ['FAILURE','ERROR','CANCELLED','TIMED_OUT','ACTION_REQUIRED','STARTUP_FAILURE'].includes(x.conclusion ?? x.state));
  const pending = checks.some(x => x.__typename === 'StatusContext' ? x.state === 'PENDING' || x.state === 'EXPECTED' : x.status !== 'COMPLETED');
  return { failed, pending };
}
