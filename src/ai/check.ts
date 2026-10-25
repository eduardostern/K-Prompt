/**
 * Checks a program the AI board's model wrote, and makes its tape.
 *
 * BASIC is tokenized onto a tape (as a pasted listing is) and run on a
 * hidden 48K: if the ROM stops it with an error report ("2 Variable not
 * found, 30:1"), that report is the error. A program still running, or
 * waiting for a key or for INPUT, after about ten seconds is fine, and so
 * are 0 OK, 9 STOP and D BREAK.
 *
 * Z80 is assembled; its tape loads the code behind CLEAR and runs it with
 * RANDOMIZE USR, and it is run the same way: a crash that resets the
 * Spectrum, or an error report, comes back as the error.
 */
import type { CheckResult } from './aiboard';
import { Spectrum } from '../zx/machine';
import { programTape, tokenize } from '../zx/basic';
import { parseTap } from '../zx/tape';
import { assemble } from '../zx/z80asm';
import { codeTape } from '../zx/tape-file';

/** How long a program runs before it counts as working: ~10 s of Spectrum time. */
const RUN_FRAMES = 500;

/** ERR_NR (5C3Ah) holds the report code less one; these are not failures. */
const FINE = new Set([0xff, 0x08 /* 9 STOP */, 0x0c /* D BREAK */]);

/** A breather for the page every so many frames. */
const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

/** Loads `tap` on a fresh 48K and runs it; returns the report, if it failed. */
async function run(rom48: Uint8Array, tap: Uint8Array): Promise<string | undefined> {
  const zx = new Spectrum(rom48);
  zx.tape = parseTap('check.tap', tap);
  zx.typeLoad();
  for (let f = 0; f < 5000 && zx.busyTyping; f++) {
    zx.runFrame();
    if (f % 100 === 99) await yieldNow();
  }
  for (let f = 0; f < RUN_FRAMES; f++) {
    zx.runFrame();
    if (f % 100 === 99) await yieldNow();
    // Back at the copyright message: the program crashed and the Spectrum reset.
    if (f % 50 === 49 && zx.screenText().some((l) => l.includes('Sinclair Research Ltd'))) return 'the program crashed and the Spectrum reset';
  }
  const err = zx.mem[0x5c3a];
  if (FINE.has(err)) return undefined;
  // The report is the last line on the screen with text, e.g. "2 Variable not found, 30:1".
  const lines = zx.screenText().filter((l) => l.trim());
  return lines[lines.length - 1]?.replace(/·/g, '').trim() || `error report ${(err + 1).toString(36).toUpperCase()}`;
}

export async function checkBasic(rom48: Uint8Array, name: string, listing: string): Promise<CheckResult> {
  let program: Uint8Array;
  try {
    program = tokenize(listing);
  } catch (e) {
    return { ok: false, errors: [(e as Error).message] };
  }
  const tap = programTape(name.slice(0, 10), program, (program[0] << 8) | program[1]);
  const report = await run(rom48, tap);
  return report ? { ok: false, errors: [report] } : { ok: true, tap, errors: [] };
}

export async function checkZ80(rom48: Uint8Array, name: string, source: string): Promise<CheckResult> {
  let bytes: Uint8Array, origin: number;
  try {
    ({ bytes, origin } = assemble(source));
  } catch (e) {
    const m = /^line (\d+): (.*)$/.exec((e as Error).message);
    const text = m ? `${m[0]}   [${source.split(/\r?\n/)[Number(m[1]) - 1]?.trim() ?? ''}]` : (e as Error).message;
    return { ok: false, errors: [text] };
  }
  if (origin < 0x6000 || origin + bytes.length > 0xff58) {
    return { ok: false, errors: [`the code runs from ${origin} to ${origin + bytes.length}: keep it within 32768-65367 (ORG 32768)`] };
  }
  const tap = codeTape(name.slice(0, 10), bytes, origin);
  const report = await run(rom48, tap);
  return report ? { ok: false, errors: [report] } : { ok: true, tap, errors: [] };
}
