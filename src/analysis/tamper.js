const sharp = require('sharp');

/**
 * Simplified Error Level Analysis (ELA).
 *
 * Idea: re-encode the image at a known JPEG quality, then diff it against the original
 * pixel-for-pixel. Regions that were untouched since their last JPEG save compress/decompress
 * predictably (low, uniform error). Regions that were pasted in, redrawn, or otherwise edited
 * after the last save tend to compress differently, showing up as localized higher error.
 *
 * This is the same underlying idea real ELA tools use, simplified to a single global
 * statistic (mean + max local block error) rather than a full visual error map, to keep the
 * check fast and dependency-free. It is a *signal*, not a forensic verdict:
 *   - Already-lossy source images naturally show more uniform "high" error everywhere,
 *     which can look similar to tampering - hence "medium" reliability and a capped
 *     confidence rather than a hard true/false.
 *   - PNG/lossless sources have no natural compression history to compare against, so the
 *     check is skipped for those with an explicit "not_applicable" result instead of a
 *     misleading number.
 */
const RECOMPRESS_QUALITY = 90;
const BLOCK_SIZE = 16;
const HOTSPOT_ERROR_THRESHOLD = 35; // per-block mean abs diff considered "hot"
const HOTSPOT_FRACTION_FLAG = 0.02; // >2% of blocks hot -> flag for review

async function analyzeTamper(buffer, mimeType) {
  if (mimeType !== 'image/jpeg') {
    return {
      applicable: false,
      reason: `ELA relies on JPEG recompression artifacts; input is ${mimeType}.`,
      suspected_edit: false,
      confidence: 0,
    };
  }

  const { data: original, info } = await sharp(buffer)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const recompressed = await sharp(buffer)
    .jpeg({ quality: RECOMPRESS_QUALITY })
    .raw()
    .toBuffer();

  const { width, height, channels } = info;
  const blocksX = Math.ceil(width / BLOCK_SIZE);
  const blocksY = Math.ceil(height / BLOCK_SIZE);
  let hotBlocks = 0;
  const totalBlocks = blocksX * blocksY;
  let globalSum = 0;
  let globalCount = 0;

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      let blockSum = 0;
      let blockCount = 0;
      const xStart = bx * BLOCK_SIZE;
      const yStart = by * BLOCK_SIZE;
      const xEnd = Math.min(xStart + BLOCK_SIZE, width);
      const yEnd = Math.min(yStart + BLOCK_SIZE, height);

      for (let y = yStart; y < yEnd; y++) {
        for (let x = xStart; x < xEnd; x++) {
          const idx = (y * width + x) * channels;
          for (let c = 0; c < Math.min(channels, 3); c++) {
            const diff = Math.abs(original[idx + c] - recompressed[idx + c]);
            blockSum += diff;
            blockCount++;
          }
        }
      }
      const blockMean = blockCount ? blockSum / blockCount : 0;
      globalSum += blockSum;
      globalCount += blockCount;
      if (blockMean > HOTSPOT_ERROR_THRESHOLD) hotBlocks++;
    }
  }

  const globalMeanError = globalCount ? globalSum / globalCount : 0;
  const hotFraction = totalBlocks ? hotBlocks / totalBlocks : 0;
  const suspected = hotFraction > HOTSPOT_FRACTION_FLAG;

  const confidence = suspected
    ? Number(Math.min(0.75, 0.4 + hotFraction * 2).toFixed(2)) // capped - ELA is only ever a lead
    : 0.5;

  return {
    applicable: true,
    global_mean_error: Number(globalMeanError.toFixed(2)),
    hot_block_fraction: Number(hotFraction.toFixed(3)),
    suspected_edit: suspected,
    confidence,
    reliability: 'medium',
    note: 'ELA-style signal; localized error concentration can also occur naturally (e.g. text overlays, heavy prior compression). Treat as a lead for manual review, not proof of tampering.',
  };
}

module.exports = { analyzeTamper };
