// Packages the site for the Android app (android/app/src/main/assets/www).
//
// The app runs on the device's built-in WebView, which on a controller that
// never goes online stays at its factory version. So the code is bundled
// and down-levelled to old Chrome (69), workers become classic scripts, and
// the zlib fallback is bundled in. Nothing is loaded from the network.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';

const src = new URL('../public/', import.meta.url);
const out = new URL('../android/app/src/main/assets/www/', import.meta.url);
const outPath = out.pathname;
rmSync(out, { recursive: true, force: true });
mkdirSync(new URL('vendor/libheif/', out), { recursive: true });

const common = {
  bundle: true,
  minify: true,
  target: ['chrome69'],
  define: { __WORKER_TYPE__: '"classic"' },
  legalComments: 'none',
  logLevel: 'warning',
};

// The page: an ES module (Chrome 61+); rarely used code (HEIC decoder on the
// main thread, zlib fallback) is split into chunks loaded on demand.
await build({
  ...common,
  entryPoints: [new URL('app.js', src).pathname],
  format: 'esm',
  splitting: true,
  outdir: outPath,
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
});

// The worker: one classic script. It loads the HEIC decoder with
// importScripts (see heic.js), so the ES-module build stays out of it.
await build({
  ...common,
  entryPoints: [new URL('worker.js', src).pathname],
  format: 'iife',
  outfile: new URL('worker.js', out).pathname,
  external: ['./vendor/libheif/*'],
});

copyFileSync(new URL('style.css', src), new URL('style.css', out));
copyFileSync(new URL('vendor/libheif/libheif-bundle.js', src), new URL('vendor/libheif/libheif-bundle.js', out));

// index.html without the web-only parts: the CSP <meta> (the app has no
// network access at all, and older WebViews don't know 'wasm-unsafe-eval'),
// the web-app manifest and icons.
let html = readFileSync(new URL('index.html', src), 'utf8');
html = html
  .replace(/\s*<!--[^>]*connect-src[\s\S]*?-->/, '')
  .replace(/\s*<meta http-equiv="Content-Security-Policy"[\s\S]*?>/, '')
  .replace(/\s*<link rel="(manifest|icon|apple-touch-icon)"[^>]*>/g, '');
writeFileSync(new URL('index.html', out), html);
console.log('Built', outPath);
