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

### Run with Docker

```bash
docker build -t vehicle-image-processor .
docker run -p 3000:3000 -v $(pwd)/data:/app/data vehicle-image-processor
```

This runs the app exactly as it runs locally — SQLite file + in-process queue, no other
containers required. The `-v` mount keeps `data.sqlite` and uploaded files outside the
container so they survive a restart.

> **Note on `docker-compose.yml`:** this repo also includes a `docker-compose.yml` that
> provisions Postgres, Redis, and MinIO. That file is a **scaffold for the next scaling
> step**, not the current running architecture — `package.json` doesn't yet include a
> Postgres driver, a Redis client, or an S3 client, so the `app` service in that compose
> file would start but wouldn't actually talk to those three containers. See
> [Trade-offs](#trade-offs) for what wiring that up would involve. Until then, use the
> plain `docker build`/`docker run` commands above, or `npm install && npm start`.

---

## Service flow

End-to-end, from a client's point of view:

```
1. Client POSTs an image  ──────────────►  2. Server validates synchronously
                                               (mime type, size ≤15MB, decodable)
                                               │
                            ┌──────────────────┘
                            ▼
                  3. File written to disk + `images` row created (status=pending)
                            │
                            ▼
                  4. 202 Accepted returned immediately
                     { id, status_url, result_url }
                            │
                            ▼
      5. Client polls status_url / result_url until status is completed|failed
```

The upload request never waits on analysis. It returns as soon as the file is validated
and durably written — that's the whole point of doing this asynchronously: large images and
slow checks (OCR in particular) shouldn't hold an HTTP connection open, and one slow image
shouldn't block the next upload from being accepted.

## Processing flow

What happens after the row is enqueued, entirely off the request path:

```
enqueue({ imageId })
        │
        ▼
In-memory queue picks it up (worker pool, concurrency = 2)
        │
        ▼
status -> processing (processing_started_at set)
        │
        ▼
Run all 6 checks in parallel:
  blur · brightness · duplicate · screenshot · photo-of-photo · tamper (+ plate OCR)
        │
        ▼
Combine into overall_verdict via severity state machine:
  any `high` severity  -> rejected
  any `medium`          -> needs_review
  otherwise             -> clean
        │
        ▼
Write `analysis_results` row (issues_json + checks_json)
        │
        ▼
status -> completed   (or -> failed, with failure_reason, on unrecoverable error)
```

Each check is independent and returns its own `confidence` (and often a `reliability`
label) rather than a bare pass/fail — see [Handling uncertainty](#handling-uncertainty-the-actual-point-of-the-exercise).

---

## Queue strategy

The queue is in-process (`src/queue/queue.js`), not a broker, but it's built to the same
interface a real broker-backed queue would have:

- `enqueue(job)` / `process(handler)`, with configurable concurrency and retry/backoff —
  the same shape as a BullMQ worker or an SQS consumer loop.
- **Durability without a broker.** Every enqueue is mirrored into a `jobs` table. On startup
  (`src/worker/index.js`), any image left in `pending`/`processing` from a previous run is
  automatically re-enqueued — a crash mid-job doesn't silently lose work, which a plain
  in-memory array would.
- **Retries.** Processing failures are retried up to 3 times with backoff; only after the
  final attempt fails does `images.status` become `failed`, with a concrete
  `failure_reason` recorded.
- **Why not BullMQ/SQS/RabbitMQ now:** avoiding a Redis/broker dependency means the whole
  system runs with just `npm install && npm start`, which matters for a reference build
  meant to be read end to end. The decision is reversible on purpose — `processImage.js`
  (the actual check logic) wouldn't change at all if the queue implementation were swapped
  out; only `queue.js`'s internals would.
- **When to actually switch:** multiple worker processes/machines (needs a shared broker),
  delayed/scheduled jobs, priority queues, or an ops dashboard. At that point Postgres's
  `SELECT ... FOR UPDATE SKIP LOCKED` on the `jobs` table would replace the in-process
  queue's locking, or a real broker (BullMQ+Redis, SQS) would take over.

---

## Major design decisions

### Why SQLite instead of Postgres/MySQL/Mongo
Zero setup, synchronous driver keeps the worker code simple to read end to end. The schema
is plain relational SQL with no SQLite-specific features besides `WAL` mode for concurrent
read/write, so moving to Postgres later is a driver swap, not a schema rewrite.

### Splitting `issues` from `checks`
`analysis_results` stores a curated `issues_json` (what a consuming system/UI should act
on) separately from a raw `checks_json` (full output of every check, for audit/debugging).
A caller building a review UI wants the former; someone debugging a bad verdict wants the
latter — neither should have to parse the other's shape out of one blob.

### Confidence over booleans
No check is allowed to assert a bare `true`/`false`. This is discussed in full under
[Handling uncertainty](#handling-uncertainty-the-actual-point-of-the-exercise) below — it's
the central design decision of the whole analysis layer, not a minor detail.

### Synchronous validation, asynchronous analysis
Upload-time failures (bad mime type, corrupt file, oversized file) are rejected
synchronously with `400` — there's no reason to enqueue a job that can't possibly succeed.
Everything past "this is a decodable image" is async.

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

---

## Analysis checks

| Check | Method | Notes |
|---|---|---|
| **Blur** | Variance of Laplacian (edge-response variance) | Classic, dependency-free focus measure. Threshold needs tuning against real field photos. |
| **Brightness** | Mean luma from image stats | Flags `low_light` / `overexposed` / `normal`. |
| **Duplicate** | SHA-256 (exact) + aHash Hamming distance (near-duplicate) against all prior uploads | Exact match → high confidence; near-duplicate confidence scales with hash distance. |
| **Screenshot** | Absence of camera EXIF + aspect ratio matching common screen ratios + density hint | Combined signal, not a single tell — reported at `medium` reliability. |
| **Photo-of-photo** | Explicitly *not* solved by a strong heuristic here | Reported as low-confidence/low-reliability with a stated reason, rather than faking certainty. Real solution needs frequency/moire analysis or a trained classifier. |
| **Possible editing (tamper)** | Simplified Error Level Analysis (JPEG recompression diff, block-wise hotspot detection) | JPEG-only (no natural compression history in PNG); capped confidence, framed as "a lead for review" not a forensic verdict. |
| **Vehicle plate format** | OCR (tesseract.js, pluggable) + regex for standard/BH-series Indian plates | If OCR can't initialize, reported as `vehicle_number_unverified` (unknown), never silently reported as invalid. |

### Handling uncertainty (the actual point of the exercise)

1. **Confidence is always attached, and capped honestly.** The tamper and photo-of-photo
   checks specifically cap their own confidence low (`0.3`–`0.75`) because the underlying
   heuristic genuinely can't support more than that.
2. **"Can't tell" is a distinct outcome from "false".** If OCR can't run, the plate result
   is `format_valid: null` / `vehicle_number_unverified`, not `false`. If a check can't
   apply (ELA on a PNG), it returns `applicable: false` with a reason. Collapsing "unknown"
   into "no issue" would be a worse system, not a simpler one.
3. **Verdict severity is a documented, simple state machine** (`src/analysis/index.js`):
   any `high` severity issue → `rejected`; any `medium` → `needs_review`; otherwise `clean`.
   `low`-severity/low-reliability findings (like photo-of-photo suspicion) are still
   surfaced in `issues[]` so a reviewer can see them, but don't by themselves force a
   rejection.

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

- **Upload-time failures** (bad mime type, corrupt/undecodable file, oversized file) are
  rejected synchronously with `400` — no point queuing a job that can't succeed.
- **Processing-time failures** (e.g. disk read error) are retried up to 3 times with
  backoff by the queue; after the final failure, `images.status` is set to `failed` with a
  concrete `failure_reason` string, so `/status` and `/result` always explain *why*, not
  just *that* it failed.
- **Process crash mid-job:** on restart, any `pending`/`processing` image is automatically
  re-enqueued (see `src/worker/index.js`) — nothing is silently lost.
- **Known gap:** a single-process worker means a crash during the small window between "job
  picked up" and "jobs row marked processing" could in theory double-process an image on
  restart. The checks are read-only against the image and idempotent to re-run, so this is
  currently harmless — it just wastes CPU — but it's worth calling out honestly rather than
  claiming exactly-once semantics the system doesn't have.

---

## AI usage disclosure

- **Where AI was used:** e.g. scaffolding the Express routes and multer upload handling,
  drafting one or more of the 6 analysis checks (name which), writing the queue/retry
  logic, or drafting this documentation.
- **What it helped with:** e.g. boilerplate that would otherwise be repetitive (route
  wiring, SQL schema, JSON response shaping), or suggesting the Laplacian-variance
  approach for blur detection.
- **Where AI output was wrong:** name a concrete instance — e.g. it initially returned a
  bare boolean instead of a confidence score for a check, mishandled a PNG in the ELA
  (tamper) check since ELA assumes JPEG recompression artifacts, or suggested a plate
  regex that didn't account for BH-series formats.
- **How it was validated:** e.g. manual code review line-by-line, running the pipeline
  against a set of real/sample vehicle images and checking verdicts by hand, unit tests
  around the severity state machine, or comparing OCR output against known plate numbers.

---

## Trade-offs

### What was intentionally simplified
- **In-process queue instead of a broker**, and **SQLite instead of Postgres** — both
  reversible, deliberate choices to keep `npm install && npm start` sufficient to run the
  whole system. See [Queue strategy](#queue-strategy) and
  [Major design decisions](#major-design-decisions) for the reasoning.
- **Local disk storage** instead of S3/GCS — `storage_path` is a plain filesystem path;
  only `routes/images.js` and `worker/processImage.js` touch the filesystem, so this is a
  contained change later, not a rewrite.
- **Photo-of-photo detection** is left intentionally weak (low confidence, low
  reliability, explained reason) rather than faking a heuristic that doesn't actually work
  — see [Handling uncertainty](#handling-uncertainty-the-actual-point-of-the-exercise).
- **Single-process worker concurrency (2)**, hardcoded rather than made elastic.

### What would improve with more time
- Calibrate thresholds (blur variance cutoff, brightness bounds, ELA hotspot fraction)
  against a labeled dataset of real field photos instead of reasonable-guess starting
  points.
- Build the frequency-domain/moire analysis (or a small trained classifier) that
  photo-of-photo detection actually needs.
- Add integration tests that run the full pipeline against a fixed set of sample images
  with known expected verdicts, so threshold tuning doesn't regress silently.
- Wire up the Postgres/Redis/MinIO stack the `docker-compose.yml` scaffold anticipates
  (see note in [Quick start](#run-with-docker)), rather than leaving it as an unconnected
  scaffold.

### Scalability concerns
- The in-process queue and SQLite file mean this **cannot run as more than one instance**
  today — SQLite's file-level locking and the in-memory job queue both assume a single
  process. Horizontal scaling requires the Postgres + BullMQ/SQS swap described in
  [Queue strategy](#queue-strategy), at which point `SELECT ... FOR UPDATE SKIP LOCKED` (or
  a real broker) replaces the current locking model.
- OCR (tesseract.js) is the slowest and most resource-heavy check; under load it's the
  first bottleneck, and would benefit from being split into its own worker pool with
  separate concurrency from the cheaper checks (blur/brightness/duplicate).
- No backpressure on `POST /api/images` — a burst of uploads all return `202` immediately
  and queue up; there's no queue-depth limit or `429` response yet if the backlog grows
  unbounded.

### Failure handling concerns
- Retries are count-based (3 attempts) with backoff, but there's no dead-letter visibility
  beyond the `failure_reason` string on the `images` row — no aggregate view of "which
  checks fail most often," which would help before scaling up trust in this pipeline.
- As noted above, the crash window between a job being picked up and its `jobs` row being
  marked `processing` isn't fully closed; checks are idempotent so this is currently safe
  but not provably exactly-once.
- If the disk holding uploaded files fills up or becomes unwritable, the current failure
  path treats it like any other processing error (retry then fail) rather than pausing
  ingestion — a full-disk write failure could burn through retry attempts uploading before
  anyone notices.

---

## Known limitations / next steps

- Thresholds (blur variance, brightness bounds, ELA hotspot fraction) are reasonable
  starting points, not calibrated against a labeled dataset.
- Photo-of-photo detection is intentionally left weak rather than faking confidence.
- Storage is local disk; swapping `storage_path` for an S3/GCS key is a small, contained
  change.
- Single-process worker concurrency (2) is configurable in `src/queue/queue.js`; true
  horizontal scaling needs the Postgres/BullMQ swap described above.
