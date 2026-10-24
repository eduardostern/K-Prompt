/**
 * Turns a BASIC listing (plain text, as printed in magazines) into a
 * Spectrum program, the bytes the ROM keeps between PROG and VARS:
 *
 *   line number (2 bytes, high first), length (2 bytes, low first),
 *   the line with keywords as one-byte tokens (A5h-FFh), ENTER (0Dh)
 *
 * Every number in the text is followed by 0Eh and its value in the ROM's
 * 5-byte form, which is what the interpreter reads when it runs; the digits
 * are only for LIST. Strings and REM lines are kept as they are.
 *
 * The program goes into the machine as a tape (programTape), so the ROM's
 * own LOAD sets up its memory exactly as it does for any program.
 */
import { checksum } from './tape';

/** Tokens A5h-FFh, in order. */
export const TOKENS = [
  'RND', 'INKEY$', 'PI', 'FN', 'POINT', 'SCREEN$', 'ATTR', 'AT', 'TAB', 'VAL$', 'CODE', 'VAL', 'LEN', 'SIN', 'COS',
  'TAN', 'ASN', 'ACS', 'ATN', 'LN', 'EXP', 'INT', 'SQR', 'SGN', 'ABS', 'PEEK', 'IN', 'USR', 'STR$', 'CHR$', 'NOT',
  'BIN', 'OR', 'AND', '<=', '>=', '<>', 'LINE', 'THEN', 'TO', 'STEP', 'DEF FN', 'CAT', 'FORMAT', 'MOVE', 'ERASE',
  'OPEN #', 'CLOSE #', 'MERGE', 'VERIFY', 'BEEP', 'CIRCLE', 'INK', 'PAPER', 'FLASH', 'BRIGHT', 'INVERSE', 'OVER',
  'OUT', 'LPRINT', 'LLIST', 'STOP', 'READ', 'DATA', 'RESTORE', 'NEW', 'BORDER', 'CONTINUE', 'DIM', 'REM', 'FOR',
  'GO TO', 'GO SUB', 'INPUT', 'LOAD', 'LIST', 'LET', 'PAUSE', 'NEXT', 'POKE', 'PRINT', 'PLOT', 'RUN', 'SAVE',
  'RANDOMIZE', 'IF', 'CLS', 'DRAW', 'CLEAR', 'RETURN', 'COPY',
];

const REM = 0xea, BIN = 0xc4;

/** Spellings people type for some keywords, beside the ROM's own. */
const ALIASES: Record<string, number> = {
  GOTO: 0xec, GOSUB: 0xed, RANDOMISE: 0xf9, RAND: 0xf9, CONT: 0xe8, SOUND: 0xd7,
  'DEF FN': 0xce, 'OPEN#': 0xd3, 'CLOSE#': 0xd4,
};

/** Every spelling, longest first so INKEY$ wins over IN and GO SUB over GO. */
const WORDS: [string, number][] = [
  ...TOKENS.map((w, i): [string, number] => [w, 0xa5 + i]),
  ...Object.entries(ALIASES),
].sort((a, b) => b[0].length - a[0].length);

/** A number in the ROM's 5-byte floating-point form (small integers have their own form). */
export function fiveBytes(n: number): number[] {
  if (Number.isInteger(n) && Math.abs(n) <= 65535) {
    const neg = n < 0;
    const v = neg ? (n + 65536) & 0xffff : n;
    return [0, neg ? 0xff : 0, v & 0xff, v >> 8, 0];
  }
  if (n === 0) return [0, 0, 0, 0, 0];
  const neg = n < 0;
  let m = Math.abs(n);
  let e = Math.floor(Math.log2(m)) + 1;
  m = m / 2 ** e; // 0.5 <= m < 1
  if (m >= 1) { m /= 2; e++; }
  if (m < 0.5) { m *= 2; e--; }
  let mant = Math.round(m * 2 ** 32);
  if (mant >= 2 ** 32) { mant /= 2; e++; }
  if (e + 128 > 255 || e + 128 < 1) throw new Error(`number out of range: ${n}`);
  const bytes = [(mant >>> 24) & 0xff, (mant >>> 16) & 0xff, (mant >>> 8) & 0xff, mant & 0xff];
  // The top mantissa bit is always 1, so it holds the sign instead.
  bytes[0] = (bytes[0] & 0x7f) | (neg ? 0x80 : 0);
  return [e + 128, ...bytes];
}

const isLetter = (c: string) => /[A-Za-z]/.test(c);

