// End-to-end check of the Android app on an emulator (run by CI after
// `adb install`): drives the WebView inside the debug build through
// Playwright and verifies conversion, saving to the device, and ZIP output.
import { _android as android } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PKG = 'com.netzermishaly.jpgtopng';
const HEIC = 'e2e/fixtures/example.heic';

const log = (...a) => console.log('[smoke]', ...a);
const fail = (msg) => {
  throw new Error(msg);
};

const [device] = await android.devices();
if (!device) fail('no Android device');
const sh = async (cmd) => (await device.shell(cmd)).toString();
log('device', device.model(), 'API', (await sh('getprop ro.build.version.sdk')).trim());

// Android 9 and older ask for the storage permission at first save; grant it upfront.
await sh(`pm grant ${PKG} android.permission.WRITE_EXTERNAL_STORAGE`).catch(() => {});
await sh(`rm -rf /sdcard/Pictures/JPGtoPNG /sdcard/Download/JPGtoPNG`);
await sh(`am start -W -n ${PKG}/.MainActivity`);

const webview = await device.webView({ pkg: PKG }, { timeout: 120_000 });
const page = await webview.page();
page.on('console', (m) => log('console:', m.text()));
page.on('pageerror', (e) => log('pageerror:', e.message));
await page.waitForSelector('#dropzone', { timeout: 60_000 });

async function waitIdle() {
  await page.waitForFunction(
    () => !document.getElementById('summary').hidden && document.getElementById('stop').hidden,
    null,
    { timeout: 300_000 },
  );
}

/** Feed files to the page the way dropping them on the drop zone does. */
async function paste(files) {
  await page.evaluate((files) => {
    const dt = new DataTransfer();
    for (const f of files) {
      const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: f.type }));
    }
    const drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    document.getElementById('dropzone').dispatchEvent(drop);
  }, files);
}

async function makeJpeg(w, h, seed) {
  return page.evaluate(async ([w, h, seed]) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, `hsl(${seed * 47},80%,50%)`);
    g.addColorStop(1, '#fff');
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    x.fillStyle = '#000';
    x.font = '60px sans-serif';
    x.fillText(`#${seed}`, 40, 100);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
    const bytes = new Uint8Array(await new Response(blob).arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, [w, h, seed]);
}

async function maxPixelDiff(aB64, bB64) {
  return page.evaluate(async ([a, b]) => {
    const decode = async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const bm = await createImageBitmap(new Blob([bytes]));
      const c = document.createElement('canvas');
      c.width = bm.width;
      c.height = bm.height;
      const x = c.getContext('2d');
      x.drawImage(bm, 0, 0);
      return { w: bm.width, h: bm.height, d: x.getImageData(0, 0, bm.width, bm.height).data };
    };
    const [p, q] = [await decode(a), await decode(b)];
    if (p.w !== q.w || p.h !== q.h) return -1;
    let m = 0;
    for (let i = 0; i < p.d.length; i++) m = Math.max(m, Math.abs(p.d[i] - q.d[i]));
    return m;
  }, [aB64, bB64]);
}

const pull = async (path) => device.shell(`cat '${path}'`);

// 1. Environment and isolation
await page.click('#diagnostics summary');
await page.waitForTimeout(1000);
log('diagnostics:', (await page.$eval('#diagnostics-list', (d) => d.innerText)).replace(/\n/g, ' | '));
if (!(await page.evaluate(() => !!window.AndroidBridge))) fail('AndroidBridge missing');
if (await page.isVisible('#offline-help')) fail('offline guide should be hidden in the app');
const network = await page.evaluate(() =>
  fetch('https://example.com/').then((r) => `status ${r.status}`, () => 'blocked'));
log('network request:', network);
if (network !== 'blocked' && network !== 'status 404') fail(`network was reachable: ${network}`);

// 2. Convert a 12-megapixel and a small JPEG, save one to the device, compare pixels
const big = await makeJpeg(4000, 3000, 1);
const small = await makeJpeg(640, 480, 2);
await paste([{ name: 'big.jpg', type: 'image/jpeg', b64: big }, { name: 'small.jpg', type: 'image/jpeg', b64: small }]);
await waitIdle();
const states = await page.$$eval('#file-list li', (lis) => lis.map((li) => `${li.className}: ${li.querySelector('.state').textContent} (${li.querySelector('.meta').textContent})`));
log('converted:', states);
if (!states.every((s) => s.startsWith('done'))) fail('conversion failed');

await page.locator('#file-list li .link').first().click();
await page.waitForFunction(() => /נשמר במכשיר|נכשלה/.test(document.getElementById('message').textContent), null, { timeout: 120_000 });
const saved = await page.textContent('#message');
log('save message:', saved);
const savedPath = saved.match(/Pictures\/JPGtoPNG\/[^\s]+\.png/);
if (!savedPath) fail(`unexpected save message: ${saved}`);
const png = await pull(`/sdcard/${savedPath[0]}`);
if (png.subarray(1, 4).toString() !== 'PNG') fail('saved file is not a PNG');
const diff = await maxPixelDiff(big, png.toString('base64'));
log('saved PNG', png.length, 'bytes, max pixel difference', diff);
if (diff !== 0) fail(`pixels differ (${diff})`);

// 3. HEIC
if (existsSync(HEIC)) {
  await page.click('#clear');
  await paste([{ name: 'photo.heic', type: 'image/heic', b64: readFileSync(HEIC).toString('base64') }]);
  await waitIdle();
  const heic = await page.textContent('#file-list li .state');
  log('HEIC:', heic, await page.textContent('#file-list li .meta'));
  if (heic !== 'הושלם') fail('HEIC conversion failed');
} else {
  log('HEIC fixture missing; skipped');
}

// 4. ZIP to Download/JPGtoPNG
await page.click('#clear');
await paste([1, 2, 3].map((i) => ({ name: `z${i}.jpg`, type: 'image/jpeg', b64: small })));
await waitIdle();
await page.click('#download-zip');
await page.waitForFunction(() => /\.zip|נכשלה/.test(document.getElementById('message').textContent), null, { timeout: 120_000 });
const zipMessage = await page.textContent('#message');
log('zip message:', zipMessage);
const zipPath = zipMessage.match(/Download\/JPGtoPNG\/[^\s]+\.zip/);
if (!zipPath) fail(`unexpected zip message: ${zipMessage}`);
const dir = mkdtempSync(join(tmpdir(), 'apk-zip-'));
writeFileSync(join(dir, 'out.zip'), await pull(`/sdcard/${zipPath[0]}`));
const names = execFileSync('python3', ['-c',
  'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(",".join(sorted(z.namelist())))',
  join(dir, 'out.zip')]).toString().trim();
log('zip entries:', names);
if (names !== 'z1.png,z2.png,z3.png') fail('zip content mismatch');

// 5. Automatic saving to the device
await page.click('#clear');
await page.click('#save-folder');
await paste([{ name: 'auto1.jpg', type: 'image/jpeg', b64: small }, { name: 'auto2.jpg', type: 'image/jpeg', b64: small }]);
await waitIdle();
await page.waitForFunction(() => [...document.querySelectorAll('#file-list li .state')].every((s) => s.textContent === 'נשמר במכשיר'), null, { timeout: 60_000 });
const listing = await sh('ls /sdcard/Pictures/JPGtoPNG/');
log('Pictures/JPGtoPNG:', listing.replace(/\n/g, ' '));
if (!/auto1\.png/.test(listing) || !/auto2\.png/.test(listing)) fail('auto-saved files missing');

await device.screenshot({ path: 'android-screenshot.png' });
log('ALL CHECKS PASSED');
await device.close();
