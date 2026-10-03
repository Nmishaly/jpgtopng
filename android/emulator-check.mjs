// End-to-end check of the Android app on an emulator (run by CI after
// `adb install`). It talks to the app's WebView over the Chrome DevTools
// Protocol directly: only Runtime.evaluate is used, which even the very old
// WebView of Android 9 supports (Playwright's richer attach hangs there).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PKG = 'com.netzermishaly.jpgtopng';
const HEIC = 'e2e/fixtures/example.heic';
const PORT = 9333;

const log = (...a) => console.log('[smoke]', ...a);
const fail = (msg) => {
  throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...args) => execFileSync('adb', args, { maxBuffer: 1 << 30 });
const sh = (cmd) => adb('shell', cmd).toString();

// ---------- Minimal DevTools client ----------

async function connect() {
  let pid = '';
  for (let i = 0; i < 60 && !pid; i++) {
    pid = sh(`pidof ${PKG} || true`).trim().split(/\s+/)[0];
    if (!pid) await sleep(1000);
  }
  if (!pid) fail('app process not found');
  const socket = `webview_devtools_remote_${pid}`;
  for (let i = 0; i < 60 && !sh('cat /proc/net/unix').includes(socket); i++) await sleep(1000);
  adb('forward', `tcp:${PORT}`, `localabstract:${socket}`);

  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = pages.find((p) => p.type === 'page' && p.url.includes('appassets'));
    } catch {
      // not ready yet
    }
    if (!target) await sleep(1000);
  }
  if (!target) fail('page not found over DevTools');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      log('console:', msg.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (msg.method === 'Runtime.exceptionThrown') {
      log('pageerror:', msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  return { send, close: () => ws.close() };
}

const cdp = await (async () => {
  log('device', sh('getprop ro.product.model').trim(), 'API', sh('getprop ro.build.version.sdk').trim());
  // Shared storage can lag behind boot on old emulators; wait until it is writable.
  for (let i = 0; i < 60; i++) {
    if (sh('mkdir -p /sdcard/Pictures && touch /sdcard/Pictures/.probe && echo ok || true').includes('ok')) break;
    await sleep(1000);
  }
  sh('rm -f /sdcard/Pictures/.probe');
  // Android 9 and older ask for the storage permission at first save; grant it upfront.
  if (Number(sh('getprop ro.build.version.sdk')) <= 28) {
    sh(`pm grant ${PKG} android.permission.WRITE_EXTERNAL_STORAGE`);
    const granted = sh(`dumpsys package ${PKG} | grep WRITE_EXTERNAL_STORAGE || true`).trim();
    log('storage permission:', granted.replace(/\s+/g, ' '));
    // The new storage access applies to processes started after it settles.
    sh(`am force-stop ${PKG}`);
    await sleep(3000);
  }
  sh('rm -rf /sdcard/Pictures/JPGtoPNG /sdcard/Download/JPGtoPNG');
  log('starting the app');
  sh(`am start -n ${PKG}/.MainActivity`);
  log('connecting over DevTools');
  const c = await connect();
  log('connected');
  return c;
})();

/** Run `fn(arg)` in the page (awaiting a returned promise) and return its value. */
async function evaluate(fn, arg) {
  const { result, error } = await cdp.send('Runtime.evaluate', {
    expression: `(${fn.toString()})(${JSON.stringify(arg ?? null)})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (error) fail(`DevTools error: ${error.message}`);
  if (result.exceptionDetails) {
    fail(`page error: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  }
  return result.result.value;
}

async function waitFor(fn, arg, timeout = 300_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await evaluate(fn, arg)) return;
    await sleep(500);
  }
  fail(`timed out waiting for ${fn.toString().slice(0, 120)}`);
}

const click = (selector) => evaluate((s) => document.querySelector(s).click(), selector);
const text = (selector) => evaluate((s) => document.querySelector(s).textContent, selector);
const waitIdle = () => waitFor(
  () => !document.getElementById('summary').hidden && document.getElementById('stop').hidden,
);

/** Feed files to the page the way dropping them on the drop zone does. */
async function drop(files) {
  await evaluate((files) => {
    const dt = new DataTransfer();
    for (const f of files) {
      const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: f.type }));
    }
    const event = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    document.getElementById('dropzone').dispatchEvent(event);
  }, files);
}

