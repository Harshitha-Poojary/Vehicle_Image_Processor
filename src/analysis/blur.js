const sharp = require('sharp');

/**
 * Blur detection using the classic "variance of Laplacian" focus measure.
 * A Laplacian kernel responds strongly to edges; a sharp image has lots of strong edge
 * responses (high variance), a blurry image's edges are smeared out (low variance).
 *
 * This is a well-known, cheap, dependency-free heuristic (no ML model needed) - good enough
 * to flag obviously out-of-focus field photos, not a substitute for a trained no-reference
 * blur-quality model. Threshold was picked conservatively and should be tuned against a
 * labeled sample of real field images before relying on it in production.
 */
const LAPLACIAN_KERNEL = {
  width: 3,
  height: 3,
  kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0],
};

const BLUR_VARIANCE_THRESHOLD = 60; // below this -> flagged blurry

async function detectBlur(buffer) {
  const edgeBuffer = await sharp(buffer)
    .grayscale()
    .convolve(LAPLACIAN_KERNEL)
    .raw()
    .toBuffer();

  const n = edgeBuffer.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += edgeBuffer[i];
  const mean = sum / n;

  let variance = 0;
  for (let i = 0; i < n; i++) variance += (edgeBuffer[i] - mean) ** 2;
  variance /= n;

  const isBlurry = variance < BLUR_VARIANCE_THRESHOLD;
  // Confidence scales with distance from the threshold, capped at 0.95 - we never claim
  // certainty from a single scalar heuristic.
  const distance = Math.abs(variance - BLUR_VARIANCE_THRESHOLD) / BLUR_VARIANCE_THRESHOLD;
  const confidence = Math.min(0.95, 0.5 + distance * 0.4);

  return {
    laplacian_variance: Number(variance.toFixed(2)),
    threshold: BLUR_VARIANCE_THRESHOLD,
    is_blurry: isBlurry,
    confidence: Number(confidence.toFixed(2)),
  };
}

module.exports = { detectBlur };
