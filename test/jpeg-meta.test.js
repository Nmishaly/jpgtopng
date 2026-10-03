import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJpegMeta, classifyIcc, exifWithUprightOrientation } from '../public/jpeg-meta.js';
import { DISPLAY_P3_ICC } from '../public/icc.js';

function segment(marker, payload) {
  const len = payload.length + 2;
  return new Uint8Array([0xff, marker, len >> 8, len & 255, ...payload]);
}
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

function jpeg(...segments) {
  return new Blob([new Uint8Array([0xff, 0xd8]), ...segments, new Uint8Array([0xff, 0xda, 0, 2, 0xff, 0xd9])]);
}

test('reads density, EXIF, split ICC profile and component count', async () => {
  const icc = DISPLAY_P3_ICC;
  const half = Math.ceil(icc.length / 2);
  const blob = jpeg(
    segment(0xe0, [...ascii('JFIF\0'), 1, 1, 1, 0, 300, 0, 300, 0, 0].map((v) => v & 255)),
    segment(0xe1, [...ascii('Exif\0\0'), 0x4d, 0x4d, 0, 42]),
    segment(0xe2, [...ascii('ICC_PROFILE\0'), 2, 2, ...icc.subarray(half)]),
    segment(0xe2, [...ascii('ICC_PROFILE\0'), 1, 2, ...icc.subarray(0, half)]),
    segment(0xc0, [8, 0, 10, 0, 10, 1, 1, 0x11, 0]),
  );
  const meta = await readJpegMeta(blob);
  assert.equal(meta.components, 1);
  assert.deepEqual([...meta.exif], [0x4d, 0x4d, 0, 42]);
  assert.deepEqual(meta.icc, icc);
  assert.equal(meta.density.units, 1);
});

test('tolerates a truncated header', async () => {
  const meta = await readJpegMeta(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x10, 0x00, 1, 2])]));
  assert.equal(meta.exif, null);
});

test('classifies profiles', () => {
  assert.equal(classifyIcc(null), 'srgb');
  assert.equal(classifyIcc(DISPLAY_P3_ICC), 'wide');
  const fakeSrgb = DISPLAY_P3_ICC.slice();
  const dv = new DataView(fakeSrgb.buffer);
  const prim = [[0.4361, 0.2225, 0.0139], [0.3851, 0.7169, 0.0971], [0.1431, 0.0606, 0.7141]];
  for (let t = 0; t < dv.getUint32(128); t++) {
    const at = 132 + t * 12;
    const idx = ['rXYZ', 'gXYZ', 'bXYZ'].indexOf(String.fromCharCode(...fakeSrgb.subarray(at, at + 4)));
    if (idx >= 0) prim[idx].forEach((v, k) => dv.setInt32(dv.getUint32(at + 4) + 8 + k * 4, Math.round(v * 65536)));
  }
  assert.equal(classifyIcc(fakeSrgb), 'srgb');
});

test('resets EXIF orientation in both byte orders', () => {
  for (const le of [false, true]) {
    const b = new DataView(new ArrayBuffer(26));
    b.setUint16(0, le ? 0x4949 : 0x4d4d);
    b.setUint16(2, 42, le);
    b.setUint32(4, 8, le);
    b.setUint16(8, 1, le);
    b.setUint16(10, 0x0112, le);
    b.setUint16(12, 3, le);
    b.setUint32(14, 1, le);
    b.setUint16(18, 6, le);
    const out = new DataView(exifWithUprightOrientation(new Uint8Array(b.buffer)).buffer);
    assert.equal(out.getUint16(18, le), 1);
    assert.equal(b.getUint16(18, le), 6, 'input untouched');
  }
});
