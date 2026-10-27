import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const EVENTS = new Set(['UserPromptSubmit', 'PostToolUse', 'Stop', 'Interrupt']);
const MARKER = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function identity(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new TypeError(`${field} must be a nonempty string of at most 512 characters.`);
  return value;
}

/**
 * Durable native activity state for one or more director threads. This stores
 * host lifecycle facts only; issue/event work remains in Conductor's JSON state.
 */
export class DirectorActivity {
  constructor({ dir }) {
    if (typeof dir !== 'string' || !dir.trim()) throw new TypeError('dir must be a nonempty path.');
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, 'director-activity.sqlite'), { timeout: 1000 });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS director_activity (
        thread_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('active', 'idle', 'interrupted')),
        turn_id TEXT NOT NULL,
        wakeup_marker TEXT,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare('PRAGMA table_info(director_activity)').all().some(column => column.name === 'wakeup_marker')) {
        this.db.exec('ALTER TABLE director_activity ADD COLUMN wakeup_marker TEXT');
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }

  async read(threadId) {
    identity(threadId, 'threadId');
    const row = this.db.prepare('SELECT state, turn_id, wakeup_marker, revision FROM director_activity WHERE thread_id = ?').get(threadId);
    if (!row) return { state: 'unknown', turnId: null, wakeupMarker: null, revision: 0 };
    return { state: row.state, turnId: row.turn_id, wakeupMarker: row.wakeup_marker, revision: row.revision };
  }

  async record({ threadId, turnId, event, wakeupMarker = null }) {
    identity(threadId, 'threadId');
    identity(turnId, 'turnId');
    if (!EVENTS.has(event)) throw new TypeError(`Unsupported director activity event: ${String(event)}`);
    if (wakeupMarker !== null && (typeof wakeupMarker !== 'string' || !MARKER.test(wakeupMarker))) throw new TypeError('wakeupMarker must be a UUID or null.');
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT state, turn_id, wakeup_marker, revision FROM director_activity WHERE thread_id = ?').get(threadId);
      if (event === 'UserPromptSubmit') {
        if (current?.state !== 'active' || current.turn_id !== turnId) {
          this.db.prepare(`INSERT INTO director_activity(thread_id, state, turn_id, wakeup_marker, revision, updated_at)
            VALUES(?, 'active', ?, ?, 1, ?)
            ON CONFLICT(thread_id) DO UPDATE SET state='active', turn_id=excluded.turn_id,
              wakeup_marker=excluded.wakeup_marker, revision=director_activity.revision + 1, updated_at=excluded.updated_at`).run(threadId, turnId, wakeupMarker, now);
        }
      } else if (event === 'PostToolUse' && !current) {
        this.db.prepare(`INSERT INTO director_activity(thread_id, state, turn_id, wakeup_marker, revision, updated_at)
          VALUES(?, 'active', ?, NULL, 1, ?)`).run(threadId, turnId, now);
      } else if (event === 'PostToolUse' && current?.state === 'active' && current.turn_id === turnId) {
        // The bound thread may be enrolled during its first turn. A late tool
        // hook may establish that turn, but never supersedes a newer one.
      } else if (event === 'PostToolUse') {
        // Late tool receipts cannot replace newer turns or clear an interrupt.
      } else if (current?.state === 'active' && current.turn_id === turnId) {
        const state = event === 'Stop' ? 'idle' : 'interrupted';
        this.db.prepare(`UPDATE director_activity SET state = ?, revision = revision + 1, updated_at = ?
          WHERE thread_id = ? AND turn_id = ? AND state = 'active'`).run(state, now, threadId, turnId);
      }
      const row = this.db.prepare('SELECT state, turn_id, wakeup_marker, revision FROM director_activity WHERE thread_id = ?').get(threadId);
      this.db.exec('COMMIT');
      return row ? { state: row.state, turnId: row.turn_id, wakeupMarker: row.wakeup_marker, revision: row.revision } : { state: 'unknown', turnId: null, wakeupMarker: null, revision: 0 };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    if (this.db.isOpen) this.db.close();
  }
}
