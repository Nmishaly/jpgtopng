import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DISPLAY_P3_ICC } from '../public/icc.js';
import {
  makeJpeg, insertSegment, withIccProfile, maxPixelDiff, waitForIdle, downloadItem, readZip, pngChunks,
} from './helpers.js';

const HEIC_FIXTURE = 'e2e/fixtures/example.heic'; // downloaded by CI, see README

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

// ---------- Conversion correctness: every browser engine ----------

test('converts a batch and downloads a valid ZIP with exact pixels', async ({ page }) => {
  const files = [];
  for (let i = 0; i < 25; i++) {
    files.push({ name: `photo_${i}.jpg`, mimeType: 'image/jpeg', buffer: await makeJpeg(page, 300 + i * 7, 200, { seed: i + 1 }) });
  }
  files.push({ name: 'תמונה.jpg', mimeType: 'image/jpeg', buffer: files[0].buffer });
  await page.setInputFiles('#file-input', files);
  await waitForIdle(page);
  await expect(page.locator('#status-text')).toHaveText(/26 מתוך 26/);

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#download-zip')]);
  const zip = readZip(await download.path());
  expect(Object.keys(zip)).toHaveLength(26);
  expect(zip['תמונה.png']).toBeTruthy();
  expect(await maxPixelDiff(page, files[3].buffer, zip['photo_3.png'])).toBe(0);
});

test('keeps pixels exact for a 24-megapixel photo (strip encoding)', async ({ page }) => {
  const jpeg = await makeJpeg(page, 6000, 4000, { seed: 7 });
  await page.setInputFiles('#file-input', [{ name: 'big.jpg', mimeType: 'image/jpeg', buffer: jpeg }]);
  await waitForIdle(page);
  const { bytes } = await downloadItem(page);
  const chunks = pngChunks(bytes);
  expect(chunks[0].data[9]).toBe(2); // RGB, no unused alpha channel
  expect(await maxPixelDiff(page, jpeg, bytes)).toBe(0);
});

test('applies EXIF rotation; keeps EXIF only when asked', async ({ page }) => {
  // EXIF block with orientation 6 (rotate 90° clockwise).
  const tiff = Buffer.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
  const jpeg = insertSegment(await makeJpeg(page, 300, 200), 0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]));

  await page.setInputFiles('#file-input', [{ name: 'a.jpg', mimeType: 'image/jpeg', buffer: jpeg }]);
  await waitForIdle(page);
  await expect(page.locator('li .meta')).toContainText('200×300');
  let { bytes } = await downloadItem(page);
  expect(pngChunks(bytes).some((c) => c.type === 'eXIf')).toBe(false);
  expect(await maxPixelDiff(page, jpeg, bytes)).toBe(0);
  await page.click('#clear');

  await page.check('#keep-metadata');
  await page.setInputFiles('#file-input', [{ name: 'b.jpg', mimeType: 'image/jpeg', buffer: jpeg }]);
  await waitForIdle(page);
  ({ bytes } = await downloadItem(page));
  const exif = pngChunks(bytes).find((c) => c.type === 'eXIf');
  expect(exif).toBeTruthy();
  expect(exif.data.readUInt16BE(18)).toBe(1); // orientation reset: pixels are already upright
});

test('manual EXIF rotation (used on old engines) matches the browser for all 8 orientations', async ({ page }) => {
  // Old engines can't rotate by EXIF, so the app rotates pixels itself. Check
  // that transform against this browser's own EXIF handling.
  const base = await makeJpeg(page, 60, 40, { seed: 5 });
  const tiff = (o) => Buffer.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0]);
  const tagged = [1, 2, 3, 4, 5, 6, 7, 8].map((o) =>
    insertSegment(base, 0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff(o)])).toString('base64'));
  const results = await page.evaluate(async ([baseB64, tagged]) => {
    const { orient } = await import('/convert.js');
    const blob = (b64) => new Blob([Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))]);
    const pixels = (bm) => {
      const c = document.createElement('canvas');
      c.width = bm.width;
      c.height = bm.height;
      const x = c.getContext('2d');
      x.drawImage(bm, 0, 0);
      return { w: bm.width, h: bm.height, d: x.getImageData(0, 0, bm.width, bm.height).data };
    };
    const upright = await createImageBitmap(blob(baseB64)); // no EXIF: decoded as stored
    const out = [];
    for (let o = 1; o <= 8; o++) {
      const n = pixels(await createImageBitmap(blob(tagged[o - 1]), { imageOrientation: 'from-image' }));
      const m = pixels(o === 1 ? upright : await orient(upright, o));
      if (n.w !== m.w || n.h !== m.h) {
        out.push(`orientation ${o}: ${n.w}x${n.h} vs ${m.w}x${m.h}`);
        continue;
      }
      let diff = 0;
      for (let k = 0; k < n.d.length; k++) diff = Math.max(diff, Math.abs(n.d[k] - m.d[k]));
      out.push(`orientation ${o}: ${n.w}x${n.h} diff ${diff}`);
    }
    return out;
  }, [base.toString('base64'), tagged]);
  expect(results).toEqual([
    'orientation 1: 60x40 diff 0', 'orientation 2: 60x40 diff 0', 'orientation 3: 60x40 diff 0',
    'orientation 4: 60x40 diff 0', 'orientation 5: 40x60 diff 0', 'orientation 6: 40x60 diff 0',
    'orientation 7: 40x60 diff 0', 'orientation 8: 40x60 diff 0',
  ]);
});

