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

export function crc32(bytes) {
  let crc = 0xffffffff;
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

/**
 * Build the parts of a ZIP archive.
 * @param {{name: string, data: Blob|Uint8Array, size: number, crc: number}[]} entries
 * @param {Date} [date]
 * @returns {(Uint8Array|Blob)[]} parts to concatenate (e.g. `new Blob(parts)`)
 */
export function buildZipParts(entries, date = new Date()) {
  const { time, day } = dosDateTime(date);
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    if (entry.size > MAX_U32 || offset > MAX_U32) {
      throw new Error('הארכיון גדול מ-4GB; הורידו את הקבצים בקבוצות קטנות יותר.');
    }

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // flags: UTF-8 file names
    lv.setUint16(8, 0, true); // method: store
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, entry.crc, true);
    lv.setUint32(18, entry.size, true); // compressed size
    lv.setUint32(22, entry.size, true); // uncompressed size
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(name, 30);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    cv.setUint32(16, entry.crc, true);
    cv.setUint32(20, entry.size, true);
    cv.setUint32(24, entry.size, true);
    cv.setUint16(28, name.length, true);
    // extra len, comment len, disk start, internal attrs = 0
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // local header offset
    cd.set(name, 46);

    parts.push(local, entry.data);
    central.push(cd);
    offset += local.length + entry.size;
  }

  const cdSize = central.reduce((sum, c) => sum + c.length, 0);
  if (offset > MAX_U32 || entries.length > 0xffff) {
    throw new Error('הארכיון גדול מדי; הורידו את הקבצים בקבוצות קטנות יותר.');
  }
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory signature
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  parts.push(...central, end);
  return parts;
}
