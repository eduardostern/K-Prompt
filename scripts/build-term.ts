/**
 * Builds TERM.tap and I1TERM.tap from programs/TERM.asm: the terminal
 * assembled at 8000h with its modem I/O (programs/io-ports.asm for TERM,
 * io-if1.asm for I1TERM), its font (programs/font4.asm) and a table
 * turning the PC's CP437 characters into ASCII, behind a BASIC loader:
 *
 *   10 CLEAR 32767: LOAD "" CODE
 *   20 RANDOMIZE USR 32768
 *
 * I1TERM's line 20 first prints what it needs and sets the Interface 1's
 * RS232 to 19200 baud (FORMAT "b";19200), which fails without one.
 * The program starts at line 10 by itself and runs on into 20; after EDIT
 * leaves the terminal (with the call up) the program ends, and RUN 20
 * goes back.
 */
import { readFileSync } from 'node:fs';
import { assemble } from '../src/zx/z80asm';
import { codeTape, codeTapeWith } from '../src/zx/tape-file';
import { tokenize } from '../src/zx/basic';

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

export type TermIo = 'ports' | 'if1';

/** The terminal's machine code, at TERM_ORG, with the modem I/O `io`. */
export function assembleTerm(io: TermIo = 'ports'): Uint8Array {
  const file = (name: string) => readFileSync(new URL(name, root), 'utf8');
  const source = [file('TERM.asm'), file(`io-${io}.asm`), cptab(), file('font4.asm')].join('\n');
  const { bytes, origin } = assemble(source);
  if (origin !== TERM_ORG) throw new Error('TERM must ORG at 8000h');
  return bytes;
}

/** TERM.tap: the loader (autostart line 10), then the code. */
export function buildTermTap(): Uint8Array {
  return codeTape('TERM', assembleTerm(), TERM_ORG);
}

/** I1TERM.tap: the same terminal on the Interface 1's RS232. */
export function buildI1termTap(): Uint8Array {
  const loader = tokenize([
    '10 CLEAR 32767: LOAD "" CODE',
    `20 PRINT "I1TERM uses the Interface 1's RS232": FORMAT "b";19200: RANDOMIZE USR 32768`,
  ].join('\n'));
  return codeTapeWith('I1TERM', loader, assembleTerm('if1'), TERM_ORG);
}