test('keeps wide-gamut (Display P3) colours', async ({ page }) => {
  const p3 = await page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d', { colorSpace: 'display-p3' });
    return ctx?.getContextAttributes?.().colorSpace === 'display-p3';
  });
  test.skip(!p3, 'browser has no Display P3 canvas');
  const jpeg = withIccProfile(await makeJpeg(page, 400, 300, { seed: 3 }), DISPLAY_P3_ICC);
  await page.setInputFiles('#file-input', [{ name: 'p3.jpg', mimeType: 'image/jpeg', buffer: jpeg }]);
  await waitForIdle(page);
  await expect(page.locator('li .meta')).toContainText('P3');
  const { bytes } = await downloadItem(page);
  expect(pngChunks(bytes).some((c) => c.type === 'iCCP')).toBe(true);
  expect(await maxPixelDiff(page, jpeg, bytes, { colorSpace: 'display-p3' })).toBeLessThanOrEqual(1);
});

test('converts HEIC photos', async ({ page }) => {
  test.skip(!existsSync(HEIC_FIXTURE), 'HEIC fixture not downloaded');
  await page.setInputFiles('#file-input', [HEIC_FIXTURE]);
  await waitForIdle(page);
  await expect(page.locator('li .state')).toHaveText('הושלם');
  await expect(page.locator('li .meta')).toContainText('1280×854');
  const { name, bytes } = await downloadItem(page);
  expect(name).toBe('example.png');
  expect(bytes.subarray(1, 4).toString()).toBe('PNG');
});

test('WebP output is never lossy: pixel-exact or refused', async ({ page }) => {
  await page.waitForTimeout(500); // let the WebP capability check finish
  test.skip(!(await page.isVisible('#format-field')), 'no lossless WebP encoder in this browser');
  await page.selectOption('#format', 'webp');
  const jpeg = await makeJpeg(page, 500, 300, { seed: 9 });
  await page.setInputFiles('#file-input', [{ name: 'w.jpg', mimeType: 'image/jpeg', buffer: jpeg }]);
  await waitForIdle(page);
  if (await page.locator('li.error').count()) {
    // The browser's encoder was lossy for this image: the file must be refused.
    await expect(page.locator('li .state')).toContainText('בחרו PNG');
    return;
  }
  const { name, bytes } = await downloadItem(page);
  expect(name).toBe('w.webp');
  expect(bytes.subarray(8, 12).toString()).toBe('WEBP');
  expect(await maxPixelDiff(page, jpeg, bytes)).toBe(0);
});

