import './compat.js';
import { convertImage } from './convert.js';

self.onmessage = async ({ data: { id, file, options } }) => {
  try {
    const result = await convertImage(file, options);
    self.postMessage({ id, ok: true, ...result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message || String(err) });
  }
};
