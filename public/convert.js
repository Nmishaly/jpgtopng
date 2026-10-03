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

/** 'jpeg', 'heic', or null for anything else. */
export async function detectFormat(blob) {
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.length >= 12 && isHeic(head)) return 'heic';
  return null;
}

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

let p3Support;
function supportsP3() {
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
  const crc = crc32(new Uint8Array(await blob.arrayBuffer()));
  return { blob, crc, width, height, extension: 'webp' };
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
  if (!kind) throw new Error('הקובץ אינו JPG או HEIC תקין');
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
