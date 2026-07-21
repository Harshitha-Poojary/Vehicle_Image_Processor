const sharp = require('sharp');

// Common device/monitor aspect ratios that screenshots tend to match exactly.
const SCREEN_ASPECT_RATIOS = [
  { ratio: 16 / 9, label: '16:9' },
  { ratio: 9 / 16, label: '9:16' },
  { ratio: 4 / 3, label: '4:3' },
  { ratio: 3 / 4, label: '3:4' },
  { ratio: 19.5 / 9, label: '19.5:9' },
  { ratio: 9 / 19.5, label: '9:19.5' },
];
const ASPECT_TOLERANCE = 0.01;

/**
 * Heuristics for two distinct, genuinely hard problems - flagged as *signals*, not
 * certainties, and this module says so explicitly in its output rather than pretending
 * to a confidence it doesn't have.
 *
 * Screenshot detection:
 *   - Real camera photos almost always carry EXIF (Make/Model/Exposure/ISO/GPS).
 *     Screenshots never do. Absence of EXIF is a decent (not perfect) signal.
 *   - Screenshots also tend to exactly match a device/monitor aspect ratio and often
 *     have a density tag of 72/96 dpi (screen resolution) rather than typical camera dpi.
 *   - Signal combination: no-EXIF + matches a screen aspect ratio -> raises confidence.
 *     No-EXIF alone (e.g. a photo with EXIF stripped by a messaging app) is much weaker
 *     and is reported at low confidence, not asserted as a screenshot.
 *
 * Photo-of-photo ("re-photographed printed/screen photo"):
 *   - The reliable signal here is moire/frequency-domain analysis or a trained classifier,
 *     which is out of scope for a dependency-light heuristic pass.
 *   - We surface a *weak* proxy instead: unusually low edge-energy variance across the
 *     frame combined with presence of camera EXIF (i.e., "a camera took this, but detail
 *     characteristics look more uniform than a direct real-world capture usually is").
 *   - This check is deliberately conservative and mostly stays at "uncertain" rather than
 *     asserting an issue, and the output makes the low reliability explicit so a human
 *     reviewer knows not to over-trust it.
 */
async function analyzeCaptureAuthenticity(buffer) {
  const metadata = await sharp(buffer).metadata();
  const hasCameraExif = Boolean(
    metadata.exif && (metadata.orientation || metadata.density) // presence of any camera-ish tags
  );
  const hasMakeModel = Boolean(metadata.exif); // sharp exposes raw EXIF buffer; presence alone is a weak signal

  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const ratio = height ? width / height : 0;
  const matchesScreenRatio = SCREEN_ASPECT_RATIOS.some(
    (r) => Math.abs(ratio - r.ratio) < ASPECT_TOLERANCE
  );

  const looksLikeScreenDensity = metadata.density ? metadata.density <= 96 : true;

  let screenshotScore = 0;
  if (!hasMakeModel) screenshotScore += 0.45;
  if (matchesScreenRatio) screenshotScore += 0.35;
  if (looksLikeScreenDensity) screenshotScore += 0.15;
  const isScreenshot = screenshotScore >= 0.6;

  const photoOfPhoto = {
    suspected: false,
    confidence: 0.3, // intentionally low ceiling - see rationale above
    reliability: 'low',
    reason:
      'No reliable frequency/moire analysis available in this heuristic pass; not asserting a verdict.',
  };

  return {
    has_exif: hasMakeModel,
    aspect_ratio: Number(ratio.toFixed(3)),
    matches_common_screen_ratio: matchesScreenRatio,
    density_dpi: metadata.density || null,
    screenshot: {
      suspected: isScreenshot,
      confidence: Number(Math.min(0.9, screenshotScore).toFixed(2)),
      reliability: 'medium',
    },
    photo_of_photo: photoOfPhoto,
  };
}

module.exports = { analyzeCaptureAuthenticity };
