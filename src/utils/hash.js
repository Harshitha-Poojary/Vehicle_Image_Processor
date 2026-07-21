const crypto = require('crypto');
const sharp = require('sharp');

/** Exact-content hash - catches byte-identical re-uploads instantly and cheaply. */
function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Average-hash (aHash) perceptual hash.
 * Catches near-duplicates: re-compressed, resized, or slightly re-cropped versions of the
 * same photo, which a byte hash would treat as completely different files.
 * Returns a 64-bit hash encoded as a 16-char hex string.
 */
async function perceptualHash(buffer) {
  const size = 8; // 8x8 = 64 bits, the classic aHash size - cheap and good enough for this use case
  const { data } = await sharp(buffer)
    .grayscale()
    .resize(size, size, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const mean = data.reduce((a, b) => a + b, 0) / data.length;
  let bits = '';
  for (const px of data) bits += px >= mean ? '1' : '0';

  // pack bits into hex
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/** Hamming distance between two same-length hex hash strings, measured in bits. */
function hammingDistance(hexA, hexB) {
  if (!hexA || !hexB || hexA.length !== hexB.length) return Infinity;
  let dist = 0;
  for (let i = 0; i < hexA.length; i++) {
    let x = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16);
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}

module.exports = { sha256, perceptualHash, hammingDistance };
