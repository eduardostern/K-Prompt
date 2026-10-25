/**
 * Builds ULA.tap from programs/ULA.asm plus the code that has to be
 * counted in T-states, generated here:
 *
 *   sync     the interrupt has just been taken: wait to the band, load the
 *            first line's colours, then 64 blocks of exactly 224 T-states,
 *            one per pixel line of the band, and jump back to `after`
 *   setptrs  puts gseq + phase + k into each block's LD SP
 *   gseq     the rainbow of attributes
 *   ballsh   the ball shifted to each of the 8 pixel positions in a byte
 *
 * Timing (48K): the frame starts with the interrupt; pixel line y is shown
 * from T = 14336 + 224·y. The band is lines 64-127, columns 10-21. Line
 * k's colours are written from 128 T-states into the line before it: the
 * beam has passed the band's columns (they end at +88) and is in the
 * border, and the writes end at +212, before it reaches column 10 of line
 * k (+264). The window matters on a real 48K: from 1 T-state before a
 * line's first pixel (+223 of the line before), for 128 T-states, the ULA
 * holds the CPU off 4000h-7FFFh, and an attribute write there would wait
 * and push the rest of the frame late. From +127 to +222 nothing waits.
 * The code and tables sit above 8000h, so only those writes touch
 * contended memory.
 */
import { readFileSync } from 'node:fs';
import { assemble } from '../src/zx/z80asm';
import { codeTape } from '../src/zx/tape-file';

export const ULA_ORG = 0x8000;

const LINE_T = 224;
const PAPER_T = 14336;
const BAND_TOP = 64; // pixel line
const BAND_LINES = 64;
const BAND_COL = 10;
const BAND_COLS = 12;
const WRITE_AT = 128; // T-states into the previous line: the first one the ULA leaves free

/**
 * From the interrupt to `sync`: the interrupt is taken 0-3 T-states into
 * the frame (HALT runs in 4 T-state steps), IM 2 takes 19, the handler's
 * RET 10, and the JP sync after the HALT 10.
 */
const ENTRY_T = 19 + 10 + 10;

/** The block for line k starts here. */
const blockStart = (k: number) => PAPER_T + (BAND_TOP + k - 1) * LINE_T + WRITE_AT;

const T = { ldSp: 10, pushIdx: 15, push: 11, pop: 10, popIdx: 14, incSp: 6, nop: 4 };

/** Rainbow order: red, yellow, green, cyan, blue, magenta, two lines each. */
const RAINBOW = [2, 6, 4, 5, 1, 3];
const PERIOD = 12;

function gseq(): number[] {
  const n = PERIOD + BAND_LINES + BAND_COLS + 4;
  return Array.from({ length: n }, (_, i) => 0x40 | RAINBOW[(i >> 1) % RAINBOW.length]);
}

/** A wait of exactly `t` T-states (t >= 14) that leaves the flags and registers it uses free. */
function delay(t: number): { code: string[]; t: number } {
  const code: string[] = [];
  // ld bc,n (10) + n x (dec bc 6, ld a,b 4, or c 4, jp nz 10)
  const n = Math.floor((t - 10 - 8) / 24);
  let rest = t - 10 - 24 * n;
  code.push(`        ld bc, ${n}`, 'dly:    dec bc', '        ld a, b', '        or c', '        jp nz, dly');
  // Z is set now, so RET NZ is a 5 T-state no-op.
  while (rest >= 8) { code.push('        nop'); rest -= 4; }
  const last: Record<number, string> = { 4: 'nop', 5: 'ret nz', 6: 'inc hl', 7: 'ld a, 0' };
  if (rest) code.push(`        ${last[rest]}`);
  return { code, t };
}

export function generated(): string {
  const out: string[] = [];
  const pops = ['pop af', 'pop bc', 'pop de', 'pop hl', 'pop ix', 'pop iy'];
  const popT = T.ldSp + 4 * T.pop + 2 * T.popIdx;
  const pushes = ['push iy', 'push ix', 'push hl', 'push de', 'push bc', 'push af'];
  const pushT = T.ldSp + 2 * T.pushIdx + 4 * T.push;

  out.push('sync:');
  const wait = blockStart(0) - ENTRY_T - popT;
  out.push(...delay(wait).code);
  out.push('tp0:    ld sp, gseq');
  out.push(...pops.map((p) => `        ${p}`));
  for (let k = 0; k < BAND_LINES; k++) {
    const row = (BAND_TOP + k) >> 3;
    const attrEnd = 0x5800 + row * 32 + BAND_COL + BAND_COLS;
    out.push(`; line ${BAND_TOP + k}, from T ${blockStart(k)}`);
    out.push(`        ld sp, ${attrEnd}`);
    out.push(...pushes.map((p) => `        ${p}`));
    out.push(`tp${k + 1}:   ld sp, gseq`);
    out.push(...pops.map((p) => `        ${p}`));
    // Pad to exactly one line, without touching the flags (F holds colours).
    let pad = LINE_T - pushT - popT;
    out.push('        inc sp'); pad -= T.incSp;
    if (pad % 4) throw new Error('band block does not pad to a line');
    for (; pad > 0; pad -= 4) out.push('        nop');
  }
  out.push('        jp after');

  out.push('setptrs:');
  for (let k = 0; k <= BAND_LINES; k++) out.push(`        ld (tp${k}+1), hl`, '        inc hl');
  out.push('        ret');

  out.push('gseq:');
  const g = gseq();
  for (let i = 0; i < g.length; i += 16) out.push(`        db ${g.slice(i, i + 16).join(', ')}`);

  // The ball, a circle of 8x8, shifted right by 0-7 pixels into two bytes.
  const ball = [0x3c, 0x7e, 0xff, 0xff, 0xff, 0xff, 0x7e, 0x3c];
  out.push('ballsh:');
  for (let s = 0; s < 8; s++) {
    const bytes = ball.flatMap((b) => { const w = (b << 8) >> s; return [(w >> 8) & 0xff, w & 0xff]; });
    out.push(`        db ${bytes.join(', ')}`);
  }
  return out.join('\n');
}

export function assembleUla(): Uint8Array {
  const source = readFileSync(new URL('../programs/ULA.asm', import.meta.url), 'utf8') + '\n' + generated() + '\n';
  const { bytes, origin } = assemble(source);
  if (origin !== ULA_ORG) throw new Error('ULA must ORG at 8000h');
  if (ULA_ORG + bytes.length > 0xbc00) throw new Error('ULA runs into its stack');
  return bytes;
}

export function buildUlaTap(): Uint8Array {
  return codeTape('ULA', assembleUla(), ULA_ORG);
}
