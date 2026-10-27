import { orderedIssues } from './config.mjs';

export const TERMINAL = new Set(['complete', 'cancelled']);
export function occupied(jobs) { return jobs.filter(job => !TERMINAL.has(job.phase)).length; }
export function admission(issues, jobs, config) {
  const known = new Set(jobs.map(job => job.issue));
  return orderedIssues(issues, config.priorityLabels).filter(issue => !known.has(issue.number)).slice(0, Math.max(0, config.agents - occupied(jobs)));
}

// Wake requests arriving during a scan collapse to one further pass.
export class WakeLoop {
  constructor(scan, onError = () => {}) { this.scan = scan; this.onError = onError; this.running = false; this.pending = false; this.closed = false; this.done = Promise.resolve(); }
  wake() {
    if (this.closed) return this.done;
    this.pending = true;
    if (this.running) return this.done;
    this.running = true;
    this.done = (async () => {
      try { while (this.pending && !this.closed) { this.pending = false; try { await this.scan(); } catch (error) { this.onError(error); } } }
      finally { this.running = false; }
    })();
    return this.done;
  }
  async close() { this.closed = true; this.pending = false; await this.done; }
}