const makeJpeg = (w, h, seed) => evaluate(async ([w, h, seed]) => {
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

const maxPixelDiff = (a, b) => evaluate(async ([a, b]) => {
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
}, [a, b]);

const pull = (path) => adb('exec-out', 'cat', path);

// ---------- Checks ----------

await waitFor(() => !!document.getElementById('dropzone'), null, 60_000);

// 1. Environment and isolation
await click('#diagnostics summary');
await sleep(1500);
log('diagnostics:', (await evaluate(() => document.getElementById('diagnostics-list').innerText)).replace(/\n/g, ' | '));
if (!(await evaluate(() => !!window.AndroidBridge))) fail('AndroidBridge missing');
if (!(await evaluate(() => document.getElementById('offline-help').hidden))) fail('offline guide should be hidden in the app');
const network = await evaluate(() => fetch('https://example.com/').then((r) => `status ${r.status}`, () => 'blocked'));
log('network request:', network);
if (network !== 'blocked' && network !== 'status 404') fail(`network was reachable: ${network}`);

// 2. Convert a 12-megapixel and a small JPEG, save one to the device, compare pixels
const big = await makeJpeg(4000, 3000, 1);
const small = await makeJpeg(640, 480, 2);
await drop([{ name: 'big.jpg', type: 'image/jpeg', b64: big }, { name: 'small.jpg', type: 'image/jpeg', b64: small }]);
await waitIdle();
const states = await evaluate(() => [...document.querySelectorAll('#file-list li')].map((li) =>
  `${li.className}: ${li.querySelector('.state').textContent} (${li.querySelector('.meta').textContent})`));
log('converted:', states);
if (!states.every((s) => s.startsWith('done'))) fail('conversion failed');

await click('#file-list li .link');
await waitFor(() => /נשמר במכשיר|נכשלה/.test(document.getElementById('message').textContent), null, 120_000);
const saved = await text('#message');
log('save message:', saved);
const savedPath = saved.match(/\S*Pictures\/JPGtoPNG\/\S+\.png/);
if (!savedPath) fail(`unexpected save message: ${saved}`);
const png = pull(`/sdcard/${savedPath[0]}`);
if (png.subarray(1, 4).toString() !== 'PNG') fail('saved file is not a PNG');
const diff = await maxPixelDiff(big, png.toString('base64'));
log('saved PNG', png.length, 'bytes, max pixel difference', diff);
if (diff !== 0) fail(`pixels differ (${diff})`);

// 3. HEIC
if (existsSync(HEIC)) {
  await click('#clear');
  await drop([{ name: 'photo.heic', type: 'image/heic', b64: readFileSync(HEIC).toString('base64') }]);
  await waitIdle();
  const heic = await text('#file-list li .state');
  log('HEIC:', heic, await text('#file-list li .meta'));
  if (heic !== 'הושלם') fail('HEIC conversion failed');
} else {
  log('HEIC fixture missing; skipped');
}

// 4. ZIP to Download/JPGtoPNG
await click('#clear');
await drop([1, 2, 3].map((i) => ({ name: `z${i}.jpg`, type: 'image/jpeg', b64: small })));
await waitIdle();
await click('#download-zip');
await waitFor(() => /\.zip|נכשלה/.test(document.getElementById('message').textContent), null, 120_000);
const zipMessage = await text('#message');
log('zip message:', zipMessage);
const zipPath = zipMessage.match(/\S*Download\/JPGtoPNG\/\S+\.zip/);
if (!zipPath) fail(`unexpected zip message: ${zipMessage}`);
const dir = mkdtempSync(join(tmpdir(), 'apk-zip-'));
writeFileSync(join(dir, 'out.zip'), pull(`/sdcard/${zipPath[0]}`));
const names = execFileSync('python3', ['-c',
  'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(",".join(sorted(z.namelist())))',
  join(dir, 'out.zip')]).toString().trim();
log('zip entries:', names);
if (names !== 'z1.png,z2.png,z3.png') fail('zip content mismatch');

// 5. Automatic saving to the device. Turning it on saves what is already
// converted, and then each new file.
await click('#clear');
await drop([{ name: 'auto1.jpg', type: 'image/jpeg', b64: small }]);
await waitIdle();
await click('#save-folder');
await drop([{ name: 'auto2.jpg', type: 'image/jpeg', b64: small }]);
await waitIdle();
await waitFor(() => [...document.querySelectorAll('#file-list li .state')]
  .every((s) => s.textContent === 'נשמר במכשיר'), null, 60_000);
const listing = sh('ls /sdcard/Pictures/JPGtoPNG/');
log('Pictures/JPGtoPNG:', listing.replace(/\n/g, ' '));
if (!/auto1\.png/.test(listing) || !/auto2\.png/.test(listing)) fail('auto-saved files missing');

writeFileSync('android-screenshot.png', adb('exec-out', 'screencap', '-p'));
log('ALL CHECKS PASSED');
cdp.close();
