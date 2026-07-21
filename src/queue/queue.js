/**
 * Minimal in-process job queue.
 *
 * Why a custom in-memory queue instead of BullMQ/SQS/RabbitMQ for this reference build:
 *   - No extra infrastructure (Redis/broker) required to run or review the system.
 *   - The *interface* (enqueue / onProcess / concurrency / retry) mirrors what BullMQ or an
 *     SQS consumer looks like, so swapping the implementation later is a drop-in change,
 *     not a redesign. Every job is also persisted in the `jobs` table (see db.js), so this
 *     is closer to "durable queue with an in-memory dispatcher" than a naive array that
 *     loses work on crash.
 *
 * Production swap-in:
 *   - Single machine, higher durability: BullMQ + Redis (gives you delayed jobs, priorities,
 *     rate limiting, dashboards for free).
 *   - Multi-region / serverless workers: SQS + a worker fleet (visibility timeout takes care
 *     of "processing" -> retry semantics that we hand-roll below).
 *   - Either way, only this file and worker/index.js's registration call would change.
 */
const EventEmitter = require('events');
const db = require('../db');

class InMemoryQueue extends EventEmitter {
  constructor({ concurrency = 2, maxAttempts = 3 } = {}) {
    super();
    this.concurrency = concurrency;
    this.maxAttempts = maxAttempts;
    this.queue = [];
    this.active = 0;
    this.handler = null;
  }

  /** Register the function that processes one job payload. */
  process(handler) {
    this.handler = handler;
    this._drain();
  }

  /** Add a job. `payload` must be JSON-serializable (we only pass an imageId). */
  enqueue(payload) {
    const now = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO jobs (image_id, status, attempts, created_at, updated_at)
         VALUES (?, 'queued', 0, ?, ?)`
      )
      .run(payload.imageId, now, now);

    this.queue.push({ jobId: info.lastInsertRowid, payload, attempts: 0 });
    this._drain();
    return info.lastInsertRowid;
  }

  _drain() {
    if (!this.handler) return;
    while (this.active < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      this._run(job);
    }
  }

  async _run(job) {
    this.active++;
    job.attempts++;
    const now = () => new Date().toISOString();
    db.prepare(`UPDATE jobs SET status='active', attempts=?, updated_at=? WHERE id=?`).run(
      job.attempts,
      now(),
      job.jobId
    );

    try {
      await this.handler(job.payload);
      db.prepare(`UPDATE jobs SET status='done', updated_at=? WHERE id=?`).run(now(), job.jobId);
      this.emit('completed', job);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      if (job.attempts < this.maxAttempts) {
        db.prepare(
          `UPDATE jobs SET status='queued', last_error=?, updated_at=? WHERE id=?`
        ).run(message, now(), job.jobId);
        // simple backoff: re-queue after attempts * 500ms
        setTimeout(() => {
          this.queue.push(job);
          this._drain();
        }, job.attempts * 500);
      } else {
        db.prepare(
          `UPDATE jobs SET status='failed', last_error=?, updated_at=? WHERE id=?`
        ).run(message, now(), job.jobId);
        this.emit('failed', job, err);
      }
    } finally {
      this.active--;
      this._drain();
    }
  }
}

module.exports = new InMemoryQueue({ concurrency: 2, maxAttempts: 3 });
