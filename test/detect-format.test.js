import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat } from '../public/convert.js';

const blob = (...parts) => new Blob([new Uint8Array(parts.flat())]);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

test('detects formats from content, not from the file name', async () => {
  assert.equal(await detectFormat(blob([0xff, 0xd8, 0xff, 0xe0], Array(8).fill(0))), 'jpeg');
  assert.equal(await detectFormat(blob([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13])), 'png');
  assert.equal(await detectFormat(blob([0, 0, 0, 24], ascii('ftypheic'))), 'heic');
  assert.equal(await detectFormat(blob(ascii('RIFF'), [0, 0, 0, 0], ascii('WEBP'))), 'webp');
  assert.equal(await detectFormat(blob(ascii('GIF89a'), Array(6).fill(0))), 'gif');
  assert.equal(await detectFormat(blob(ascii('BM'), Array(10).fill(0))), 'bmp');
  assert.equal(await detectFormat(blob(ascii('II*'), [0], Array(8).fill(0))), 'tiff');
  assert.equal(await detectFormat(blob(ascii('MM'), [0, 42], Array(8).fill(0))), 'tiff');
  assert.equal(await detectFormat(blob(ascii('hello world!'))), null);
  assert.equal(await detectFormat(blob([])), null);
});
