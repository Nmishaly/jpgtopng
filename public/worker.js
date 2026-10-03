import { convertJpegToPng } from './convert.js';

self.onmessage = async ({ data: { id, file } }) => {
  try {
    const result = await convertJpegToPng(file);
    self.postMessage({ id, ok: true, ...result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message || String(err) });
  }
};
