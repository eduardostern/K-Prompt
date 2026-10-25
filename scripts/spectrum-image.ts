/**
 * A picture for the Spectrum's screen: a PNG (8-bit RGB or RGBA, not
 * interlaced) decoded, then turned into the ULA's two colours per cell.
 *
 * Every cell (8×8 as the ULA shows them, or 8×1 when a program rewrites
 * the attributes on every line, as ULA2 does) gets the pair of colours, one
 * BRIGHT level for both, that fits its pixels best (the least distance from
 * each pixel to the line between the two colours), and each pixel is then
 * one or the other by an ordered (Bayer) dither along that line.
 */
import { unzlibSync } from 'fflate';

export interface Rgb { w: number; h: number; data: Uint8Array } // RGB triplets

export function decodePng(file: Uint8Array): Rgb {
  const be32 = (p: number) => ((file[p] << 24) | (file[p + 1] << 16) | (file[p + 2] << 8) | file[p + 3]) >>> 0;
  let p = 8;
  let w = 0;
  let h = 0;
  let type = 0;
  const idat: Uint8Array[] = [];
  while (p < file.length) {
    const len = be32(p);
    const kind = String.fromCharCode(...file.subarray(p + 4, p + 8));
    const body = file.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') {
      w = be32(p + 8);
      h = be32(p + 12);
      if (body[8] !== 8 || body[12] !== 0) throw new Error('PNG: 8-bit, not interlaced only');
      type = body[9];
    } else if (kind === 'IDAT') idat.push(body);
    p += 12 + len;
  }
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 0;
  if (!bpp) throw new Error('PNG: RGB or RGBA only');
  const raw = unzlibSync(Uint8Array.from(idat.flatMap((b) => Array.from(b))));
  const stride = w * bpp;
  const px = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 0xff;
    }
  }
  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) data.set(px.subarray(i * bpp, i * bpp + 3), i * 3);
  return { w, h, data };
}

/** The Spectrum's 15 colours (as K-Prompt shows them): index (bright << 3) | colour. */
export const SPECTRUM_RGB: [number, number, number][] = [0xd8, 0xff].flatMap((l) =>
  Array.from({ length: 8 }, (_, c) => [c & 2 ? l : 0, c & 4 ? l : 0, c & 1 ? l : 0] as [number, number, number]));

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

/** The screen as the ULA would show it: a 1-bit pixel map and an attribute per cell (8×cellH). */
export interface SpectrumImage {
  /** 256 × 192, 1 = ink. */
  ink: Uint8Array;
  /** One attribute per 8×cellH cell: 32 per row, 192 / cellH rows. */
  attrs: Uint8Array;
  cellH: number;
}

/** Converts a 256×192 picture with one ink/paper pair per 8×cellH cell. */
export function toSpectrum(img: Rgb, cellH: 1 | 8): SpectrumImage {
  if (img.w !== 256 || img.h !== 192) throw new Error('the picture must be 256×192');
  const ink = new Uint8Array(256 * 192);
  const rows = 192 / cellH;
  const attrs = new Uint8Array(32 * rows);
  // Perceptual-ish weights for the distance.
  const W = [2, 4, 3];
  const px = (x: number, y: number) => {
    const i = (y * 256 + x) * 3;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < 32; col++) {
      const pixels: number[][] = [];
      for (let dy = 0; dy < cellH; dy++) for (let dx = 0; dx < 8; dx++) pixels.push(px(col * 8 + dx, row * cellH + dy));
      let best = { err: Infinity, a: 0, b: 0, bright: 0 };
      for (const bright of [0, 1]) {
        for (let a = 0; a < 8; a++) {
          for (let b = a; b < 8; b++) {
            const A = SPECTRUM_RGB[(bright << 3) | a];
            const B = SPECTRUM_RGB[(bright << 3) | b];
            const d = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
            const dd = W[0] * d[0] * d[0] + W[1] * d[1] * d[1] + W[2] * d[2] * d[2];
            let err = 0;
            for (const P of pixels) {
              const e = [P[0] - A[0], P[1] - A[1], P[2] - A[2]];
              let t = dd ? (W[0] * e[0] * d[0] + W[1] * e[1] * d[1] + W[2] * e[2] * d[2]) / dd : 0;
              t = Math.max(0, Math.min(1, t));
              const r = [e[0] - t * d[0], e[1] - t * d[1], e[2] - t * d[2]];
              err += W[0] * r[0] * r[0] + W[1] * r[1] * r[1] + W[2] * r[2] * r[2];
            }
            if (err < best.err) best = { err, a, b, bright };
          }
        }
      }
      const A = SPECTRUM_RGB[(best.bright << 3) | best.a];
      const B = SPECTRUM_RGB[(best.bright << 3) | best.b];
      const d = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
      const dd = W[0] * d[0] * d[0] + W[1] * d[1] * d[1] + W[2] * d[2] * d[2];
      // Paper a, ink b; pixels nearer b (by the dither) are ink.
      attrs[row * 32 + col] = (best.bright << 6) | (best.a << 3) | best.b;
      for (let dy = 0; dy < cellH; dy++) {
        for (let dx = 0; dx < 8; dx++) {
          const x = col * 8 + dx;
          const y = row * cellH + dy;
          const P = px(x, y);
          const e = [P[0] - A[0], P[1] - A[1], P[2] - A[2]];
          const t = dd ? (W[0] * e[0] * d[0] + W[1] * e[1] * d[1] + W[2] * e[2] * d[2]) / dd : 0;
          ink[y * 256 + x] = t > BAYER4[(y & 3) * 4 + (x & 3)] ? 1 : 0;
        }
      }
    }
  }
  return { ink, attrs, cellH };
}

/** The RGB the ULA shows for a converted picture (for previews and tests). */
export function render(s: SpectrumImage): Uint8Array {
  const out = new Uint8Array(256 * 192 * 3);
  for (let y = 0; y < 192; y++) {
    for (let x = 0; x < 256; x++) {
      const a = s.attrs[Math.floor(y / s.cellH) * 32 + (x >> 3)];
      const bright = (a >> 6) & 1;
      const c = s.ink[y * 256 + x] ? a & 7 : (a >> 3) & 7;
      out.set(SPECTRUM_RGB[(bright << 3) | c], (y * 256 + x) * 3);
    }
  }
  return out;
}

/** The Spectrum's bitmap bytes (6144) for a 1-bit pixel map, in the ULA's odd line order. */
export function bitmapBytes(ink: Uint8Array): Uint8Array {
  const out = new Uint8Array(6144);
  for (let y = 0; y < 192; y++) {
    const line = ((y & 0xc0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2);
    for (let col = 0; col < 32; col++) {
      let b = 0;
      for (let i = 0; i < 8; i++) b = (b << 1) | ink[y * 256 + col * 8 + i];
      out[line + col] = b;
    }
  }
  return out;
}