/** Tokenizes one line's text (without its number). */
export function tokenizeLine(text: string): number[] {
  const out: number[] = [];
  let i = 0;
  let inRem = false;
  let afterBin = false;
  while (i < text.length) {
    const c = text[i];
    if (inRem) { out.push(byteOf(c)); i++; continue; }
    if (c === '"') {
      const end = text.indexOf('"', i + 1);
      const s = end < 0 ? text.slice(i) : text.slice(i, end + 1);
      for (const ch of s) out.push(byteOf(ch));
      i += s.length;
      continue;
    }
    // A keyword: whole words for letters, anywhere for <= >= <>.
    const prev = text[i - 1] ?? ' ';
    if (!isLetter(prev) && !/[0-9$]/.test(prev) || !isLetter(c)) {
      const upper = text.slice(i, i + 9).toUpperCase();
      const hit = WORDS.find(([w]) => {
        if (!upper.startsWith(w)) return false;
        if (!isLetter(w[0])) return true;
        const next = text[i + w.length] ?? ' ';
        // A keyword ending in a letter must not run into more letters (PRINTER is a name).
        return !isLetter(w[w.length - 1]) || !/[A-Za-z0-9]/.test(next) || w === 'FN';
      });
      if (hit) {
        // The listing puts its own spaces around keywords: drop typed ones.
        while (out.length && out[out.length - 1] === 0x20) out.pop();
        out.push(hit[1]);
        i += hit[0].length;
        while (text[i] === ' ') i++;
        if (hit[1] === REM) inRem = true;
        afterBin = hit[1] === BIN;
        continue;
      }
    }
    // A number not part of a name: digits as typed, then the hidden value.
    if (/[0-9.]/.test(c) && !/[A-Za-z0-9$]/.test(prev === ' ' ? ' ' : prev) && (c !== '.' || /[0-9]/.test(text[i + 1] ?? ''))) {
      const m = afterBin ? /^[01]+/.exec(text.slice(i)) : /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(text.slice(i));
      if (m) {
        for (const ch of m[0]) out.push(ch.charCodeAt(0));
        out.push(0x0e, ...fiveBytes(afterBin ? parseInt(m[0], 2) : Number(m[0])));
        i += m[0].length;
        afterBin = false;
        continue;
      }
    }
    out.push(byteOf(c));
    i++;
  }
  while (out.length && out[out.length - 1] === 0x20) out.pop();
  return out;
}

function byteOf(c: string): number {
  if (c === '£') return 0x60;
  if (c === '©') return 0x7f;
  const code = c.charCodeAt(0);
  return code < 0x80 ? code : 0x3f;
}

/** The program from a listing: one numbered line per text line; others are skipped. */
export function tokenize(listing: string): Uint8Array {
  const lines = new Map<number, number[]>();
  for (const raw of listing.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s?(.*)$/.exec(raw);
    if (!m) continue;
    const no = Number(m[1]);
    if (no < 1 || no > 9999) throw new Error(`line number ${no} is out of range (1-9999)`);
    const body = tokenizeLine(m[2]);
    if (!body.length) { lines.delete(no); continue; }
    lines.set(no, body);
  }
  if (!lines.size) throw new Error('no numbered lines to load');
  const out: number[] = [];
  for (const no of [...lines.keys()].sort((a, b) => a - b)) {
    const body = lines.get(no)!;
    const len = body.length + 1;
    out.push(no >> 8, no & 0xff, len & 0xff, len >> 8, ...body, 0x0d);
  }
  return Uint8Array.from(out);
}

/** A .tap with the program, to LOAD "": a header and the data. */
export function programTape(name: string, program: Uint8Array, autostart?: number): Uint8Array {
  const header = new Uint8Array(19);
  header[1] = 0;
  for (let i = 0; i < 10; i++) header[2 + i] = i < name.length ? name.charCodeAt(i) & 0x7f : 0x20;
  header[12] = program.length & 0xff; header[13] = program.length >> 8;
  const auto = autostart ?? 0x8000; // 8000h and up: no autostart
  header[14] = auto & 0xff; header[15] = auto >> 8;
  header[16] = program.length & 0xff; header[17] = program.length >> 8;
  header[18] = checksum(header.subarray(0, 18));
  const data = new Uint8Array(program.length + 2);
  data[0] = 0xff;
  data.set(program, 1);
  data[data.length - 1] = checksum(data.subarray(0, data.length - 1));
  const out: number[] = [];
  for (const b of [header, data]) out.push(b.length & 0xff, b.length >> 8, ...b);
  return Uint8Array.from(out);
}
