// Builds an ICC v4 "Display P3" profile (the colour space of iPhone and most
// modern phone/Mac photos). It is embedded in PNGs whose source JPEG has a
// wide-gamut profile, so colours outside sRGB are kept instead of clipped.

const S15 = (v) => Math.round(v * 65536);

function tagXYZ(x, y, z) {
  const b = new DataView(new ArrayBuffer(20));
  b.setUint32(0, 0x58595a20); // 'XYZ '
  [x, y, z].forEach((v, i) => b.setInt32(8 + i * 4, S15(v)));
  return new Uint8Array(b.buffer);
}

function tagMluc(text) {
  const b = new DataView(new ArrayBuffer(28 + text.length * 2));
  b.setUint32(0, 0x6d6c7563); // 'mluc'
  b.setUint32(8, 1); // record count
  b.setUint32(12, 12); // record size
  b.setUint16(16, 0x656e); // 'en'
  b.setUint16(18, 0x5553); // 'US'
  b.setUint32(20, text.length * 2);
  b.setUint32(24, 28);
  for (let i = 0; i < text.length; i++) b.setUint16(28 + i * 2, text.charCodeAt(i));
  return new Uint8Array(b.buffer);
}

function tagSrgbCurve() {
  // Parametric curve type 3: the sRGB transfer function, shared by Display P3.
  const b = new DataView(new ArrayBuffer(32));
  b.setUint32(0, 0x70617261); // 'para'
  b.setUint16(8, 3);
  [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045].forEach((v, i) =>
    b.setInt32(12 + i * 4, S15(v)),
  );
  return new Uint8Array(b.buffer);
}

function tagSf32(values) {
  const b = new DataView(new ArrayBuffer(8 + values.length * 4));
  b.setUint32(0, 0x73663332); // 'sf32'
  values.forEach((v, i) => b.setInt32(8 + i * 4, S15(v)));
  return new Uint8Array(b.buffer);
}

function buildDisplayP3() {
  const curve = tagSrgbCurve();
  const tags = [
    ['desc', tagMluc('Display P3')],
    ['cprt', tagMluc('No copyright, use freely')],
    ['wtpt', tagXYZ(0.9642, 1.0, 0.8249)],
    // Display P3 primaries, chromatically adapted to the D50 PCS.
    ['rXYZ', tagXYZ(0.515121, 0.241196, -0.001053)],
    ['gXYZ', tagXYZ(0.291977, 0.692245, 0.041885)],
    ['bXYZ', tagXYZ(0.157104, 0.066574, 0.784073)],
    ['rTRC', curve],
    ['gTRC', curve],
    ['bTRC', curve],
    // Bradford adaptation D65 -> D50.
    ['chad', tagSf32([1.047882, 0.022919, -0.050201, 0.029587, 0.990479, -0.017059,
      -0.009232, 0.015076, 0.751678])],
  ];

  const tableSize = 4 + tags.length * 12;
  const offsets = new Map();
  let offset = 128 + tableSize;
  for (const [, data] of tags) {
    if (!offsets.has(data)) {
      offsets.set(data, offset);
      offset += Math.ceil(data.length / 4) * 4;
    }
  }
  const out = new Uint8Array(offset);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, offset); // profile size
  dv.setUint32(8, 0x04300000); // version 4.3
  dv.setUint32(12, 0x6d6e7472); // 'mntr' display device class
  dv.setUint32(16, 0x52474220); // 'RGB '
  dv.setUint32(20, 0x58595a20); // PCS 'XYZ '
  [2024, 1, 1, 0, 0, 0].forEach((v, i) => dv.setUint16(24 + i * 2, v));
  dv.setUint32(36, 0x61637370); // 'acsp'
  dv.setUint32(64, 0); // perceptual intent
  [0.9642, 1.0, 0.8249].forEach((v, i) => dv.setInt32(68 + i * 4, S15(v))); // D50
  dv.setUint32(128, tags.length);
  tags.forEach(([sig, data], i) => {
    const at = 132 + i * 12;
    for (let k = 0; k < 4; k++) out[at + k] = sig.charCodeAt(k);
    dv.setUint32(at + 4, offsets.get(data));
    dv.setUint32(at + 8, data.length);
  });
  for (const [data, at] of offsets) out.set(data, at);
  return out;
}

export const DISPLAY_P3_ICC = buildDisplayP3();
