/**
 * Builds .tap files of the kind the ROM's SAVE wrote: a BASIC loader that
 * loads machine code and runs it, as the programs on the shelf come.
 */
import { checksum } from '../src/zx/tape';

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

/**
 *   10 CLEAR clear: LOAD "" CODE
 *   20 RANDOMIZE USR start
 * Line 10 runs by itself and on into 20; RUN 20 starts the code again.
 */
export function loaderProgram(clear: number, start: number): Uint8Array {
  return Uint8Array.from([
    ...line(10, [CLEAR, ...num(clear), COLON, LOAD, Q, Q, CODE]),
    ...line(20, [RANDOMIZE, USR, ...num(start)]),
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

/** A tape with the loader (autostart line 10) and the code at `org`. */
export function codeTape(name: string, code: Uint8Array, org: number): Uint8Array {
  return codeTapeWith(name, loaderProgram(org - 1, org), code, org);
}

/** A program (autostart line 10) that loads the code, then the code at `org`. */
export function codeTapeWith(name: string, prog: Uint8Array, code: Uint8Array, org: number): Uint8Array {
  const blocks = [header(0, name, prog.length, 10, prog.length), dataBlock(prog), header(3, `${name}code`.slice(0, 10), code.length, org, 32768), dataBlock(code)];
  const out: number[] = [];
  for (const b of blocks) out.push(b.length & 0xff, b.length >> 8, ...b);
  return Uint8Array.from(out);
}
