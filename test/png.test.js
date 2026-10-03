import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { PngEncoder, GrayMismatch } from '../public/png.js';
import { crc32 } from '../public/zip.js';

function readChunks(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  const chunks = [];
  for (let p = 8; p < bytes.length; ) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    const data = bytes.subarray(p + 8, p + 8 + len);
    assert.equal(dv.getUint32(p + 8 + len), crc32(bytes.subarray(p + 4, p + 8 + len)), `${type} CRC`);
    chunks.push({ type, data });
    p += 12 + len;
  }
  return chunks;
}

function unfilter(raw, width, height, bpp) {
  const rowLen = width * bpp;
  const out = new Uint8Array(rowLen * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (rowLen + 1)];
    for (let i = 0; i < rowLen; i++) {
      const x = raw[y * (rowLen + 1) + 1 + i];
      const a = i >= bpp ? out[y * rowLen + i - bpp] : 0;
      const b = y ? out[(y - 1) * rowLen + i] : 0;
      const c = y && i >= bpp ? out[(y - 1) * rowLen + i - bpp] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * rowLen + i] = (x + pred) & 0xff;
    }
  }
  return out;
}

function randomRgba(w, h, gray = false) {
  const d = new Uint8Array(w * h * 4);
  for (let i = 0; i < d.length; i += 4) {
    const v = (i / 4) % 7 === 0 ? (Math.random() * 256) | 0 : ((i / 4) * 3) & 255;
    d[i] = v;
    d[i + 1] = gray ? v : (v * 5) & 255;
    d[i + 2] = gray ? v : (v * 11) & 255;
    d[i + 3] = 255;
  }
  return d;
}

async function roundTrip({ w, h, gray, strip, ...opts }) {
  const rgba = randomRgba(w, h, gray);
  const enc = new PngEncoder({ width: w, height: h, gray, ...opts });
  for (let y = 0; y < h; y += strip) {
    const rows = Math.min(strip, h - y);
    await enc.writeRgba(rgba.subarray(y * w * 4, (y + rows) * w * 4), rows);
  }
  const { blob, crc } = await enc.finish();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(crc, crc32(bytes), 'whole-file CRC for ZIP');
  const chunks = readChunks(bytes);
  const ihdr = new DataView(chunks[0].data.buffer, chunks[0].data.byteOffset);
  assert.equal(chunks[0].type, 'IHDR');
  assert.equal(ihdr.getUint32(0), w);
  assert.equal(ihdr.getUint32(4), h);
  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const bpp = gray ? 1 : 3;
  const pixels = unfilter(inflateSync(idat), w, h, bpp);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += bpp) {
    if (pixels[j] !== rgba[i] || (!gray && (pixels[j + 1] !== rgba[i + 1] || pixels[j + 2] !== rgba[i + 2]))) {
      assert.fail(`pixel ${i / 4} differs`);
    }
  }
  return chunks;
}

test('RGB round-trip is lossless across strips', async () => {
  const chunks = await roundTrip({ w: 37, h: 23, strip: 5, srgb: true });
  assert.equal(chunks[0].data[9], 2);
  assert.ok(chunks.some((c) => c.type === 'sRGB'));
  assert.equal(chunks.at(-1).type, 'IEND');
});

test('grayscale round-trip writes a 1-channel PNG', async () => {
  const chunks = await roundTrip({ w: 20, h: 9, strip: 4, gray: true });
  assert.equal(chunks[0].data[9], 0);
});

test('grayscale mode rejects colour pixels', async () => {
  const enc = new PngEncoder({ width: 4, height: 1, gray: true });
  await assert.rejects(enc.writeRgba(randomRgba(4, 1), 1), GrayMismatch);
  enc.abort();
});

test('writes iCCP, pHYs and eXIf chunks before image data', async () => {
  const icc = new Uint8Array(300).map((_, i) => i & 255);
  const exif = new Uint8Array([0x4d, 0x4d, 0, 42, 0, 0, 0, 8]);
  const chunks = await roundTrip({
    w: 5, h: 5, strip: 5, icc: { name: 'Display P3', data: icc }, phys: { x: 11811, y: 11811 }, exif,
  });
  const types = chunks.map((c) => c.type);
  assert.deepEqual(types.slice(0, 4), ['IHDR', 'iCCP', 'pHYs', 'eXIf']);
  assert.ok(!types.includes('sRGB'), 'sRGB and iCCP are mutually exclusive');
  const iccp = chunks[1].data;
  const nul = iccp.indexOf(0);
  assert.equal(Buffer.from(iccp.subarray(0, nul)).toString(), 'Display P3');
  assert.deepEqual(new Uint8Array(inflateSync(iccp.subarray(nul + 2))), icc);
  assert.deepEqual([...chunks[3].data], [...exif]);
});
