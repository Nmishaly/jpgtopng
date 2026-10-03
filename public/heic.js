// HEIC/HEIF (iPhone photo format) decoding. Safari decodes HEIC natively;
// elsewhere the libheif WebAssembly decoder is loaded on first use.

// The Android app's build for older WebViews runs workers as classic scripts
// (it defines __WORKER_TYPE__ = 'classic'); those load the classic-script
// build of the decoder with importScripts instead of a dynamic import.
const CLASSIC_WORKER = typeof __WORKER_TYPE__ !== 'undefined' && __WORKER_TYPE__ === 'classic'
  && typeof importScripts === 'function';

let libheif;
async function loadLibheif() {
  if (!libheif) {
    libheif = CLASSIC_WORKER
      ? Promise.resolve().then(() => {
        importScripts(new URL('vendor/libheif/libheif-bundle.js', self.location.href).href);
        return self.libheif();
      })
      : import('./vendor/libheif/libheif-bundle.mjs').then((m) => m.default());
  }
  return libheif;
}

const BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

export function isHeic(head) {
  const s = String.fromCharCode(...head.subarray(4, 12));
  return s.startsWith('ftyp') && BRANDS.has(s.slice(4));
}

/**
 * Colour information from the HEIF 'colr' property: the embedded ICC
 * profile ('prof'/'rICC'), or the colour primaries code of an 'nclx' box.
 */
export function readHeifColor(bytes) {
  for (let i = bytes.indexOf(0x63, 4); i > 0 && i + 8 < bytes.length; i = bytes.indexOf(0x63, i + 1)) {
    if (bytes[i + 1] !== 0x6f || bytes[i + 2] !== 0x6c || bytes[i + 3] !== 0x72) continue; // 'colr'
    const size = ((bytes[i - 4] << 24) | (bytes[i - 3] << 16) | (bytes[i - 2] << 8) | bytes[i - 1]) >>> 0;
    if (size < 12 || size > 4 * 1024 * 1024 || i - 4 + size > bytes.length) continue;
    const type = String.fromCharCode(...bytes.subarray(i + 4, i + 8));
    if (type === 'prof' || type === 'rICC') {
      const icc = bytes.slice(i + 8, i - 4 + size);
      if (String.fromCharCode(...icc.subarray(36, 40)) === 'acsp') return { icc };
    } else if (type === 'nclx') {
      return { primaries: (bytes[i + 8] << 8) | bytes[i + 9] };
    }
  }
  return {};
}

/** Decode with the browser if it can (Safari), else null. */
export async function decodeHeicNatively(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
}

const WORKER_TYPE = typeof __WORKER_TYPE__ !== 'undefined' ? __WORKER_TYPE__ : 'module';
let helper;
let nextJob = 0;
const jobs = new Map();

/** Decode HEIC in a helper worker (see heic-worker.js), or null if none can start. */
function decodeInHelperWorker(bytes) {
  if (!helper) {
    try {
      helper = new Worker(new URL('./heic-worker.js', import.meta.url), { type: WORKER_TYPE });
    } catch {
      return null;
    }
    helper.onmessage = ({ data }) => {
      const job = jobs.get(data.id);
      jobs.delete(data.id);
      if (job) data.ok ? job.resolve(data) : job.reject(new Error(data.error));
    };
    helper.onerror = (e) => {
      e.preventDefault();
      for (const job of jobs.values()) job.reject(new Error('לא ניתן לפענח את קובץ ה-HEIC'));
      jobs.clear();
    };
  }
  const id = ++nextJob;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject });
    helper.postMessage({ id, bytes });
  });
}

/** Decode with libheif. Returns raw RGBA pixels in the image's own colour space. */
export async function decodeHeicWasm(bytes) {
  // On the main thread, hand the work to a worker (see heic-worker.js).
  if (typeof document !== 'undefined' && typeof Worker !== 'undefined') {
    const viaWorker = decodeInHelperWorker(bytes);
    if (viaWorker) return viaWorker;
  }
  const lib = await loadLibheif();
  const decoder = new lib.HeifDecoder();
  const images = decoder.decode(bytes);
  try {
    // libheif-js 1.19.8's is_primary() is broken (references an undefined
    // function); the first top-level image is the primary one in practice.
    const image = images[0];
    if (!image) throw new Error('לא ניתן לפענח את קובץ ה-HEIC');
    const width = image.get_width();
    const height = image.get_height();
    const target = { data: new Uint8ClampedArray(width * height * 4), width, height };
    const result = await new Promise((resolve) => image.display(target, resolve));
    if (!result) throw new Error('לא ניתן לפענח את קובץ ה-HEIC');
    return target;
  } finally {
    for (const im of images) im.free();
  }
}
