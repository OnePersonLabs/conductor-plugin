import { run } from './process.mjs';
import { createHash } from 'node:crypto';

export class GitHub {
  constructor(repository, { cwd, execute = run } = {}) { this.repository = repository; this.cwd = cwd; this.execute = execute; }
  async gh(args, { input } = {}) { return (await this.execute('gh', args, { cwd: this.cwd, input })).stdout.trim(); }
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
    // Bot-authored reviews are real review input. Exclude only this coordinator's
    // marked publications, which are receipts of work it already processed.
    const human = items => items.filter(x => !x.body?.startsWith('<!-- symphony-lite:'));
    const items = [
      ...human(reviews).filter(x => ['CHANGES_REQUESTED', 'COMMENTED'].includes(x.state) && x.body?.trim() && (!head || x.commit_id === head)).map(x => ({ kind: 'review', id: x.id, body: x.body, head: x.commit_id, updated: x.submitted_at })),
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
  async approvals(number, head) {
    const latest = new Map();
    for (const review of await this.pages(`repos/${this.repository}/pulls/${number}/reviews?per_page=100`)) {
      if (head && review.commit_id !== head) continue;
      if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latest.set(review.user.login, review.state);
    }
    return { approved: [...latest.values()].filter(x => x === 'APPROVED').length, changesRequested: [...latest.values()].includes('CHANGES_REQUESTED') };
  }
  async findReviewReceipt(number, { attempt, head }) {
    const marker = `<!-- symphony-lite:review:${number}:${attempt}:${head} -->`;
    const reviewsPath = `repos/${this.repository}/pulls/${number}/reviews`;
    const review = (await this.pages(`${reviewsPath}?per_page=100`)).find(item => item.body?.includes(marker));
    if (!review) return null;
    if (review.commit_id !== head) throw new Error('A Symphony review receipt exists on a different head; preserve it and reconcile before publishing again.');
    const comments = await this.pages(`repos/${this.repository}/pulls/${number}/comments?per_page=100`);
    return { reviewId: review.id, commentIds: comments.filter(comment => comment.pull_request_review_id === review.id).map(comment => comment.id), marker, head };
  }
  async submitReview(number, { attempt, head, result }) {
    const marker = `<!-- symphony-lite:review:${number}:${attempt}:${head} -->`;
    const rendered = result.findings.map(item => `- [${item.priority}] \`${item.location.path}:${item.location.startLine}\`: ${item.title}\n\n  ${item.body}`).join('\n');
    const body = `${marker}\n${result.status === 'clear' ? 'Independent review completed with no actionable findings.' : 'Independent review found issues to address.'}\n\n${result.summary}${rendered ? `\n\nFindings:\n${rendered}` : ''}`;
    const reviewsPath = `repos/${this.repository}/pulls/${number}/reviews`;
    let prior = await this.findReviewReceipt(number, { attempt, head });
    if (!prior) {
      const diff = result.findings.length ? await this.gh(['pr', 'diff', String(number), '--repo', this.repository, '--color', 'never']) : '';
      const locations = parseChangedLocations(diff);
      const comments = [];
      for (const finding of result.findings) {
        const path = finding.location.path;
        const line = finding.location.endLine;
        if (!locations.get(path)?.has(line)) continue;
        comments.push({ path, line, side: 'RIGHT', body: `${marker}\n[${finding.priority}] ${finding.title}\n\n${finding.body}` });
      }
      const payload = { commit_id: head, event: 'COMMENT', body, ...(comments.length ? { comments } : {}) };
      try { await this.gh(['api', reviewsPath, '--method', 'POST', '--input', '-'], { input: JSON.stringify(payload) }); }
      catch (error) {
        prior = await this.findReviewReceipt(number, { attempt, head });
        if (!prior) throw new Error(`PR review publication is uncertain or was rejected; reconcile its marker before retrying. ${error.message}`);
      }
      prior ??= await this.findReviewReceipt(number, { attempt, head });
      if (!prior) throw new Error('PR review submission returned without a verifiable Symphony receipt.');
    }
    return prior;
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

export function parseChangedLocations(diff) {
  const files = new Map();
  let path = null, line = null, allowed = null;
  for (const row of diff.split(/\r?\n/)) {
    if (row.startsWith('+++ ')) {
      const value = row.slice(4);
      path = value === '/dev/null' ? null : value.startsWith('b/') ? value.slice(2) : value;
      if (path && !files.has(path)) files.set(path, new Set());
      allowed = path ? files.get(path) : null;
      line = null;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (line === null || !allowed || row.startsWith('\\')) continue;
    if (row.startsWith('+')) { allowed.add(line++); continue; }
    if (row.startsWith('-')) continue;
    if (row.startsWith(' ')) { allowed.add(line++); continue; }
    line = null;
  }
  return files;
}
