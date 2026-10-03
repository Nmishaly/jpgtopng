import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** Make a photo-like JPEG in the page (gradient + noise). Returns a Buffer. */
export async function makeJpeg(page, w, h, { seed = 1, quality = 0.92 } = {}) {
  const b64 = await page.evaluate(async ([w, h, seed, quality]) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, `hsl(${seed * 47},80%,50%)`);
    g.addColorStop(1, '#fff');
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    const img = x.getImageData(0, 0, w, h);
    let s = seed;
    for (let i = 0; i < img.data.length; i += 4) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const n = (s % 31) - 15;
      img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
    }
    x.putImageData(img, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let str = '';
    for (let i = 0; i < bytes.length; i += 0x8000) str += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(str);
  }, [w, h, seed, quality]);
  return Buffer.from(b64, 'base64');
}

/** Insert an APP segment right after the JPEG SOI marker. */
export function insertSegment(jpeg, marker, payload) {
  const len = payload.length + 2;
  const seg = Buffer.concat([Buffer.from([0xff, marker, len >> 8, len & 255]), payload]);
  return Buffer.concat([jpeg.subarray(0, 2), seg, jpeg.subarray(2)]);
}

/** Replace any embedded ICC profile (APP2 ICC_PROFILE segments) with `icc`. */
export function withIccProfile(jpeg, icc) {
  const kept = [jpeg.subarray(0, 2)];
  let p = 2;
  while (p + 4 <= jpeg.length && jpeg[p] === 0xff && jpeg[p + 1] !== 0xda) {
    const len = jpeg.readUInt16BE(p + 2);
    const isIcc = jpeg[p + 1] === 0xe2 && jpeg.toString('latin1', p + 4, p + 16) === 'ICC_PROFILE\0';
    if (!isIcc) kept.push(jpeg.subarray(p, p + 2 + len));
    p += 2 + len;
  }
  kept.push(jpeg.subarray(p));
  return insertSegment(Buffer.concat(kept), 0xe2,
    Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.from([1, 1]), Buffer.from(icc)]));
}

/**
 * Decode two images in the page and return the largest per-channel
 * difference, or null if the dimensions differ.
 */
export async function maxPixelDiff(page, a, b, { colorSpace = 'srgb' } = {}) {
  return page.evaluate(async ([a, b, colorSpace]) => {
    const decode = async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const bm = await createImageBitmap(new Blob([bytes]));
      const c = document.createElement('canvas');
      c.width = bm.width;
      c.height = bm.height;
      const x = c.getContext('2d', { colorSpace });
      x.drawImage(bm, 0, 0);
      return { w: bm.width, h: bm.height, d: x.getImageData(0, 0, bm.width, bm.height, { colorSpace }).data };
    };
    const [p, q] = [await decode(a), await decode(b)];
    if (p.w !== q.w || p.h !== q.h) return null;
    let m = 0;
    for (let i = 0; i < p.d.length; i++) m = Math.max(m, Math.abs(p.d[i] - q.d[i]));
    return m;
  }, [a.toString('base64'), b.toString('base64'), colorSpace]);
}

export async function waitForIdle(page) {
  await page.waitForFunction(
    () => !document.getElementById('summary').hidden && document.getElementById('stop').hidden,
    null,
    { timeout: 170_000 },
  );
}

export async function downloadItem(page, index = 0) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#file-list li .link').nth(index).click(),
  ]);
  return { name: download.suggestedFilename(), bytes: readFileSync(await download.path()) };
}

/** List and read a ZIP with Python's zipfile (an independent implementation). */
export function readZip(path) {
  const out = execFileSync('python3', ['-c', `
import sys, zipfile, json, base64
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
print(json.dumps({i.filename: base64.b64encode(z.read(i)).decode() for i in z.infolist()}))
`, path], { maxBuffer: 1 << 30 });
  return Object.fromEntries(Object.entries(JSON.parse(out)).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
}

export function pngChunks(bytes) {
  const types = [];
  for (let p = 8; p < bytes.length; p += 12 + bytes.readUInt32BE(p)) {
    types.push({ type: bytes.toString('latin1', p + 4, p + 8), data: bytes.subarray(p + 8, p + 8 + bytes.readUInt32BE(p)) });
  }
  return types;
}
