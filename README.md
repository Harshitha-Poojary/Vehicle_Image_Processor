# Vehicle Image Processor

Async backend for uploading field vehicle images and analyzing them for common data-quality
issues (blur, low light, duplicates, screenshots, tampering, invalid plate format).

## Quick start

```bash
npm install
npm start
# -> Vehicle image processor listening on http://localhost:3000
```

No external services required — SQLite is a file (`data.sqlite`, created on first run) and
the job queue is in-process. `tesseract.js` is an optional dependency; if it's missing or
can't initialize (e.g. no network to fetch language data), the plate check degrades
gracefully instead of failing the whole pipeline (see "Handling uncertainty" below).

### Try it

```bash
curl -F "image=@/path/to/vehicle.jpg" http://localhost:3000/api/images
# -> {"id":"...", "status":"pending", "status_url":"/api/images/<id>/status", ...}

curl http://localhost:3000/api/images/<id>/status
curl http://localhost:3000/api/images/<id>/result
curl http://localhost:3000/api/images?limit=10
```

---

## Architecture

```
Client
  │  POST /api/images (multipart)
  ▼
Express route ──► validate (mime/size/decodable) ──► store file + row (status=pending)
  │                                                          │
  │  202 Accepted {id, status_url, result_url}                │ enqueue({imageId})
  ▼                                                          ▼
Client polls status/result                          In-memory job queue (durable-mirrored)
                                                              │
                                                              ▼
                                                   Worker: processImage(imageId)
                                                     status -> processing
                                                     run 6 checks in parallel
                                                     write analysis_results
                                                     status -> completed | failed
```

