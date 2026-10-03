import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHeic, readHeifColor } from '../public/heic.js';
import { DISPLAY_P3_ICC } from '../public/icc.js';

const box = (type, payload) => {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set([...type].map((c) => c.charCodeAt(0)), 4);
  out.set(payload, 8);
  return out;
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const ftyp = box('ftyp', new Uint8Array([...'heic'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0])));

test('recognises HEIC brands', () => {
  assert.ok(isHeic(ftyp.subarray(0, 12)));
  assert.ok(!isHeic(box('ftyp', new Uint8Array([0x69, 0x73, 0x6f, 0x6d])).subarray(0, 12)));
});

test('extracts an embedded ICC profile from colr/prof', () => {
  const colr = box('colr', concat(new Uint8Array([0x70, 0x72, 0x6f, 0x66]), DISPLAY_P3_ICC));
  // Noise containing a stray 'colr' that is not a valid box must be skipped.
  const noise = new Uint8Array([0, 0, 0, 3, 0x63, 0x6f, 0x6c, 0x72, 1, 2, 3]);
  const color = readHeifColor(concat(ftyp, noise, colr));
  assert.deepEqual(color.icc, DISPLAY_P3_ICC);
});

test('reads nclx colour primaries', () => {
  const colr = box('colr', new Uint8Array([0x6e, 0x63, 0x6c, 0x78, 0, 12, 0, 13, 0, 6, 0x80]));
  assert.equal(readHeifColor(concat(ftyp, colr)).primaries, 12);
});

test('returns nothing when there is no colour box', () => {
  assert.deepEqual(readHeifColor(ftyp), {});
});
