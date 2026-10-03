import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, buildZipParts } from '../public/zip.js';

test('crc32 matches known values', () => {
  assert.equal(crc32(new TextEncoder().encode('')), 0);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

for (const forceZip64 of [false, true]) test(`builds a valid ${forceZip64 ? 'ZIP64 ' : ''}archive with UTF-8 names that a standard reader can extract`, async () => {
  const files = [
    { name: 'a.png', bytes: new TextEncoder().encode('hello') },
    { name: 'תמונה (1).png', bytes: new Uint8Array(1000).map((_, i) => i % 256) },
  ];
  const entries = files.map((f) => ({
    name: f.name,
    data: new Blob([f.bytes]),
    size: f.bytes.length,
    crc: crc32(f.bytes),
  }));
  const zip = new Blob(buildZipParts(entries, { forceZip64 }));
  const dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
  try {
    const zipPath = join(dir, 'out.zip');
    writeFileSync(zipPath, new Uint8Array(await zip.arrayBuffer()));
    // Python's zipfile is an independent reader that verifies CRCs and
    // honours the UTF-8 name flag regardless of the system locale.
    const read = (name) =>
      execFileSync('python3', [
        '-c',
        'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); ' +
          'assert z.testzip() is None; sys.stdout.buffer.write(z.read(sys.argv[2]))',
        zipPath,
        name,
      ]);
    for (const f of files) {
      assert.deepEqual(new Uint8Array(read(f.name)), f.bytes);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
