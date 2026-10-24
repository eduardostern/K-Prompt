/**
 * Builds TERM.tap from programs/TERM.asm: the terminal assembled at 8000h
 * with its font (programs/font4.asm) and a table turning the PC's CP437
 * characters into ASCII, behind a BASIC loader:
 *
 *   10 CLEAR 32767: LOAD "" CODE
 *   20 RANDOMIZE USR 32768
 *
 * The program starts at line 10 by itself and runs on into 20; after EDIT
 * leaves the terminal (with the call up) the program ends, and RUN 20
 * goes back.
 */
import { readFileSync } from 'node:fs';
import { assemble } from './z80asm';
import { checksum } from '../src/zx/tape';

export const TERM_ORG = 0x8000;

/** CP437 80h-FFh as the nearest ASCII; 7Fh is the font's solid block. */
const CP437 =
  'CueaaaaceeeiiiAAEaAooouuyOUcLYPf' + // 80-9F
  'aioun' + 'Nao?--??!<>' + ':#\x7f|+++++++|++++' + // A0-BF
  '++++-+++++++++-+' + '+++++++++++\x7f\x7f\x7f\x7f\x7f' + // C0-DF
  'aBGpSsutFTOd8fen' + '=+><()/~o..vn2\x7f '; // E0-FF

function cptab(): string {
  if (CP437.length !== 128) throw new Error(`CP437 table has ${CP437.length} entries`);
  const bytes = [...CP437].map((c) => `${c.charCodeAt(0).toString(16).padStart(2, '0')}h`);
  const lines = ['; CP437 80h-FFh as ASCII (box lines as + - |, blocks as the block glyph).', 'cptab:'];
  for (let i = 0; i < 128; i += 16) lines.push(`        db ${bytes.slice(i, i + 16).map((b) => `0${b}`).join(', ')}`);
  return lines.join('\n');
}

const root = new URL('../programs/', import.meta.url);

/** The terminal's machine code, at TERM_ORG. */
export function assembleTerm(): Uint8Array {
  const source = [readFileSync(new URL('TERM.asm', root), 'utf8'), cptab(), readFileSync(new URL('font4.asm', root), 'utf8')].join('\n');
  const { bytes, origin } = assemble(source);
  if (origin !== TERM_ORG) throw new Error('TERM must ORG at 8000h');
  return bytes;
}

/** A number in a BASIC line: its digits, then 0Eh and the 5-byte integer form. */
function num(n: number): number[] {
  return [...String(n)].map((c) => c.charCodeAt(0)).concat([0x0e, 0, 0, n & 0xff, n >> 8, 0]);
}

function line(no: number, body: number[]): number[] {
  const len = body.length + 1;
  return [no >> 8, no & 0xff, len & 0xff, len >> 8, ...body, 0x0d];
}

const CLEAR = 0xfd, LOAD = 0xef, CODE = 0xaf, RANDOMIZE = 0xf9, USR = 0xc0;
const Q = 0x22, COLON = 0x3a;

export function loaderProgram(): Uint8Array {
  return Uint8Array.from([
    ...line(10, [CLEAR, ...num(32767), COLON, LOAD, Q, Q, CODE]),
    ...line(20, [RANDOMIZE, USR, ...num(TERM_ORG)]),
  ]);
}

function header(type: number, name: string, length: number, p1: number, p2: number): Uint8Array {
  const h = new Uint8Array(19);
  h[1] = type;
  for (let i = 0; i < 10; i++) h[2 + i] = i < name.length ? name.charCodeAt(i) : 0x20;
  h[12] = length & 0xff; h[13] = length >> 8;
  h[14] = p1 & 0xff; h[15] = p1 >> 8;
  h[16] = p2 & 0xff; h[17] = p2 >> 8;
  h[18] = checksum(h.subarray(0, 18));
  return h;
}

function dataBlock(data: Uint8Array): Uint8Array {
  const b = new Uint8Array(data.length + 2);
  b[0] = 0xff;
  b.set(data, 1);
  b[b.length - 1] = checksum(b.subarray(0, b.length - 1));
  return b;
}

/** TERM.tap: the loader (autostart line 10), then the code. */
export function buildTermTap(): Uint8Array {
  const prog = loaderProgram();
  const code = assembleTerm();
  const blocks = [header(0, 'TERM', prog.length, 10, prog.length), dataBlock(prog), header(3, 'TERMcode', code.length, TERM_ORG, 32768), dataBlock(code)];
  const out: number[] = [];
  for (const b of blocks) out.push(b.length & 0xff, b.length >> 8, ...b);
  return Uint8Array.from(out);
}
