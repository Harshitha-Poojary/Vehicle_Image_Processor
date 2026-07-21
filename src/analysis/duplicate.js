const db = require('../db');
const { hammingDistance } = require('../utils/hash');

const NEAR_DUPLICATE_BIT_THRESHOLD = 8; // out of 64 bits (~12.5% difference) -> "near duplicate"

/**
 * Duplicate detection against everything already in the DB.
 * Two tiers, because "duplicate" isn't one thing:
 *   1. Exact byte-for-byte re-upload (sha256 match) - high confidence, cheap.
 *   2. Perceptual near-duplicate (small Hamming distance on aHash) - same photo re-saved,
 *      re-compressed, or lightly cropped. Confidence is scaled by how close the hashes are;
 *      this is inherently fuzzier than the exact match, so we cap confidence lower.
 *
 * `excludeId` is the image currently being analyzed, so it never matches itself.
 */
function checkDuplicate({ sha256Hash, phash, excludeId }) {
  const exactMatch = db
    .prepare(`SELECT id, original_filename, uploaded_at FROM images WHERE sha256 = ? AND id != ? LIMIT 1`)
    .get(sha256Hash, excludeId);

  if (exactMatch) {
    return {
      is_duplicate: true,
      match_type: 'exact',
      matched_image_id: exactMatch.id,
      hamming_distance: 0,
      confidence: 0.99,
    };
  }

  const candidates = db
    .prepare(`SELECT id, phash FROM images WHERE phash IS NOT NULL AND id != ?`)
    .all(excludeId);

  let best = null;
  for (const c of candidates) {
    const dist = hammingDistance(phash, c.phash);
    if (best === null || dist < best.dist) best = { dist, id: c.id };
  }

  if (best && best.dist <= NEAR_DUPLICATE_BIT_THRESHOLD) {
    const confidence = Math.max(0.5, 0.95 - (best.dist / NEAR_DUPLICATE_BIT_THRESHOLD) * 0.45);
    return {
      is_duplicate: true,
      match_type: 'near_duplicate',
      matched_image_id: best.id,
      hamming_distance: best.dist,
      confidence: Number(confidence.toFixed(2)),
    };
  }

  return {
    is_duplicate: false,
    match_type: null,
    matched_image_id: null,
    hamming_distance: best ? best.dist : null,
    confidence: 0.6, // moderate confidence there's no duplicate; we only compared against known hashes
  };
}

module.exports = { checkDuplicate, NEAR_DUPLICATE_BIT_THRESHOLD };
