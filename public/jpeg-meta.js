// Reads the metadata segments of a JPEG without decoding the image:
// component count (grayscale vs colour), embedded ICC colour profile,
// EXIF block and JFIF pixel density.

const u16 = (b, i) => (b[i] << 8) | b[i + 1];
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

class NeedMore extends Error {}

function parse(bytes, final) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG');
  const meta = { components: 3, icc: null, exif: null, density: null };
  const iccParts = [];
  let iccCount = 0;
  let pos = 2;
  for (;;) {
    if (pos + 4 > bytes.length) { if (final) break; throw new NeedMore(); }
    if (bytes[pos] !== 0xff) break; // corrupt stream: stop reading metadata
    const marker = bytes[pos + 1];
    if (marker === 0xff) { pos++; continue; } // fill byte
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { pos += 2; continue; }
    if (marker === 0xda || marker === 0xd9) break; // start of scan: metadata is over
    const len = u16(bytes, pos + 2);
    if (pos + 2 + len > bytes.length) { if (final) break; throw new NeedMore(); }
    const seg = bytes.subarray(pos + 4, pos + 2 + len);
    if (marker === 0xe0 && ascii(seg, 0, 5) === 'JFIF\0' && seg.length >= 12) {
      const units = seg[7];
      if (units === 1 || units === 2) meta.density = { units, x: u16(seg, 8), y: u16(seg, 10) };
    } else if (marker === 0xe1 && ascii(seg, 0, 6) === 'Exif\0\0' && !meta.exif) {
      meta.exif = seg.slice(6);
    } else if (marker === 0xe2 && ascii(seg, 0, 12) === 'ICC_PROFILE\0' && seg.length > 14) {
      iccParts[seg[12]] = seg.slice(14);
      iccCount = seg[13];
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      meta.components = seg[5];
    }
    pos += 2 + len;
  }
  if (iccCount) {
    const parts = iccParts.slice(1, iccCount + 1);
    if (parts.length === iccCount && parts.every(Boolean)) {
      const icc = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) { icc.set(p, o); o += p.length; }
      meta.icc = icc;
    }
  }
  return meta;
}

/** Parse metadata from a JPEG Blob, reading only as much of it as needed. */
export async function readJpegMeta(blob) {
  let size = Math.min(blob.size, 256 * 1024);
  for (;;) {
    const bytes = new Uint8Array(await blob.slice(0, size).arrayBuffer());
    try {
      return parse(bytes, size >= blob.size);
    } catch (err) {
      if (!(err instanceof NeedMore)) throw err;
      size = Math.min(blob.size, size * 4);
    }
  }
}

// sRGB primaries adapted to D50, as they appear in ICC rXYZ/gXYZ/bXYZ tags.
const SRGB_PRIMARIES = [
  [0.4361, 0.2225, 0.0139],
  [0.3851, 0.7169, 0.0971],
  [0.1431, 0.0606, 0.7141],
];

/**
 * Classify an ICC profile: 'srgb' when its primaries match sRGB, 'wide' for
 * other RGB profiles (Display P3, Adobe RGB...), 'other' for gray/CMYK.
 */
export function classifyIcc(icc) {
  if (!icc || icc.length < 132) return 'srgb';
  const space = ascii(icc, 16, 4);
  if (space !== 'RGB ') return 'other';
  const dv = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
  const count = dv.getUint32(128);
  const tags = {};
  for (let i = 0; i < count && 132 + i * 12 + 12 <= icc.length; i++) {
    const at = 132 + i * 12;
    tags[ascii(icc, at, 4)] = dv.getUint32(at + 4);
  }
  const xyz = ['rXYZ', 'gXYZ', 'bXYZ'].map((t) => {
    const off = tags[t];
    if (off === undefined || off + 20 > icc.length) return null;
    return [0, 1, 2].map((k) => dv.getInt32(off + 8 + k * 4) / 65536);
  });
  if (xyz.some((v) => !v)) return 'wide'; // LUT-based profile: assume it may exceed sRGB
  const close = xyz.every((v, i) => v.every((c, k) => Math.abs(c - SRGB_PRIMARIES[i][k]) < 0.01));
  return close ? 'srgb' : 'wide';
}

/** Copy of an EXIF (TIFF) block with the orientation tag reset to 1 (upright). */
export function exifWithUprightOrientation(exif) {
  const out = exif.slice();
  try {
    const dv = new DataView(out.buffer);
    const le = out[0] === 0x49; // 'II' little-endian, 'MM' big-endian
    const ifd = dv.getUint32(4, le);
    const n = dv.getUint16(ifd, le);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (dv.getUint16(e, le) === 0x0112) dv.setUint16(e + 8, 1, le);
    }
  } catch {
    // Malformed EXIF: keep it as-is rather than failing the conversion.
  }
  return out;
}
