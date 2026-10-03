// Lossless WebP output via the browser's encoder. Chrome encodes losslessly at
// quality 1.0, but that is not guaranteed everywhere, so the option is only
// offered after a round-trip test on noisy pixels proves it is exact.

let supported;
export function webpLosslessSupported() {
  supported ??= (async () => {
    try {
      const w = 64;
      const h = 64;
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(w, h);
      for (let i = 0; i < img.data.length; i++) img.data[i] = i % 4 === 3 ? 255 : (i * 7919) % 251;
      ctx.putImageData(img, 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 1 });
      if (blob.type !== 'image/webp') return false;
      const bitmap = await createImageBitmap(blob);
      const check = new OffscreenCanvas(w, h).getContext('2d');
      check.drawImage(bitmap, 0, 0);
      const back = check.getImageData(0, 0, w, h).data;
      return back.every((v, i) => v === img.data[i]);
    } catch {
      return false;
    }
  })();
  return supported;
}

export const WEBP_MAX_DIMENSION = 16383;
