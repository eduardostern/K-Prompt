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
import { codeTape } from './tape-file';

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

/** TERM.tap: the loader (autostart line 10), then the code. */
export function buildTermTap(): Uint8Array {
  return codeTape('TERM', assembleTerm(), TERM_ORG);
}
