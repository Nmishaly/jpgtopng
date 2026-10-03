// Decodes HEIC in a worker. Used when conversion runs on the main thread
// (engines without OffscreenCanvas): older engines refuse to compile the
// large WebAssembly decoder on the main thread, but allow it in a worker.
import './compat.js';
import { decodeHeicWasm } from './heic.js';

self.onmessage = async ({ data: { id, bytes } }) => {
  try {
    const { data, width, height } = await decodeHeicWasm(bytes);
    self.postMessage({ id, ok: true, data, width, height }, [data.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message || String(err) });
  }
};
