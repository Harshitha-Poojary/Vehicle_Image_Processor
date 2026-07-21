const db = require('../db');
const queue = require('../queue/queue');
const { processImage } = require('./processImage');

function startWorker() {
  queue.process(processImage);

  queue.on('failed', (job, err) => {
    const message = err && err.message ? err.message : String(err);
    db.prepare(`UPDATE images SET status='failed', failure_reason=? WHERE id=?`).run(
      message,
      job.payload.imageId
    );
  });

  // Crash recovery: if the process restarted while jobs were pending/processing, the
  // in-memory queue is empty on boot even though the DB still says work is outstanding.
  // Re-enqueue anything left in pending/processing so it isn't silently stuck forever.
  const stuck = db
    .prepare(`SELECT id FROM images WHERE status IN ('pending', 'processing')`)
    .all();
  for (const row of stuck) {
    queue.enqueue({ imageId: row.id });
  }
  if (stuck.length) {
    console.log(`[worker] recovered ${stuck.length} unfinished job(s) from a previous run`);
  }
}

module.exports = { startWorker };
