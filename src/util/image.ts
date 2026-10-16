import zlib from "node:zlib";

/** Minimal image helpers: the engine writes screenshots as uncompressed BMP, models want small PNGs. */

export interface RgbImage {
  width: number;
  height: number;
  /** Top-down RGB, 3 bytes per pixel. */
  rgb: Buffer;
}

/** Decodes 24/32-bit uncompressed (BI_RGB / BI_BITFIELDS with standard masks) Windows bitmaps. */
export function decodeBmp(buf: Buffer): RgbImage {
  if (buf.length < 54 || buf.toString("latin1", 0, 2) !== "BM") throw new Error("not a BMP file");
  const dataOffset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  if (bpp !== 24 && bpp !== 32) throw new Error(`unsupported BMP depth ${bpp}`);
  if (compression !== 0 && compression !== 3) throw new Error(`unsupported BMP compression ${compression}`);
  const height = Math.abs(rawHeight);
  const bottomUp = rawHeight > 0;
  const bytes = bpp / 8;
  const stride = Math.ceil((width * bytes) / 4) * 4;
  if (dataOffset + stride * height > buf.length) throw new Error("truncated BMP");
  const rgb = Buffer.allocUnsafe(width * height * 3);
  for (let y = 0; y < height; y++) {
    const src = dataOffset + (bottomUp ? height - 1 - y : y) * stride;
    let o = y * width * 3;
    for (let x = 0; x < width; x++) {
      const p = src + x * bytes;
      rgb[o++] = buf[p + 2];
      rgb[o++] = buf[p + 1];
      rgb[o++] = buf[p];
    }
  }
  return { width, height, rgb };
}

/** Box-filter downscale so the image fits into maxWidth × maxHeight. */
export function fitImage(img: RgbImage, maxWidth: number, maxHeight: number): RgbImage {
  const scale = Math.min(1, maxWidth / img.width, maxHeight / img.height);
  if (scale >= 1) return img;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = Buffer.allocUnsafe(w * h * 3);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * img.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * img.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / w));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let yy = y0; yy < y1; yy++) {
        let p = (yy * img.width + x0) * 3;
        for (let xx = x0; xx < x1; xx++) {
          r += img.rgb[p++];
          g += img.rgb[p++];
          b += img.rgb[p++];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * w + x) * 3;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }
  return { width: w, height: h, rgb: out };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Buffer[]): number {
  let c = 0xffffffff;
  for (const buf of parts) for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32([head.subarray(4), data]), 0);
  return Buffer.concat([head, data, crc]);
}

export function encodePng(img: RgbImage): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const row = img.width * 3;
  const raw = Buffer.allocUnsafe((row + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (row + 1)] = 0; // filter: none
    img.rgb.copy(raw, y * (row + 1) + 1, y * row, (y + 1) * row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function imageMime(buf: Buffer): string | null {
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.length >= 2 && buf.toString("latin1", 0, 2) === "BM") return "image/bmp";
  return null;
}
