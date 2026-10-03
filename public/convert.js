import { readJpegMeta, classifyIcc, exifWithUprightOrientation } from './jpeg-meta.js';
import { DISPLAY_P3_ICC } from './icc.js';
import { PngEncoder, GrayMismatch } from './png.js';
import { crc32 } from './zip.js';
import { isHeic, readHeifColor, decodeHeicNatively, decodeHeicWasm } from './heic.js';
import { WEBP_MAX_DIMENSION } from './webp.js';

// Image -> PNG (or lossless WebP) without further quality loss. The source
// is decoded once (honouring its orientation) and its pixels are written by
// a lossless encoder.
//  - Pixels are read back in horizontal strips, so every canvas stays small
//    (iOS Safari refuses canvases above ~16.7 megapixels) and memory use is
//    bounded even for very large photos.
//  - Wide-gamut photos (Display P3, Adobe RGB...) are read in Display P3
//    where the browser supports it, and the PNG carries a P3 profile.
//  - Grayscale JPEGs become 1-channel PNGs and colour ones 3-channel (JPEGs
//    have no transparency), which keeps files smaller without changing a pixel.

const STRIP_PIXELS = 4_000_000;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The file's real format, from its first bytes (file names can be wrong:
 * some devices save PNG screenshots with a .jpg name).
 * @returns {Promise<'jpeg'|'heic'|'png'|'webp'|'gif'|'bmp'|'tiff'|null>}
 */
export async function detectFormat(blob) {
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const ascii = (from, to) => String.fromCharCode(...head.subarray(from, to));
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.length >= 12 && isHeic(head)) return 'heic';
  if (PNG_SIGNATURE.every((b, i) => head[i] === b)) return 'png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(0, 2) === 'BM') return 'bmp';
  if (ascii(0, 4) === 'II*\0' || ascii(0, 4) === 'MM\0*') return 'tiff'; // also DNG (RAW)
  return null;
}

const UNSUPPORTED = {
  webp: 'הקובץ הוא בפועל WebP ולא JPG, ולכן לא הומר',
  gif: 'הקובץ הוא בפועל GIF ולא JPG, ולכן לא הומר',
  bmp: 'הקובץ הוא בפועל BMP ולא JPG, ולכן לא הומר',
  tiff: 'הקובץ הוא TIFF או RAW (DNG) ולא JPG – פורמט זה אינו נתמך',
};

/**
 * A file that is already a PNG (typically a screenshot saved with a .jpg
 * name): it is kept byte-for-byte and only gets the right extension.
 */
async function passThroughPng(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(bytes.buffer);
  const bitmap = await decodeBitmap(file);
  try {
    return {
      blob: new Blob([bytes], { type: 'image/png' }),
      crc: crc32(bytes),
      width: dv.getUint32(16),
      height: dv.getUint32(20),
      extension: 'png',
      wideGamut: false,
      alreadyPng: true,
      thumb: await thumbnail({ bitmap }),
    };
  } finally {
    bitmap.close();
  }
}

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

let p3Support;
export function supportsP3() {
  if (p3Support === undefined) {
    try {
      // getContextAttributes() is missing on OffscreenCanvas in some browsers,
      // so check the colour space of the pixels the context actually returns.
      const ctx = makeCanvas(1, 1).getContext('2d', { colorSpace: 'display-p3' });
      p3Support = ctx?.getImageData(0, 0, 1, 1, { colorSpace: 'display-p3' }).colorSpace === 'display-p3';
    } catch {
      p3Support = false;
    }
  }
  return p3Support;
}

function physFromDensity(d) {
  if (!d || !d.x || !d.y) return undefined;
  const perMetre = (v) => Math.round(d.units === 1 ? v / 0.0254 : v * 100);
  return { x: perMetre(d.x), y: perMetre(d.y) };
}

async function decodeBitmap(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('לא ניתן לפענח את התמונה');
  }
}

/**
 * A decoded source image: either an ImageBitmap the browser colour-manages
 * (`bitmap`), or raw RGBA pixels in the image's own colour space (`raw`,
 * from the HEIC decoder) together with the profile that describes them.
 */
async function loadSource(file, kind, keepMetadata) {
  if (kind === 'jpeg') {
    const meta = await readJpegMeta(file);
    const wide = classifyIcc(meta.icc) === 'wide' && supportsP3();
    return {
      bitmap: await decodeBitmap(file),
      wide,
      gray: meta.components === 1 && !wide,
      exif: keepMetadata && meta.exif ? exifWithUprightOrientation(meta.exif) : undefined,
      phys: physFromDensity(meta.density),
    };
  }

  // HEIC
  const bytes = new Uint8Array(await file.arrayBuffer());
  const color = readHeifColor(bytes);
  const wideSource = color.icc ? classifyIcc(color.icc) === 'wide' : color.primaries === 12;
  const bitmap = await decodeHeicNatively(file);
  if (bitmap) return { bitmap, wide: wideSource && supportsP3() };
  const raw = await decodeHeicWasm(bytes);
  // libheif returns the pixels unconverted, so the PNG gets the photo's own
  // profile (or Display P3 for P3 'nclx' photos): colours stay exact.
  let icc;
  if (color.icc && classifyIcc(color.icc) !== 'srgb') icc = { name: 'ICC Profile', data: color.icc };
  else if (color.primaries === 12) icc = { name: 'Display P3', data: DISPLAY_P3_ICC };
  return { raw, icc, wide: wideSource };
}

