import { crc32 } from './zip.js';

// Lossless decode -> re-encode. The JPEG is decoded once (honouring its EXIF
// orientation) and every decoded pixel is written to PNG, which is a lossless
// format, so no further quality is lost.

export async function isJpeg(file) {
  const head = new Uint8Array(await file.slice(0, 3).arrayBuffer());
  return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
}

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasToPng(canvas) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('יצירת PNG נכשלה'))),
      'image/png',
    ),
  );
}

/**
 * Convert a JPEG File/Blob into a PNG Blob.
 * @returns {Promise<{blob: Blob, crc: number, width: number, height: number}>}
 */
export async function convertJpegToPng(file) {
  if (!(await isJpeg(file))) throw new Error('הקובץ אינו JPEG תקין');

  let bitmap;
  try {
    bitmap = await createImageBitmap(file, {
      imageOrientation: 'from-image',
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'default',
    });
  } catch {
    throw new Error('לא ניתן לפענח את התמונה');
  }

  const { width, height } = bitmap;
  try {
    const canvas = makeCanvas(width, height);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('התמונה גדולה מדי לעיבוד בדפדפן');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, 0, 0);
    const blob = await canvasToPng(canvas);
    const crc = crc32(new Uint8Array(await blob.arrayBuffer()));
    return { blob, crc, width, height };
  } finally {
    bitmap.close();
  }
}