The upload request never touches image analysis — it returns as soon as the file is
validated and durably written, which is the entire point of doing this asynchronously
(large images / slow checks like OCR shouldn't hold an HTTP connection open, and a slow
check shouldn't block the next upload).

### Why an in-memory queue instead of BullMQ/SQS/RabbitMQ

For this reference build, avoiding a Redis/broker dependency means the whole system runs
with `npm install && npm start` and is easy to read end to end. The tradeoffs were
deliberate, not accidental:

- **Interface parity, not a toy.** `queue.js` exposes `enqueue()` / `process(handler)` with
  concurrency and retry/backoff — the same shape as a BullMQ worker or an SQS consumer loop.
  Swapping the implementation later (see `src/queue/queue.js` header comment) is a localized
  change, not a redesign.
- **Durability without a broker.** Every enqueue is mirrored into a `jobs` table, and on
  startup (`src/worker/index.js`) any image left in `pending`/`processing` from a previous
  run is automatically re-enqueued. A pure in-memory array would silently lose work on
  crash/restart; this doesn't.
- **When to actually switch:** multiple worker processes/machines (need a shared broker),
  delayed/scheduled jobs, priority queues, or a dashboard for ops — reach for BullMQ+Redis
  (single region) or SQS (serverless/multi-region). The processing logic in
  `worker/processImage.js` wouldn't need to change at all.

### Why SQLite instead of Postgres/MySQL/Mongo

Same reasoning as above: zero setup, synchronous driver keeps the worker code simple to
read. The schema (see below) is plain relational SQL with no SQLite-specific features
(besides `WAL` mode for concurrent read/write), so moving to Postgres is a driver swap, not
a schema rewrite. For real multi-worker concurrency, Postgres's
`SELECT ... FOR UPDATE SKIP LOCKED` on the `jobs` table would replace the in-process queue's
locking entirely.

---

## Schema

**`images`** — one row per upload, source of truth for status.

| column | notes |
|---|---|
| `id` | UUID, primary key |
| `original_filename`, `stored_filename`, `storage_path` | upload metadata + where the file actually lives |
| `mime_type`, `size_bytes`, `width`, `height` | basic technical metadata, captured at upload time |
| `sha256` | exact-content hash — cheap, instant exact-duplicate detection |
| `phash` | 64-bit perceptual hash (aHash) — near-duplicate detection |
| `status` | `pending` \| `processing` \| `completed` \| `failed` |
| `failure_reason` | populated only when `status = failed` |
| `attempts` | retry count (mirrors the durable `jobs` row) |
| `uploaded_at` / `processing_started_at` / `processed_at` | lifecycle timestamps |

**`analysis_results`** — one row per image, written once processing completes.

| column | notes |
|---|---|
| `image_id` | FK to `images`, unique (1:1) |
| `overall_verdict` | `clean` \| `needs_review` \| `rejected` |
| `issues_json` | structured array — what a consuming system/UI should act on |
| `checks_json` | full raw output of every check — audit trail / debugging, not meant for the UI |

**`jobs`** — durable mirror of the in-memory queue, purely for crash recovery and audit
(when was this retried, how many times, what was the last error).

Splitting `issues` (curated, actionable) from `checks` (raw, exhaustive) was a deliberate
schema decision: a caller building a review UI wants the former; someone debugging a bad
verdict wants the latter, and neither should have to parse the other's shape.

---

## Analysis checks

Each check returns its own `confidence` and, where relevant, a `reliability` label — the
brief is explicit that this isn't about ML accuracy, it's about structuring uncertainty
honestly. No check asserts a bare `true/false` without a confidence attached to it.

| Check | Method | Notes |
|---|---|---|
| **Blur** | Variance of Laplacian (edge-response variance) | Classic, dependency-free focus measure. Threshold needs tuning against real field photos. |
| **Brightness** | Mean luma from image stats | Flags `low_light` / `overexposed` / `normal`. |
| **Duplicate** | SHA-256 (exact) + aHash Hamming distance (near-duplicate) against all prior uploads | Exact match → high confidence; near-duplicate confidence scales with hash distance. |
| **Screenshot** | Absence of camera EXIF + aspect ratio matching common screen ratios + density hint | Combined signal, not a single tell — reported at `medium` reliability. |
| **Photo-of-photo** | Explicitly *not* solved by a strong heuristic here | Reported as low-confidence/low-reliability with a stated reason, rather than faking certainty. Real solution needs frequency/moire analysis or a trained classifier — noted in code as a follow-up, not silently guessed at. |
| **Possible editing (tamper)** | Simplified Error Level Analysis (JPEG recompression diff, block-wise hotspot detection) | JPEG-only (no natural compression history in PNG); capped confidence, framed as "a lead for review" not a forensic verdict. |
| **Vehicle plate format** | OCR (tesseract.js, pluggable) + regex for standard/BH-series Indian plates | If OCR can't initialize, reported as `vehicle_number_unverified` (unknown), never silently reported as invalid. |

### Handling uncertainty (the actual point of the exercise)

Three deliberate patterns run through every check:

1. **Confidence is always attached, and capped honestly.** The tamper and photo-of-photo
   checks specifically cap their own confidence low (`0.3`–`0.75`) because the underlying
   heuristic genuinely can't support more than that — the code comments explain *why*, so a
   future maintainer doesn't quietly bump the threshold without understanding the tradeoff.
2. **"Can't tell" is a distinct outcome from "false".** If OCR can't run, the plate result is
   `format_valid: null` / `vehicle_number_unverified`, not `false`. If a check can't apply
   (ELA on a PNG), it returns `applicable: false` with a reason. Collapsing "unknown" into
   "no issue" would be a worse system, not a simpler one.
3. **Verdict severity is a documented, simple state machine** (`src/analysis/index.js`):
   any `high` severity issue → `rejected`; any `medium` → `needs_review`; otherwise `clean`.
   `low`-severity/low-reliability findings (like photo-of-photo suspicion) are still surfaced
   in `issues[]` so a reviewer can see them, but don't by themselves force a rejection.

---

## API

### `POST /api/images`
`multipart/form-data`, field `image` (jpeg/png/webp, ≤15MB).

```json
202 Accepted
{
  "id": "b3f1...",
  "status": "pending",
  "uploaded_at": "2026-07-21T10:00:00.000Z",
  "status_url": "/api/images/b3f1.../status",
  "result_url": "/api/images/b3f1.../result"
}
```

### `GET /api/images/:id/status`
```json
{
  "id": "b3f1...",
  "status": "processing",
  "failure_reason": null,
  "uploaded_at": "...",
  "processing_started_at": "...",
  "processed_at": null,
  "attempts": 0
}
```

### `GET /api/images/:id/result`
While incomplete, returns the current status instead of a 404/error (the job is real, just
not done). Once `completed`:

```json
{
  "id": "b3f1...",
  "status": "completed",
  "overall_verdict": "needs_review",
  "issues": [
    {
      "type": "low_light",
      "severity": "medium",
      "confidence": 0.71,
      "detail": "Mean luma 42.10 indicates a dark/underexposed capture."
    }
  ],
  "checks": { "...": "full raw output of every check, for audit/debugging" },
  "metadata": { "original_filename": "...", "mime_type": "image/jpeg", "...": "..." },
  "uploaded_at": "...",
  "processed_at": "..."
}
```

If `status = failed`, returns `{ id, status, failure_reason }` instead.

### `GET /api/images?limit=&offset=`
Paginated list, newest first.

---

## Failure handling

- Upload-time failures (bad mime type, corrupt/undecodable file, oversized file) are
  rejected synchronously with `400` — no point queuing a job that can't succeed.
- Processing-time failures (e.g. disk read error) are retried up to 3 times with backoff by
  the queue; after the final failure, `images.status` is set to `failed` with a concrete
  `failure_reason` string, so `/status` and `/result` always explain *why*, not just *that*
  it failed.
- Process crash mid-job: on restart, any `pending`/`processing` image is automatically
  re-enqueued (see `src/worker/index.js`) — nothing is silently lost.

## Known limitations / next steps

- Thresholds (blur variance, brightness bounds, ELA hotspot fraction) are reasonable
  starting points, not calibrated against a labeled dataset — that calibration is the
  natural next step before relying on this for auto-rejection.
- Photo-of-photo detection is intentionally left weak rather than faking confidence; a real
  version needs frequency-domain/moire analysis or a small trained classifier.
- Storage is local disk; swapping `storage_path` for an S3/GCS key is a small, contained
  change (only `routes/images.js` and `worker/processImage.js` touch the filesystem).
- Single-process worker concurrency (2) is configurable in `src/queue/queue.js`; true
  horizontal scaling needs the Postgres/BullMQ swap described above.
