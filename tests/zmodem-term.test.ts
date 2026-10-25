// ZMODEM in TERM and I1TERM, end to end: a Spectrum runs the terminal, the
// modem dials the real AI board (with a fake DeepSeek), programs come down
// by ZMODEM onto the tape in the deck, and a program SAVEd to tape goes up
// to be fixed.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { KEYS, Spectrum } from '../src/zx/machine';
import { CS, SS } from '../src/zx/keyboard';
import { parseTap } from '../src/zx/tape';
import { programTape, tokenize } from '../src/zx/basic';
import { createAiBoard } from '../src/ai/aiboard';
import { checkBasic, checkZ80 } from '../src/ai/check';
import type { ChatChunk, ChatOptions } from '../src/ai/deepseek';

const file = (path: string) => new Uint8Array(readFileSync(new URL(path, import.meta.url)));
const rom48 = file('../src/roms/48k.rom');

function terminal(name: 'TERM' | 'I1TERM') {
  const zx = new Spectrum(rom48);
  if (name === 'I1TERM') zx.setInterface1(file('../src/roms/if1-v2.rom'));
  const answers: ChatChunk[][] = [];
  const calls: ChatOptions[] = [];
  const delivered: string[] = [];
  zx.modem.speaker = 0;
  zx.modem.dialer = (_t, h) => createAiBoard(h, {
    getKey: () => 'sk-test',
    setKey: () => {},
    chat: (opts) => {
      calls.push(opts);
      const reply = answers.shift() ?? [{ kind: 'text', text: '(no answer)' }];
      return (async function* () { for (const c of reply) yield c; })();
    },
    check: (lang, n, source) => (lang === 'basic' ? checkBasic(rom48, n, source) : checkZ80(rom48, n, source)),
    deliver: (n) => { delivered.push(n); },
    schedule: (fn) => { setTimeout(fn, 0); },
    cps: 0,
  });
  for (let i = 0; i < 150; i++) zx.runFrame();
  zx.tape = parseTap(`${name}.tap`, file(`../src/programs/${name}.tap`));
  zx.typeLoad();
  return { zx, answers, calls, delivered };
}

/** Runs the Spectrum, letting the board's timers and promises run between frames, until `done`. */
async function run(zx: Spectrum, done: () => boolean, frames = 6000): Promise<void> {
  for (let i = 0; i < frames; i++) {
    zx.runFrame();
    if (i % 5 === 0) await new Promise((r) => setTimeout(r, 0));
    if (!zx.busyTyping && done()) return;
  }
  throw new Error('timed out');
}

/** Runs `n` frames (after any typing), the board's promises in between. */
async function frames(zx: Spectrum, n: number): Promise<void> {
  for (let i = 0; i < 20000 && zx.busyTyping; i++) {
    zx.runFrame();
    if (i % 5 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  for (let i = 0; i < n; i++) {
    zx.runFrame();
    if (i % 5 === 0) await new Promise((r) => setTimeout(r, 0));
  }
}

/** What the 64-column terminal shows, roughly: enough to find words in. */
const shown = (zx: Spectrum) => zx.mem.subarray(0x4000, 0x5800);

/** The last program (header and data block) on a tape, run on a fresh 48K. */
function runLast(tap: Uint8Array): string {
  const blocks = parseTap('t.tap', tap).blocks;
  let head = 0;
  blocks.forEach((b, i) => { if (b.data?.length === 19 && b.data[0] === 0) head = i; });
  const out: number[] = [];
  for (const b of blocks.slice(head, head + 2)) out.push(b.data!.length & 0xff, b.data!.length >> 8, ...b.data!);
  const zx = new Spectrum(rom48);
  zx.tape = parseTap('last.tap', Uint8Array.from(out));
  zx.typeLoad();
  for (let i = 0; i < 5000 && zx.busyTyping; i++) zx.runFrame();
  for (let i = 0; i < 100; i++) zx.runFrame();
  return zx.screenText().join('\n');
}

const GOOD = '10 PRINT "HELLO FROM THE AI BOARD"\n20 STOP';

for (const name of ['TERM', 'I1TERM'] as const) describe(`${name} ZMODEM`, () => {
  it('downloads a program from the AI board onto the tape in the deck', async () => {
    const t = terminal(name);
    const { zx } = t;
    await frames(zx, 400); // TERM is loaded and running
    zx.tape = null; // the deck is empty: the save puts a blank tape in
    zx.typeText('atdt ai\n');
    await run(zx, () => zx.modem.online, 3000);
    await frames(zx, 50);
    t.answers.push([{ kind: 'text', text: GOOD }]);
    zx.typeText('p');
    await frames(zx, 60);
    zx.typeText('say hello\n');
    await frames(zx, 60);
    zx.typeText('b');
    await frames(zx, 60);
    zx.typeText('hello\n');
    // The tape fills with the program's two blocks.
    await run(zx, () => (zx.tape?.blocks.length ?? 0) >= 2, 20000);
    expect(t.delivered).toEqual([]); // it came by ZMODEM, not by the fallback
    expect(t.calls.length).toBe(1);
    expect(runLast(zx.tape!.toTap())).toContain('HELLO FROM THE AI BOARD');
    expect(shown(zx).length).toBeGreaterThan(0);
  }, 120_000);

  it('uploads a program from the tape to be fixed, and the fix comes back to the tape', async () => {
    const t = terminal(name);
    const { zx } = t;
    await frames(zx, 400);
    // The caller's program, SAVEd to a tape now in the deck.
    zx.tape = parseTap('sums.tap', programTape('sums', tokenize('10 PRINT "SUM IS"\n20 PRINT a+b'), 10));
    zx.typeText('atdt ai\n');
    await run(zx, () => zx.modem.online, 3000);
    await frames(zx, 50);
    zx.typeText('f');
    await frames(zx, 120);
    zx.pressKeys([CS, SS], [KEYS.U]); // EXTEND, then U: upload from the tape
    // The board gets it, runs it, and asks what to fix.
    t.answers.push([{ kind: 'text', text: '10 PRINT "SUM IS"\n15 LET a=2: LET b=3\n20 PRINT a+b' }]);
    await frames(zx, 400);
    await new Promise((r) => setTimeout(r, 1600)); // the board ignores input just after a transfer
    zx.typeText('set a and b\n');
    await run(zx, () => t.calls.length > 0 && (zx.tape?.blocks.length ?? 0) >= 4, 20000);
    const ask = t.calls[0].messages[1].content;
    expect(ask).toContain('Here is sums:\n\n10 PRINT "SUM IS"\n20 PRINT a+b');
    expect(ask).toContain('2 Variable not found, 20:1');
    expect(runLast(zx.tape!.toTap())).toContain('SUM IS\n5');
  }, 120_000);
});
