const fs = require('fs');
const db = require('../db');
const { runAnalysis } = require('../analysis');

/**
 * Processes a single uploaded image end-to-end:
 *   pending -> processing -> (completed | failed)
 *
 * Failure handling: any thrown error here is caught by the queue (queue.js), which retries
 * up to maxAttempts with backoff. If all retries are exhausted, the image row is marked
 * `failed` with a human-readable reason via the 'failed' event listener registered in
 * worker/index.js - the API layer never has to guess why a job died.
 */
async function processImage({ imageId }) {
  const image = db.prepare(`SELECT * FROM images WHERE id = ?`).get(imageId);
  if (!image) throw new Error(`Image ${imageId} not found`);

  const now = new Date().toISOString();
  db.prepare(`UPDATE images SET status='processing', processing_started_at=? WHERE id=?`).run(
    now,
    imageId
  );

  let buffer;
  try {
    buffer = fs.readFileSync(image.storage_path);
  } catch (err) {
    throw new Error(`Could not read stored file: ${err.message}`);
  }

  const result = await runAnalysis({
    buffer,
    mimeType: image.mime_type,
    sha256Hash: image.sha256,
    phash: image.phash,
    imageId: image.id,
  });

  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO analysis_results (image_id, overall_verdict, issues_json, checks_json, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(image_id) DO UPDATE SET
       overall_verdict=excluded.overall_verdict,
       issues_json=excluded.issues_json,
       checks_json=excluded.checks_json,
       created_at=excluded.created_at`
  ).run(image.id, result.overall_verdict, JSON.stringify(result.issues), JSON.stringify(result.checks), createdAt);

  db.prepare(`UPDATE images SET status='completed', processed_at=? WHERE id=?`).run(
    new Date().toISOString(),
    imageId
  );
}

module.exports = { processImage };