async function encodePng(src) {
  const { bitmap, raw } = src;
  const width = bitmap?.width ?? raw.width;
  const height = bitmap?.height ?? raw.height;
  const colorSpace = bitmap && src.wide ? 'display-p3' : 'srgb';
  const stripRows = Math.max(1, Math.min(height, Math.floor(STRIP_PIXELS / width)));

  let icc;
  if (raw) icc = src.icc;
  else if (src.wide) icc = { name: 'Display P3', data: DISPLAY_P3_ICC };
  const png = new PngEncoder({
    width, height, gray: src.gray, icc, srgb: !icc, exif: src.exif, phys: src.phys,
  });

  let ctx;
  if (bitmap) {
    ctx = makeCanvas(width, stripRows).getContext('2d', { colorSpace, willReadFrequently: true });
    if (!ctx) throw new Error('התמונה גדולה מדי לעיבוד בדפדפן');
  }
  try {
    for (let y = 0; y < height; y += stripRows) {
      const rows = Math.min(stripRows, height - y);
      let data;
      if (bitmap) {
        ctx.clearRect(0, 0, width, stripRows);
        ctx.drawImage(bitmap, 0, y, width, rows, 0, 0, width, rows);
        data = ctx.getImageData(0, 0, width, rows, { colorSpace }).data;
      } else {
        data = raw.data.subarray(y * width * 4, (y + rows) * width * 4);
      }
      await png.writeRgba(data, rows);
    }
    return { ...(await png.finish()), width, height, extension: 'png' };
  } catch (err) {
    png.abort();
    throw err;
  }
}

async function encodeWebp(src) {
  const { bitmap, raw } = src;
  const width = bitmap?.width ?? raw.width;
  const height = bitmap?.height ?? raw.height;
  if (width > WEBP_MAX_DIMENSION || height > WEBP_MAX_DIMENSION) {
    throw new Error(`WebP מוגבל ל-${WEBP_MAX_DIMENSION} פיקסלים בכל צד; בחרו PNG`);
  }
  const colorSpace = src.wide ? 'display-p3' : 'srgb';
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { colorSpace });
  if (!ctx) throw new Error('התמונה גדולה מדי לעיבוד בדפדפן');
  if (bitmap) {
    ctx.drawImage(bitmap, 0, 0);
  } else {
    ctx.putImageData(new ImageData(raw.data, width, height, { colorSpace }), 0, 0);
  }
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: 'image/webp', quality: 1 })
    : await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 1));
  if (!blob || blob.type !== 'image/webp') throw new Error('הדפדפן לא תומך בשמירה כ-WebP');
  await verifyLossless(ctx, blob, width, height, colorSpace);
  const crc = crc32(new Uint8Array(await blob.arrayBuffer()));
  return { blob, crc, width, height, extension: 'webp' };
}

/**
 * Decode the encoded WebP and compare it with the source pixels: the
 * browser's encoder is not guaranteed to be lossless, so never hand out a
 * file that differs from the original.
 */
async function verifyLossless(ctx, blob, width, height, colorSpace) {
  const bitmap = await createImageBitmap(blob);
  try {
    const check = makeCanvas(width, height).getContext('2d', { colorSpace, willReadFrequently: true });
    const stripRows = Math.max(1, Math.min(height, Math.floor(STRIP_PIXELS / width)));
    for (let y = 0; y < height; y += stripRows) {
      const rows = Math.min(stripRows, height - y);
      check.clearRect(0, 0, width, rows);
      check.drawImage(bitmap, 0, y, width, rows, 0, 0, width, rows);
      const a = ctx.getImageData(0, y, width, rows, { colorSpace }).data;
      const b = check.getImageData(0, 0, width, rows, { colorSpace }).data;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) throw new Error('הדפדפן לא שמר את ה-WebP ללא אובדן; בחרו PNG');
      }
    }
  } finally {
    bitmap.close();
  }
}

async function thumbnail(src) {
  const image = src.bitmap ?? (await createImageBitmap(new ImageData(src.raw.data, src.raw.width, src.raw.height)));
  try {
    const size = 96;
    const scale = Math.min(1, size / Math.max(image.width, image.height));
    const w = Math.max(1, Math.round(image.width * scale));
    const h = Math.max(1, Math.round(image.height * scale));
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, w, h);
    if (canvas.convertToBlob) return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  } finally {
    if (image !== src.bitmap) image.close();
  }
}

/**
 * Convert a JPEG or HEIC File/Blob.
 * @param {Blob} file
 * @param {{keepMetadata?: boolean, format?: 'png'|'webp'}} [options]
 * @returns {Promise<{blob: Blob, crc: number, width: number, height: number,
 *   extension: string, wideGamut: boolean, thumb: Blob}>}
 */
export async function convertImage(file, { keepMetadata = false, format = 'png' } = {}) {
  const kind = await detectFormat(file);
  if (kind === 'png') return passThroughPng(file);
  if (UNSUPPORTED[kind]) throw new Error(UNSUPPORTED[kind]);
  if (!kind) throw new Error('הקובץ אינו תמונת JPG תקינה – ייתכן שהוא פגום או שלא הועתק עד הסוף');
  const src = await loadSource(file, kind, keepMetadata);
  try {
    let result;
    if (format === 'webp') {
      result = await encodeWebp(src);
    } else {
      try {
        result = await encodePng(src);
      } catch (err) {
        if (!(err instanceof GrayMismatch)) throw err;
        result = await encodePng({ ...src, gray: false });
      }
    }
    return { ...result, wideGamut: !!src.wide, thumb: await thumbnail(src) };
  } finally {
    src.bitmap?.close();
  }
}
