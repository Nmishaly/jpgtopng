// Minimal ZIP writer (STORE method, no compression).
// PNG data is already deflate-compressed, so re-compressing gains almost
// nothing — storing keeps archiving instant and memory-friendly.
// Entry data may be a Blob, so large archives are assembled from references
// without copying the image bytes into one giant buffer.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 of `bytes`; pass a previous result as `crc` to continue a running checksum. */
export function crc32(bytes, crc = 0) {
  crc ^= 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const MAX_U32 = 0xffffffff;
const encoder = new TextEncoder();

function dosDateTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const year = Math.max(date.getFullYear(), 1980) - 1980;
  const day = (year << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

const setU64 = (dv, at, v) => {
  dv.setUint32(at, v % 2 ** 32, true);
  dv.setUint32(at + 4, Math.floor(v / 2 ** 32), true);
};

/**
 * Build the parts of a ZIP archive. Archives over 4GB or 65535 entries are
 * written in ZIP64 format automatically.
 * @param {{name: string, data: Blob|Uint8Array, size: number, crc: number}[]} entries
 * @param {{date?: Date, forceZip64?: boolean}} [options]
 * @returns {(Uint8Array|Blob)[]} parts to concatenate (e.g. `new Blob(parts)`)
 */
export function buildZipParts(entries, { date = new Date(), forceZip64 = false } = {}) {
  const { time, day } = dosDateTime(date);
  const total = entries.reduce((n, e) => n + e.size + 30 + 3 * e.name.length + 20, 0);
  const zip64 = forceZip64 || total >= MAX_U32 || entries.length >= 0xffff;
  const version = zip64 ? 45 : 20;
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);

    // Local header. In ZIP64 mode both sizes live in the extra field.
    const local = new Uint8Array(30 + name.length + (zip64 ? 20 : 0));
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, version, true);
    lv.setUint16(6, 0x0800, true); // flags: UTF-8 file names
    lv.setUint16(8, 0, true); // method: store
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, entry.crc, true);
    lv.setUint32(18, zip64 ? MAX_U32 : entry.size, true);
    lv.setUint32(22, zip64 ? MAX_U32 : entry.size, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, zip64 ? 20 : 0, true);
    local.set(name, 30);
    if (zip64) {
      const x = 30 + name.length;
      lv.setUint16(x, 0x0001, true);
      lv.setUint16(x + 2, 16, true);
      setU64(lv, x + 4, entry.size);
      setU64(lv, x + 12, entry.size);
    }

    const cd = new Uint8Array(46 + name.length + (zip64 ? 28 : 0));
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, version, true); // version made by
    cv.setUint16(6, version, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    cv.setUint32(16, entry.crc, true);
    cv.setUint32(20, zip64 ? MAX_U32 : entry.size, true);
    cv.setUint32(24, zip64 ? MAX_U32 : entry.size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, zip64 ? 28 : 0, true);
    cv.setUint32(42, zip64 ? MAX_U32 : offset, true);
    cd.set(name, 46);
    if (zip64) {
      const x = 46 + name.length;
      cv.setUint16(x, 0x0001, true);
      cv.setUint16(x + 2, 24, true);
      setU64(cv, x + 4, entry.size);
      setU64(cv, x + 12, entry.size);
      setU64(cv, x + 20, offset);
    }

    parts.push(local, entry.data);
    central.push(cd);
    offset += local.length + entry.size;
  }

  const cdSize = central.reduce((sum, c) => sum + c.length, 0);
  const tail = [];
  if (zip64) {
    const rec = new Uint8Array(56);
    const rv = new DataView(rec.buffer);
    rv.setUint32(0, 0x06064b50, true); // ZIP64 end of central directory record
    setU64(rv, 4, 44);
    rv.setUint16(12, 45, true);
    rv.setUint16(14, 45, true);
    setU64(rv, 24, entries.length);
    setU64(rv, 32, entries.length);
    setU64(rv, 40, cdSize);
    setU64(rv, 48, offset);
    const loc = new Uint8Array(20);
    const lv = new DataView(loc.buffer);
    lv.setUint32(0, 0x07064b50, true); // ZIP64 end of central directory locator
    setU64(lv, 8, offset + cdSize);
    lv.setUint32(16, 1, true);
    tail.push(rec, loc);
  }
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, zip64 ? 0xffff : entries.length, true);
  ev.setUint16(10, zip64 ? 0xffff : entries.length, true);
  ev.setUint32(12, zip64 ? MAX_U32 : cdSize, true);
  ev.setUint32(16, zip64 ? MAX_U32 : offset, true);

  parts.push(...central, ...tail, end);
  return parts;
}
