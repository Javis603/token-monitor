'use strict';

// Identity artwork is a bounded static PNG, never markup or a fetched URL.
// Keeping it in the manifest makes package hashes, rollback and offline catalogs
// cover the exact same bytes. Image decode failure falls back in the renderer.
const PREFIX = 'data:image/png;base64,';
const MAX_BYTES = 64 * 1024;
function normalizeIdentityIcon(value) {
  if (value === undefined || value === null || value === '') return '';
  const fail = () => { throw new Error('identityIcon must be a static PNG data URL, at most 64 KB and 256 × 256 pixels'); };
  if (typeof value !== 'string' || !value.startsWith(PREFIX) || value.length > PREFIX.length + Math.ceil(MAX_BYTES / 3) * 4) return fail();
  const encoded = value.slice(PREFIX.length);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return fail();
  let bytes;
  try { const decoded = atob(encoded); if (btoa(decoded) !== encoded) return fail(); bytes = Uint8Array.from(decoded, c => c.charCodeAt(0)); } catch { return fail(); }
  if (bytes.length > MAX_BYTES || bytes.length < 57 || ![137,80,78,71,13,10,26,10].every((b, i) => bytes[i] === b)) return fail();
  const data = new DataView(bytes.buffer);
  let offset = 8, seenHeader = false, seenData = false;
  while (offset + 12 <= bytes.length) {
    const length = data.getUint32(offset);
    if (length > bytes.length - offset - 12) return fail();
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    let crc = 0xffffffff;
    for (const b of bytes.subarray(offset + 4, offset + 8 + length)) {
      crc ^= b;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    if (((crc ^ 0xffffffff) >>> 0) !== data.getUint32(offset + 8 + length)) return fail();
    if (!seenHeader && type !== 'IHDR') return fail();
    if (type === 'IHDR') {
      if (seenHeader || length !== 13) return fail();
      const width = data.getUint32(offset + 8), height = data.getUint32(offset + 12);
      if (!width || !height || width > 256 || height > 256 || bytes[offset + 16] !== 8 || ![2, 6].includes(bytes[offset + 17]) || bytes[offset + 18] || bytes[offset + 19] || bytes[offset + 20]) return fail();
      seenHeader = true;
    } else if (type === 'IDAT') {
      seenData = true;
    } else if (type === 'IEND') {
      if (!seenData || length || offset + 12 !== bytes.length) return fail();
      return value;
    } else {
      // No APNG, compressed text/profile chunks, external metadata or unknown
      // critical chunks. RGB/RGBA PNG export is the portable author contract.
      if ({ sRGB: 1, gAMA: 4, cHRM: 32, pHYs: 9 }[type] !== length || seenData) return fail();
    }
    offset += length + 12;
  }
  return fail();
}
module.exports = { normalizeIdentityIcon, MAX_BYTES };
