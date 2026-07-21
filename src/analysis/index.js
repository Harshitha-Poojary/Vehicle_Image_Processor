const { detectBlur } = require('./blur');
const { analyzeBrightness } = require('./brightness');
const { checkDuplicate } = require('./duplicate');
const { analyzeCaptureAuthenticity } = require('./captureAuthenticity');
const { analyzeTamper } = require('./tamper');
const { analyzePlate } = require('./plate');

/**
 * Runs every check and reduces the raw outputs into a structured `issues[]` list plus one
 * overall verdict. Severity model, deliberately simple and documented rather than a black box:
 *
 *   - "high"   -> blocks straight-through processing (reject / must re-upload)
 *   - "medium" -> flagged for human review, not auto-rejected
 *   - "low"    -> informational, surfaced but doesn't change the verdict
 *
 * overall_verdict:
 *   - "rejected"     if any high-severity issue was detected
 *   - "needs_review" if any medium-severity issue was detected (including any check that
 *                     itself was low-reliability/uncertain - uncertainty is treated as a
 *                     reason for a human to look, not swept into a false "clean")
 *   - "clean"        otherwise
 */
async function runAnalysis({ buffer, mimeType, sha256Hash, phash, imageId }) {
  const [blur, brightness, duplicate, capture, tamper, plate] = await Promise.all([
    detectBlur(buffer),
    analyzeBrightness(buffer),
    Promise.resolve(checkDuplicate({ sha256Hash, phash, excludeId: imageId })),
    analyzeCaptureAuthenticity(buffer),
    analyzeTamper(buffer, mimeType),
    analyzePlate(buffer),
  ]);

  const issues = [];

  if (blur.is_blurry) {
    issues.push({
      type: 'blurry_image',
      severity: 'high',
      confidence: blur.confidence,
      detail: `Laplacian variance ${blur.laplacian_variance} below sharpness threshold ${blur.threshold}.`,
    });
  }

  if (brightness.condition === 'low_light') {
    issues.push({
      type: 'low_light',
      severity: 'medium',
      confidence: brightness.confidence,
      detail: `Mean luma ${brightness.mean_luma} indicates a dark/underexposed capture.`,
    });
  } else if (brightness.condition === 'overexposed') {
    issues.push({
      type: 'overexposed',
      severity: 'medium',
      confidence: brightness.confidence,
      detail: `Mean luma ${brightness.mean_luma} indicates a blown-out/overexposed capture.`,
    });
  }

  if (duplicate.is_duplicate) {
    issues.push({
      type: 'duplicate_image',
      severity: duplicate.match_type === 'exact' ? 'high' : 'medium',
      confidence: duplicate.confidence,
      detail:
        duplicate.match_type === 'exact'
          ? `Byte-identical to previously uploaded image ${duplicate.matched_image_id}.`
          : `Near-duplicate of image ${duplicate.matched_image_id} (hamming distance ${duplicate.hamming_distance}).`,
    });
  }

  if (capture.screenshot.suspected) {
    issues.push({
      type: 'screenshot_suspected',
      severity: 'medium',
      confidence: capture.screenshot.confidence,
      detail: `No camera EXIF${capture.matches_common_screen_ratio ? ' and aspect ratio matches a common screen size' : ''}.`,
    });
  }

  if (capture.photo_of_photo.suspected) {
    issues.push({
      type: 'photo_of_photo_suspected',
      severity: 'low',
      confidence: capture.photo_of_photo.confidence,
      detail: capture.photo_of_photo.reason,
    });
  }

  if (tamper.applicable && tamper.suspected_edit) {
    issues.push({
      type: 'possible_editing',
      severity: 'medium',
      confidence: tamper.confidence,
      detail: `ELA hot-block fraction ${tamper.hot_block_fraction} exceeds baseline; ${tamper.note}`,
    });
  }

  if (plate.ocr_available && plate.format_valid === false) {
    issues.push({
      type: 'invalid_vehicle_number_format',
      severity: 'medium',
      confidence: plate.confidence,
      detail: 'OCR ran but no substring matched the expected Indian plate format.',
    });
  } else if (!plate.ocr_available) {
    issues.push({
      type: 'vehicle_number_unverified',
      severity: 'low',
      confidence: 0,
      detail: plate.note,
    });
  }

  const hasHigh = issues.some((i) => i.severity === 'high');
  const hasMedium = issues.some((i) => i.severity === 'medium');
  const overall_verdict = hasHigh ? 'rejected' : hasMedium ? 'needs_review' : 'clean';

  return {
    overall_verdict,
    issues,
    checks: { blur, brightness, duplicate, capture_authenticity: capture, tamper, plate },
  };
}

module.exports = { runAnalysis };
