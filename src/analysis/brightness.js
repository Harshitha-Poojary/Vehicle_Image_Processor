const sharp = require('sharp');

const LOW_LIGHT_THRESHOLD = 60; // mean luma 0-255
const OVEREXPOSED_THRESHOLD = 210;

/**
 * Brightness analysis using mean luma from image statistics.
 * sharp's .stats() already computes per-channel mean/stdev cheaply (no full pixel scan in JS
 * needed), so we reuse that instead of hand-rolling a histogram.
 */
async function analyzeBrightness(buffer) {
  const stats = await sharp(buffer).stats();
  const channels = stats.channels; // R,G,B (,A)
  // Standard luma weighting; falls back to plain average if fewer than 3 channels (e.g. grayscale).
  let mean;
  if (channels.length >= 3) {
    mean = 0.299 * channels[0].mean + 0.587 * channels[1].mean + 0.114 * channels[2].mean;
  } else {
    mean = channels[0].mean;
  }

  let condition = 'normal';
  if (mean < LOW_LIGHT_THRESHOLD) condition = 'low_light';
  else if (mean > OVEREXPOSED_THRESHOLD) condition = 'overexposed';

  const confidence =
    condition === 'normal'
      ? 0.6
      : Math.min(
          0.95,
          0.5 +
            Math.abs(mean - (condition === 'low_light' ? LOW_LIGHT_THRESHOLD : OVEREXPOSED_THRESHOLD)) /
              255
        );

  return {
    mean_luma: Number(mean.toFixed(2)),
    condition, // low_light | normal | overexposed
    confidence: Number(confidence.toFixed(2)),
  };
}

module.exports = { analyzeBrightness };
