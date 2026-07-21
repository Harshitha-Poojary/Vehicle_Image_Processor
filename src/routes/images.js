const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');

const db = require('../db');
const queue = require('../queue/queue');
const { sha256, perceptualHash } = require('../utils/hash');

const router = express.Router();

const STORAGE_DIR = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_SIZE_BYTES = 15 * 1024 * 1024; // 15MB

const upload = multer({
  storage: multer.memoryStorage(), // buffer first so we can hash/inspect before touching disk
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: jpeg, png, webp.`));
    }
    cb(null, true);
  },
});

/**
 * POST /api/images
 * multipart/form-data, field name: "image"
 * Optional field: "vehicle_id" (free-text tag from the field app, stored alongside metadata)
 *
 * Contract: this returns as soon as the file is validated and durably stored - it never
 * waits on analysis. That's the whole point of the async design.
 */
router.post('/', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded. Expected multipart field "image".' });
    }

    const buffer = req.file.buffer;

    // Validate it's actually a decodable image (mimetype header can be spoofed/wrong).
    let metadata;
    try {
      metadata = await sharp(buffer).metadata();
    } catch (err) {
      return res.status(400).json({ error: 'File is not a valid/decodable image.' });
    }

    const id = uuidv4();
    const ext = req.file.mimetype === 'image/png' ? '.png' : req.file.mimetype === 'image/webp' ? '.webp' : '.jpg';
    const storedFilename = `${id}${ext}`;
    const storagePath = path.join(STORAGE_DIR, storedFilename);
    fs.writeFileSync(storagePath, buffer);

    const hash = sha256(buffer);
    const phash = await perceptualHash(buffer);
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO images
        (id, original_filename, stored_filename, storage_path, mime_type, size_bytes,
         sha256, phash, width, height, status, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(
      id,
      req.file.originalname,
      storedFilename,
      storagePath,
      req.file.mimetype,
      buffer.length,
      hash,
      phash,
      metadata.width || null,
      metadata.height || null,
      now
    );

    queue.enqueue({ imageId: id });

    res.status(202).json({
      id,
      status: 'pending',
      uploaded_at: now,
      status_url: `/api/images/${id}/status`,
      result_url: `/api/images/${id}/result`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/images/:id/status - lightweight polling endpoint */
router.get('/:id/status', (req, res) => {
  const row = db
    .prepare(`SELECT id, status, failure_reason, uploaded_at, processing_started_at, processed_at, attempts
              FROM images WHERE id = ?`)
    .get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Image not found' });
  res.json(row);
});

/** GET /api/images/:id/result - full structured analysis (once completed) */
router.get('/:id/result', (req, res) => {
  const image = db.prepare(`SELECT * FROM images WHERE id = ?`).get(req.params.id);
  if (!image) return res.status(404).json({ error: 'Image not found' });

  if (image.status === 'failed') {
    return res.status(200).json({
      id: image.id,
      status: 'failed',
      failure_reason: image.failure_reason,
    });
  }
  if (image.status !== 'completed') {
    return res.status(200).json({
      id: image.id,
      status: image.status,
      message: 'Analysis not yet complete. Poll /status or retry shortly.',
    });
  }

  const result = db.prepare(`SELECT * FROM analysis_results WHERE image_id = ?`).get(image.id);
  if (!result) {
    return res.status(500).json({ error: 'Image marked completed but result row is missing (inconsistent state).' });
  }

  res.json({
    id: image.id,
    status: image.status,
    overall_verdict: result.overall_verdict,
    issues: JSON.parse(result.issues_json),
    checks: JSON.parse(result.checks_json),
    metadata: {
      original_filename: image.original_filename,
      mime_type: image.mime_type,
      size_bytes: image.size_bytes,
      width: image.width,
      height: image.height,
      sha256: image.sha256,
    },
    uploaded_at: image.uploaded_at,
    processed_at: image.processed_at,
  });
});

/** GET /api/images - list, newest first (basic pagination) */
router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = parseInt(req.query.offset) || 0;
  const rows = db
    .prepare(
      `SELECT id, original_filename, status, uploaded_at, processed_at FROM images
       ORDER BY uploaded_at DESC LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
  res.json({ items: rows, limit, offset });
});

module.exports = router;
