import { crc32 } from './zip.js';

// Streaming PNG encoder. Rows are filtered (adaptive per-row filter choice,
// as libpng does) and deflated with the browser's CompressionStream, one
// strip at a time, so even very large images never need a full-size canvas.

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const encoder = new TextEncoder();

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(encoder.encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class GrayMismatch extends Error {}

export class PngEncoder {
  /**
   * @param {{width:number,height:number,gray?:boolean,icc?:{name:string,data:Uint8Array},
   *          srgb?:boolean,exif?:Uint8Array,phys?:{x:number,y:number}}} opts
   */
  constructor({ width, height, gray = false, icc, srgb = false, exif, phys }) {
    this.width = width;
    this.height = height;
    this.bpp = gray ? 1 : 3;
    this.rowLen = width * this.bpp;
    this.prev = new Uint8Array(this.rowLen);
    this.cur = new Uint8Array(this.rowLen);
    this.parts = [SIGNATURE];
    this.headerReady = this.#header({ gray, icc, srgb, exif, phys });

    const cs = new CompressionStream('deflate');
    this.writer = cs.writable.getWriter();
    this.idat = (async () => {
      const reader = cs.readable.getReader();
      const out = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return out;
        out.push(chunk('IDAT', value));
      }
    })();
  }

  async #header({ gray, icc, srgb, exif, phys }) {
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, this.width);
    dv.setUint32(4, this.height);
    ihdr[8] = 8; // bit depth
    ihdr[9] = gray ? 0 : 2; // colour type: grayscale or RGB (JPEGs have no alpha)
    const parts = [chunk('IHDR', ihdr)];
    if (icc) {
      const name = encoder.encode(icc.name.slice(0, 79));
      const z = await deflate(icc.data);
      const data = new Uint8Array(name.length + 2 + z.length);
      data.set(name);
      data.set(z, name.length + 2); // null separator + compression method 0
      parts.push(chunk('iCCP', data));
    } else if (srgb) {
      parts.push(chunk('sRGB', new Uint8Array([0])));
    }
    if (phys) {
      const p = new Uint8Array(9);
      const pv = new DataView(p.buffer);
      pv.setUint32(0, phys.x);
      pv.setUint32(4, phys.y);
      p[8] = 1; // unit: metre
      parts.push(chunk('pHYs', p));
    }
    if (exif) parts.push(chunk('eXIf', exif));
    return parts;
  }

  /** Append `rows` rows of RGBA pixels (as returned by getImageData). */
  async writeRgba(rgba, rows) {
    const { width, bpp, rowLen } = this;
    const out = new Uint8Array(rows * (rowLen + 1));
    for (let r = 0; r < rows; r++) {
      const cur = this.cur;
      const base = r * width * 4;
      if (bpp === 3) {
        for (let x = 0, i = base, j = 0; x < width; x++, i += 4, j += 3) {
          cur[j] = rgba[i];
          cur[j + 1] = rgba[i + 1];
          cur[j + 2] = rgba[i + 2];
        }
      } else {
        for (let x = 0, i = base; x < width; x++, i += 4) {
          const v = rgba[i];
          if (rgba[i + 1] !== v || rgba[i + 2] !== v) throw new GrayMismatch();
          cur[x] = v;
        }
      }
      this.#filterRow(out, r * (rowLen + 1));
      this.cur = this.prev;
      this.prev = cur;
    }
    // Don't wait for compression to finish this strip: filter the next one
    // meanwhile. `ready` still applies backpressure; errors surface in finish().
    await this.writer.ready;
    this.writer.write(out).catch(() => {});
  }

  #filterRow(out, at) {
    const { cur, prev, bpp, rowLen } = this;
    // Pick the filter with the smallest sum of absolute (signed) residuals,
    // the heuristic libpng uses. Each filter has its own tight loop.
    const abs = (v) => (v < 128 ? v : 256 - v);
    const sums = [0, 0, 0, 0, 0];
    for (let i = 0; i < rowLen; i++) {
      const x = cur[i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      sums[0] += x < 128 ? x : 256 - x;
      sums[1] += abs((x - a) & 0xff);
      sums[2] += abs((x - b) & 0xff);
      sums[3] += abs((x - ((a + b) >> 1)) & 0xff);
      const p = a + b - c;
      const pa = p > a ? p - a : a - p;
      const pb = p > b ? p - b : b - p;
      const pc = p > c ? p - c : c - p;
      sums[4] += abs((x - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff);
    }
    let best = 0;
    for (let f = 1; f < 5; f++) if (sums[f] < sums[best]) best = f;

    out[at] = best;
    const o = at + 1;
    switch (best) {
      case 0:
        out.set(cur, o);
        break;
      case 1:
        for (let i = 0; i < rowLen; i++) out[o + i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
        break;
      case 2:
        for (let i = 0; i < rowLen; i++) out[o + i] = cur[i] - prev[i];
        break;
      case 3:
        for (let i = 0; i < rowLen; i++) {
          out[o + i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1);
        }
        break;
      default:
        for (let i = 0; i < rowLen; i++) {
          const a = i >= bpp ? cur[i - bpp] : 0;
          const b = prev[i];
          const c = i >= bpp ? prev[i - bpp] : 0;
          const p = a + b - c;
          const pa = p > a ? p - a : a - p;
          const pb = p > b ? p - b : b - p;
          const pc = p > c ? p - c : c - p;
          out[o + i] = cur[i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
    }
  }

  /** Finish the stream. Returns the PNG as a Blob plus its CRC-32 (for ZIP). */
  async finish() {
    await this.writer.close();
    const parts = [...this.parts, ...(await this.headerReady), ...(await this.idat),
      chunk('IEND', new Uint8Array(0))];
    let crc = 0;
    for (const p of parts) crc = crc32(p, crc);
    return { blob: new Blob(parts, { type: 'image/png' }), crc };
  }

  abort() {
    this.idat.catch(() => {});
    this.headerReady.catch(() => {});
    this.writer.abort().catch(() => {});
  }
}
