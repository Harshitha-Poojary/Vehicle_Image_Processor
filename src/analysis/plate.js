/**
 * Vehicle registration plate: OCR extraction + format validation.
 *
 * OCR is deliberately behind a provider interface (`extractText(buffer) -> string`):
 *   - Default/production suggestion: tesseract.js (listed as an optionalDependency) or a
 *     cloud OCR API (AWS Textract / Google Vision) if higher accuracy is needed.
 *   - This environment may not have network access to download tesseract's language
 *     data at runtime, so we try to load it lazily and fall back to a `null`-text
 *     "ocr_unavailable" result instead of crashing the whole pipeline. A missing OCR
 *     engine should degrade the plate check, not the entire job.
 *
 * Format validation is independent of OCR quality: given whatever text OCR returns, we
 * scan it for a substring matching the standard Indian plate pattern:
 *   [State(2 letters)][RTO code(1-2 digits)][Series(1-3 letters)][Number(4 digits)]
 * e.g. "MH12AB1234". BH-series (new all-India format, e.g. "21BH1234AB") is matched too.
 */
const STANDARD_PLATE_RE = /\b([A-Z]{2}[ -]?\d{1,2}[ -]?[A-Z]{1,3}[ -]?\d{4})\b/;
const BH_SERIES_PLATE_RE = /\b(\d{2}[ -]?BH[ -]?\d{4}[ -]?[A-Z]{1,2})\b/;

let tesseractWorkerPromise = null;

async function getOcrText(buffer) {
  try {
    // Lazy require: if tesseract.js isn't installed / can't fetch its model data, this throws
    // and we fall back gracefully rather than failing the whole analysis job.
    const { createWorker } = require('tesseract.js');
    if (!tesseractWorkerPromise) {
      tesseractWorkerPromise = createWorker('eng');
    }
    const worker = await tesseractWorkerPromise;
    const {
      data: { text },
    } = await worker.recognize(buffer);
    return { text: text || '', engine: 'tesseract.js', available: true };
  } catch (err) {
    return { text: '', engine: 'none', available: false, error: err.message };
  }
}

function normalizeCandidate(raw) {
  return raw.replace(/[ -]/g, '').toUpperCase();
}

async function analyzePlate(buffer) {
  const ocr = await getOcrText(buffer);
  const cleaned = ocr.text.toUpperCase();

  const standardMatch = cleaned.match(STANDARD_PLATE_RE);
  const bhMatch = cleaned.match(BH_SERIES_PLATE_RE);
  const match = standardMatch || bhMatch;

  if (!ocr.available) {
    return {
      ocr_engine: ocr.engine,
      ocr_available: false,
      raw_text: null,
      plate_candidate: null,
      format_valid: null,
      confidence: 0,
      reliability: 'unavailable',
      note:
        'OCR engine could not be initialized in this environment (e.g. no network to fetch language data). Plate format could not be checked; this is reported as "unknown", not "invalid".',
    };
  }

  if (!match) {
    return {
      ocr_engine: ocr.engine,
      ocr_available: true,
      raw_text: ocr.text.trim().slice(0, 200),
      plate_candidate: null,
      format_valid: false,
      confidence: 0.55, // OCR ran but found nothing plate-shaped; moderate confidence, not certainty
      reliability: 'medium',
      note: 'No substring matching Indian plate format found in OCR output.',
    };
  }

  const candidate = normalizeCandidate(match[1]);
  return {
    ocr_engine: ocr.engine,
    ocr_available: true,
    raw_text: ocr.text.trim().slice(0, 200),
    plate_candidate: candidate,
    format_valid: true,
    confidence: 0.8,
    reliability: 'medium',
    note: 'Format regex match only - does not verify the plate exists in any RTO registry.',
  };
}

module.exports = { analyzePlate };
