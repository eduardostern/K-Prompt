// The ZX81, ZX80 and Microdigital's TKs, booted headless from their ROMs:
// the CPU draws the picture, keys are typed through the matrix, and LOAD
// and SAVE go through the tape traps.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FRAME_H, FRAME_W, Zx81, Zx81Model, ZX81_MODELS } from '../src/zx81/machine';
import { keyAt, keysFor } from '../src/zx81/keys';

const rom = (n: string) => new Uint8Array(readFileSync(new URL(`../src/roms/${n}.rom`, import.meta.url)));

/** A machine booted to its K cursor (60 Hz machines have less spare time: they take longer). */
function boot(model: Zx81Model, ramK = 16): Zx81 {
  const m = new Zx81(model, rom(ZX81_MODELS[model].rom), ramK);
  for (let i = 0; i < 500; i++) m.runFrame();
  return m;
}

/** Types: "@KEY" presses a key by name (keywords: P is PRINT on a ZX81), other text by character. */
function type(m: Zx81, script: string, settle = 100): void {
  for (const tok of script.split('|')) {
    m.pressKeys(tok.startsWith('@') ? [keyAt(tok.slice(1))!] : [...tok].map((c) => keysFor(c, m.info.zx80)!));
  }
  for (let i = 0; i < 5000 && m.isTyping; i++) m.runFrame();
  for (let i = 0; i < settle; i++) m.runFrame();
}

const lines = (m: Zx81) => m.screenText().split('\n');

describe('the ZX81', () => {
  it('draws its K cursor with the CPU: the bottom row, inverse', () => {
    const m = boot('zx81');
    expect(lines(m)[23]).toBe('K');
    let ink = 0;
    let top = FRAME_H;
    for (let y = 0; y < FRAME_H; y++) for (let x = 0; x < FRAME_W; x++) if (m.screen[y * FRAME_W + x] === 1) { ink++; top = Math.min(top, y); }
    expect(ink).toBeGreaterThan(30); // a block with a K cut out of it
    expect(ink).toBeLessThan(64);
    expect(top).toBeGreaterThan(200); // the 24th row, under 23 empty ones
  });

  it('works out PRINT 2+2*3-1', () => {
    const m = boot('zx81');
    type(m, '@P|2+2*3-1|@NEWLINE');
    expect(lines(m)[0]).toBe('7');
    expect(lines(m)[23]).toBe('0/0');
  });

  it('runs in 1K, as sold', () => {
    const m = boot('zx81', 1);
    type(m, '@P|6*7|@NEWLINE');
    expect(lines(m)[0]).toBe('42');
  });

  it('gives BASIC about 0.9 MHz at 50 Hz and 0.55 MHz at 60 Hz (the NMIs take the rest)', () => {
    // Measured on the real machines: about 0.80 and 0.54 MHz.
    for (const [model, lo, hi] of [['zx81', 0.75, 0.95], ['tk85', 0.5, 0.62]] as const) {
      const m = boot(model);
      const cpu = m.cpu;
      const step = cpu.step.bind(cpu);
      let user = 0;
      cpu.step = () => {
        const pc = cpu.pc;
        const c = cpu.cycles;
        step();
        if (pc >= 0x0400 && pc < 0x8000) user += cpu.cycles - c;
      };
      for (let i = 0; i < 50; i++) m.runFrame();
      const mhz = (user / 50) * m.info.hz / 1e6;
      expect(mhz).toBeGreaterThan(lo);
      expect(mhz).toBeLessThan(hi);
    }
  });

  it('SAVEs to the tape and LOADs back', () => {
    const m = boot('zx81');
    const saved: string[] = [];
    m.onSave = (f) => saved.push(f.name);
    type(m, '10|@P|"OI"|@NEWLINE');
    type(m, '@S|"PROG"|@NEWLINE');
    expect(saved).toEqual(['PROG']);
    type(m, '@A|@NEWLINE', 400); // NEW checks the RAM again
    m.tapePos = 0;
    type(m, '@J|""|@NEWLINE', 200);
    type(m, '@R|@NEWLINE');
    expect(lines(m)[0]).toBe('OI');
  });
});

describe('typing symbols (SHIFT and a key, each machine its own)', () => {
  it('types every symbol into a string on a ZX81 and a ZX80', () => {
    const symbols = '$():;?/*<>,-+=£';
    const zx81 = boot('zx81');
    type(zx81, `@P|"${symbols}"|@NEWLINE`);
    expect(lines(zx81)[0]).toBe(symbols);
    const zx80 = boot('zx80', 1);
    type(zx80, `@O|"${symbols}"|@NEWLINE`);
    expect(lines(zx80)[0]).toBe(symbols);
  });
});

describe('Microdigital TK85 and TK82C (60 Hz, as sold in Brazil)', () => {
  it('report 60 Hz on port FE bit 6 and work out sums', () => {
    for (const model of ['tk85', 'tk82c'] as const) {
      const m = boot(model);
      expect(m.read(0x4028)).toBe(31); // MARGIN: the ROM chose 60 Hz borders
      type(m, '@P|2+2|@NEWLINE');
      expect(lines(m)[0]).toBe('4');
    }
  });

  it('TK85: its 2K extension is at 2000h, and its RAM test stops at 16K', () => {
    const m = boot('tk85');
    expect(m.read(0x2000)).toBe(rom('tk85')[0x2000]);
    expect(m.read(0x4004) | (m.read(0x4005) << 8)).toBe(0x8000); // RAMTOP
  });
});

describe('the ZX80 and TK80', () => {
  it('print with O, its PRINT key', () => {
    for (const model of ['zx80', 'tk80'] as const) {
      const m = boot(model, 1);
      type(m, '@O|2+2|@NEWLINE');
      expect(lines(m)[0]).toBe('4');
    }
  });

  it('SAVE (E) and LOAD (W) through the tape', () => {
    const m = boot('zx80', 16);
    type(m, '10|@O|"OI"|@NEWLINE');
    type(m, '@E|@NEWLINE');
    expect(m.tape).toHaveLength(1);
    type(m, '@Q|@NEWLINE'); // NEW
    m.tapePos = 0;
    type(m, '@W|@NEWLINE');
    type(m, '@R|@NEWLINE');
    expect(lines(m)[0]).toBe('OI');
  });
});
