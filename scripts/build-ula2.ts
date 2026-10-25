/**
 * Builds ULA2.tap: a photograph (programs/beach.png, CC0) on a 48K Spectrum
 * with the colour clash fixed in a band down the middle of the screen,
 * columns 8-23 (128 pixels), all 192 lines: every pixel line of every cell
 * there has its own two colours (8×1 attributes), where the ULA allows two
 * per 8×8 cell. The sides show the same picture as the ULA does; M swaps
 * the band between the two, so you see what the trick buys.
 *
 * How (48K timing, the frame starts with the interrupt, pixel line y is
 * shown from T = 14336 + 224·y): for each of the 192 lines, one block of
 * exactly 224 T-states that loads that line's 16 attributes into the 8
 * register pairs (AF BC DE HL, then the alternate set), points SP after
 * the band in the attribute row, and PUSHes them, right to left. A block
 * runs in the line before the one it colours, and its writes fall from
 * T+128 to T+221 of that line: the ULA has fetched that line's attributes
 * (it holds 4000h-7FFFh for 128 T from T-1) and will not fetch the next
 * line's until T+223, so the writes are never delayed and the timing holds.
 *
 *   per block: LD SP 10, 4 POP 40, EXX + EX AF 8, 4 POP 40, LD SP 10,
 *              4 PUSH 44, EXX + EX AF 8, 4 PUSH 44 = 204, + 5 NOP = 224
 *
 * The first PUSH writes 113 T into the block, the last at 201: starting
 * blocks 16 T into a line puts them at 129 and 217, with 3 T to spare for
 * the interrupt being taken up to 3 T late (HALT runs in 4-T steps).
 */
import { readFileSync } from 'node:fs';
import { assemble } from '../src/zx/z80asm';
import { codeTape } from '../src/zx/tape-file';
import { bitmapBytes, decodePng, SpectrumImage, toSpectrum } from './spectrum-image';

export const ULA2_ORG = 0x8000;

const LINE_T = 224;
const PAPER_T = 14336;
const BAND_COL = 8;
const BAND_COLS = 16;
/** Blocks start this many T into the line before the one they colour. */
const BLOCK_AT = 16;
/**
 * From the interrupt to `sync`: IM 2 takes 19, the handler's RET 10, then
 * mloop's LD A,(clash) 13, OR A 4 and JP Z,sync 10.
 */
const ENTRY_T = 19 + 10 + 13 + 4 + 10;
const BLOCK_T = 10 + 40 + 8 + 40 + 10 + 44 + 8 + 44;

/** The picture, both ways: the ULA's 8×8 and the band's 8×1. */
export function pictures(): { clash: SpectrumImage; fixed: SpectrumImage } {
  const img = decodePng(new Uint8Array(readFileSync(new URL('../programs/beach.png', import.meta.url))));
  return { clash: toSpectrum(img, 8), fixed: toSpectrum(img, 1) };
}

/** A wait of exactly `t` T-states (t >= 30), using BC and A. */
function delay(t: number): string[] {
  const code: string[] = [];
  // ld bc,n (10) + n x (dec bc 6, ld a,b 4, or c 4, jp nz 10)
  const n = Math.floor((t - 10 - 8) / 24);
  let rest = t - 10 - 24 * n;
  code.push(`        ld bc, ${n}`, 'dly:    dec bc', '        ld a, b', '        or c', '        jp nz, dly');
  while (rest >= 8) { code.push('        nop'); rest -= 4; }
  const last: Record<number, string> = { 4: 'nop', 5: 'ret nz', 6: 'inc hl', 7: 'ld a, 0' };
  if (rest) code.push(`        ${last[rest]}`);
  return code;
}

const bytes = (label: string, data: ArrayLike<number>) => {
  const out = [`${label}:`];
  for (let i = 0; i < data.length; i += 16) out.push(`        db ${Array.from(data).slice(i, i + 16).join(', ')}`);
  return out;
};

export function generated(): string {
  const { clash, fixed } = pictures();
  if (BLOCK_T + 20 !== LINE_T) throw new Error('blocks must be 224 T');
  const out: string[] = [];

  // ---- the timed part: from the interrupt, 192 blocks, then back to `after`.
  out.push('sync:');
  out.push(...delay(PAPER_T - LINE_T + BLOCK_AT - ENTRY_T));
  for (let y = 0; y < 192; y++) {
    const rowEnd = 0x5800 + (y >> 3) * 32 + BAND_COL + BAND_COLS;
    out.push(`; line ${y}, from T ${PAPER_T + (y - 1) * LINE_T + BLOCK_AT}`);
    out.push(`        ld sp, band+${y * BAND_COLS}`);
    out.push('        pop af', '        pop bc', '        pop de', '        pop hl');
    out.push('        exx', "        ex af, af'");
    out.push('        pop af', '        pop bc', '        pop de', '        pop hl');
    out.push(`        ld sp, ${rowEnd}`);
    out.push('        push hl', '        push de', '        push bc', '        push af');
    out.push('        exx', "        ex af, af'");
    out.push('        push hl', '        push de', '        push bc', '        push af');
    out.push('        nop', '        nop', '        nop', '        nop', '        nop');
  }
  out.push('        jp after');

  // ---- data
  // The band's attributes, a line after another, columns 8-23 (POPped in order).
  const band: number[] = [];
  for (let y = 0; y < 192; y++) for (let c = 0; c < BAND_COLS; c++) band.push(fixed.attrs[y * 32 + BAND_COL + c]);
  out.push(...bytes('band', band));
  // The screen as it starts: the sides as the ULA shows them, the band's pixels fixed.
  const ink = clash.ink.slice();
  for (let y = 0; y < 192; y++) for (let x = BAND_COL * 8; x < (BAND_COL + BAND_COLS) * 8; x++) ink[y * 256 + x] = fixed.ink[y * 256 + x];
  out.push(...bytes('scrbmp', bitmapBytes(ink)));
  out.push(...bytes('scratt', clash.attrs));
  // M swaps the band's pixels between the two pictures: XOR them, line after line.
  const a = bitmapBytes(fixed.ink);
  const b = bitmapBytes(clash.ink);
  const swap: number[] = [];
  const lineAddr = (y: number) => ((y & 0xc0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2);
  for (let y = 0; y < 192; y++) for (let c = 0; c < BAND_COLS; c++) {
    const i = lineAddr(y) + BAND_COL + c;
    swap.push(a[i] ^ b[i]);
  }
  out.push(...bytes('swapxor', swap));
  out.push('lines:');
  for (let y = 0; y < 192; y += 8) {
    out.push(`        dw ${Array.from({ length: 8 }, (_, i) => 0x4000 + lineAddr(y + i) + BAND_COL).join(', ')}`);
  }
  return out.join('\n');
}

export function assembleUla2(): Uint8Array {
  const source = readFileSync(new URL('../programs/ULA2.asm', import.meta.url), 'utf8') + '\n' + generated() + '\n';
  const { bytes: code, origin } = assemble(source);
  if (origin !== ULA2_ORG) throw new Error('ULA2 must ORG at 8000h');
  if (ULA2_ORG + code.length > 0xfc00) throw new Error('ULA2 runs into its stack');
  return code;
}

export function buildUla2Tap(): Uint8Array {
  return codeTape('ULA2', assembleUla2(), ULA2_ORG);
}
