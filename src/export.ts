/** 2x separable Lanczos3. Each output tile includes a 3-pixel filter border. */
export const TILE_BORDER = 3;
export const EXPORT_SAMPLES = 2;

const sinc = (x: number) => Math.sin(Math.PI * x) / (Math.PI * x);
const taps = Array.from({ length: 6 }, (_, i) => sinc((i + .5) / 2) * sinc((i + .5) / 6));
const normalization = 2 * taps.reduce((sum, x) => sum + x, 0);
const [a, b, c, d, e, f] = taps.map(x => x / normalization);

export function downsampleTile(source: ImageData, width: number, height: number) {
  const pixels = source.data;
  const output = new ImageData(width, height);
  const horizontal = new Float32Array(source.height * width * 3);
  const sourceStride = source.width * 4;
  const stride = width * 3;
  for (let y = 0; y < source.height; y++) {
    let h = y * stride;
    let i = y * sourceStride + TILE_BORDER * 8;
    for (let x = 0; x < width; x++, i += 8) {
      for (let k = 0; k < 3; k++) {
        const j = i + k;
        horizontal[h++] = a * (pixels[j] + pixels[j + 4]) + b * (pixels[j - 4] + pixels[j + 8]) +
          c * (pixels[j - 8] + pixels[j + 12]) + d * (pixels[j - 12] + pixels[j + 16]) +
          e * (pixels[j - 16] + pixels[j + 20]) + f * (pixels[j - 20] + pixels[j + 24]);
      }
    }
  }
  let out = 0;
  for (let y = 0; y < height; y++) {
    const row = (y + TILE_BORDER) * 2 * stride;
    for (let x = 0; x < stride; x += 3) {
      for (let k = 0; k < 3; k++) {
        const j = row + x + k;
        output.data[out++] = a * (horizontal[j] + horizontal[j + stride]) +
          b * (horizontal[j - stride] + horizontal[j + 2 * stride]) +
          c * (horizontal[j - 2 * stride] + horizontal[j + 3 * stride]) +
          d * (horizontal[j - 3 * stride] + horizontal[j + 4 * stride]) +
          e * (horizontal[j - 4 * stride] + horizontal[j + 5 * stride]) +
          f * (horizontal[j - 5 * stride] + horizontal[j + 6 * stride]);
      }
      output.data[out++] = 255;
    }
  }
  return output;
}

export async function withPrintResolution(png: Blob, dpi: number) {
  const pixelsPerMeter = Math.round(dpi / .0254);
  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([112, 72, 89, 115], 4); // pHYs
  view.setUint32(8, pixelsPerMeter);
  view.setUint32(12, pixelsPerMeter);
  chunk[16] = 1;
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, 17)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  view.setUint32(17, (crc ^ 0xffffffff) >>> 0);
  const data = new DataView(await png.arrayBuffer());
  const parts: BlobPart[] = [png.slice(0, 33), chunk]; // signature and IHDR
  let offset = 33, start = offset;
  while (offset + 12 <= data.byteLength) {
    const end = offset + 12 + data.getUint32(offset);
    if (end > data.byteLength) break;
    if (data.getUint32(offset + 4) === 0x70485973) {
      parts.push(png.slice(start, offset));
      start = end;
    }
    offset = end;
  }
  parts.push(png.slice(start));
  return new Blob(parts, { type: 'image/png' });
}