test('rejects files that are not images', async ({ page }) => {
  await page.setInputFiles('#file-input', [{ name: 'fake.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('nope') }]);
  await waitForIdle(page);
  await expect(page.locator('li.error .state')).toContainText('אינו תמונת JPG תקינה');
  await expect(page.locator('#download-zip')).toBeDisabled();
});

test('a PNG screenshot saved with a .jpg name is kept as-is and renamed', async ({ page }) => {
  // Some devices (e.g. drone controllers) save PNG screenshots as *.jpg.
  const png = Buffer.from(await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 240;
    const x = c.getContext('2d');
    x.fillStyle = '#2a6';
    x.fillRect(0, 0, 320, 240);
    x.fillStyle = '#fff';
    x.fillText('screenshot', 20, 40);
    const b = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
    return Array.from(b);
  }));
  await page.setInputFiles('#file-input', [{ name: '30.09.2026_120405_screenshot.jpg', mimeType: 'image/jpeg', buffer: png }]);
  await waitForIdle(page);
  await expect(page.locator('li .state')).toHaveText('כבר היה PNG – נשמר בשם הנכון');
  await expect(page.locator('li .meta')).toContainText('320×240');
  const { name, bytes } = await downloadItem(page);
  expect(name).toBe('30.09.2026_120405_screenshot.png');
  expect(bytes.equals(png)).toBe(true);
});

test('says what a mislabelled non-JPG file really is', async ({ page }) => {
  const dng = Buffer.concat([Buffer.from('II*\0', 'latin1'), Buffer.alloc(60)]); // TIFF/DNG header
  await page.setInputFiles('#file-input', [{ name: 'DJI_0001.jpg', mimeType: 'image/jpeg', buffer: dng }]);
  await waitForIdle(page);
  await expect(page.locator('li.error .state')).toContainText('RAW (DNG)');
});

// ---------- Page behaviour: Chromium only (no engine-specific image work) ----------

test.describe('interface', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'UI wiring is browser-independent');

  test('remove and stop', async ({ page }) => {
    const dir = join(tmpdir(), `jpgtopng-stop-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const jpeg = await makeJpeg(page, 3000, 2000);
    const paths = Array.from({ length: 30 }, (_, i) => {
      writeFileSync(join(dir, `f${i}.jpg`), jpeg);
      return join(dir, `f${i}.jpg`);
    });
    await page.setInputFiles('#file-input', paths);
    await page.click('#stop');
    await waitForIdle(page);
    const left = await page.locator('#file-list li').count();
    expect(left).toBeLessThan(30);
    expect(left).toBeGreaterThan(0);
    await page.locator('#file-list li .remove').first().click();
    await expect(page.locator('#file-list li')).toHaveCount(left - 1);
  });

  test('folder selection skips non-images, including nested folders', async ({ page }) => {
    const dir = join(tmpdir(), `jpgtopng-folder-${Date.now()}`);
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'a.jpg'), await makeJpeg(page, 120, 80));
    writeFileSync(join(dir, 'sub', 'b.jpeg'), await makeJpeg(page, 80, 120, { seed: 2 }));
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    await page.setInputFiles('#folder-input', dir);
    await waitForIdle(page);
    await expect(page.locator('#file-list li.done')).toHaveCount(2);
    await expect(page.locator('#message')).toContainText('דולג');
  });

  test('pasting an image converts it', async ({ page }) => {
    const b64 = (await makeJpeg(page, 120, 80)).toString('base64');
    await page.evaluate((b64) => {
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'image.jpg', { type: 'image/jpeg' }));
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt }));
    }, b64);
    await waitForIdle(page);
    await expect(page.locator('li .state')).toHaveText('הושלם');
    await expect(page.locator('li .name bdi')).toHaveText(/^pasted-.*\.jpg$/);
  });

  test('works offline once loaded, and says so', async ({ page, context }) => {
    await expect(page.locator('#offline-status')).toHaveText('מוכן לעבודה ללא אינטרנט');
    await page.reload();
    await context.setOffline(true);
    await expect(page.locator('#offline-status')).toContainText('אין חיבור לאינטרנט');
    await page.reload();
    await expect(page.locator('#dropzone')).toBeVisible();
    await expect(page.locator('#offline-status')).toContainText('אין חיבור לאינטרנט');
    await page.setInputFiles('#file-input', [{ name: 'o.jpg', mimeType: 'image/jpeg', buffer: await makeJpeg(page, 100, 100) }]);
    await waitForIdle(page);
    await expect(page.locator('li .state')).toHaveText('הושלם');
  });

  test('offline guide lists the visitor\'s own device first', async ({ page }) => {
    await expect(page.locator('#offline-help')).toBeVisible();
    await page.click('#offline-details summary');
    const first = page.locator('#install-guides section').first();
    await expect(first).toHaveAttribute('data-platform', 'desktop');
    await expect(first).toHaveClass(/current/);
  });

  test('offline guide highlights iPhone instructions on an iPhone', async ({ browser }) => {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await page.goto('/');
    await page.click('#offline-details summary');
    await expect(page.locator('#install-guides section').first()).toHaveAttribute('data-platform', 'ios');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await context.close();
  });

  test('shows the author credit and fits a phone screen', async ({ page }) => {
    await expect(page.locator('footer .credit')).toContainText('Netzer Mishaly');
    await page.setViewportSize({ width: 360, height: 740 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

