// Durable job queue on the database: jobs survive restarts, failed jobs retry with backoff.
// Production swap: BullMQ + Redis in a separate worker process; same enqueue/handler shape.
import crypto from 'node:crypto';

export class PermanentError extends Error {}   // don't retry (e.g. the customer blocked the bot)

export function createQueue(db, handlers, { log = console, maxAttempts = 5, idleMs = 300 } = {}) {
  const now = () => new Date().toISOString();
  db.prepare("UPDATE jobs SET status = 'queued' WHERE status = 'running'").run();   // recover after a crash
  const claim = db.prepare(`UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ?
    WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= ? ORDER BY run_at LIMIT 1) RETURNING *`);
  let running = false;

  function enqueue(kind, payload, delayMs = 0) {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO jobs (id, kind, payload, run_at) VALUES (?,?,?,?)').run(id, kind, JSON.stringify(payload), new Date(Date.now() + delayMs).toISOString());
    return id;
  }

  async function runOnce() {
    const t = now();
    const job = claim.get(t, t);
    if (!job) return false;
    try {
      await handlers[job.kind](JSON.parse(job.payload));
      db.prepare("UPDATE jobs SET status = 'done', updated_at = ?, last_error = NULL WHERE id = ?").run(now(), job.id);
    } catch (e) {
      const final = e instanceof PermanentError || job.attempts >= maxAttempts;
      const retryAt = new Date(Date.now() + 2 ** job.attempts * 1000).toISOString();
      db.prepare('UPDATE jobs SET status = ?, run_at = ?, last_error = ?, updated_at = ? WHERE id = ?')
        .run(final ? 'failed' : 'queued', final ? job.run_at : retryAt, String(e.message).slice(0, 500), now(), job.id);
      log.error?.(`[job ${job.kind}] ${final ? 'failed' : 'will retry'}: ${e.message}`);
    }
    return true;
  }

  async function drain() { while (await runOnce()); }   // tests and scripts

  async function start() {
    running = true;
    while (running) { if (!(await runOnce())) await new Promise(r => setTimeout(r, idleMs)); }
  }
  return { enqueue, runOnce, drain, start, stop: () => { running = false; } };
}
