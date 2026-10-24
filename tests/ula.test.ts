import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildUlaTap } from '../scripts/build-ula';
import { KEYS, Spectrum } from '../src/zx/machine';
import { parseTap } from '../src/zx/tape';
import { BORDER_TOP, BORDER_X, PALETTE, WIDTH } from '../src/zx/ula';

const rom = new Uint8Array(readFileSync(new URL('../src/roms/48k.rom', import.meta.url)));
const committed = new Uint8Array(readFileSync(new URL('../src/programs/ULA.tap', import.meta.url)));

const RAINBOW = [2, 6, 4, 5, 1, 3];
/** The colour the band shows at sequence position i (BRIGHT ink). */
const colourAt = (i: number) => PALETTE[8 | RAINBOW[(i >> 1) % 6]];

function run(zx: Spectrum, frames: number) {
  for (let i = 0; i < 20000 && zx.busyTyping; i++) zx.runFrame();
  for (let i = 0; i < frames; i++) zx.runFrame();
}

/** The pixel at screen x, y (0-255, 0-191). */
const pixel = (zx: Spectrum, x: number, y: number) => zx.ula.frame[(BORDER_TOP + y) * WIDTH + BORDER_X + x];

function start(): Spectrum {
  const zx = new Spectrum(rom);
  for (let i = 0; i < 150; i++) zx.runFrame();
  zx.tape = parseTap('ULA.tap', committed);
  zx.pressKeys([KEYS.J], [KEYS.SS, KEYS.P], [KEYS.SS, KEYS.P], [KEYS.ENTER]);
  run(zx, 100);
  return zx;
}

describe('ULA.tap', () => {
  it('is built from programs/ULA.asm (npm run tapes)', () => {
    expect(Array.from(buildUlaTap())).toEqual(Array.from(committed));
  });

  it('gives every pixel line of the band its own colours, frame after frame', () => {
    const zx = start();
    for (let frame = 0; frame < 30; frame++) {
      zx.runFrame();
      // The band is columns 10-21, pixel lines 64-127; rows 10, 11 and 15 are solid ink.
      // Find this frame's phase from the first solid line, then check them all.
      // (Colours come in pairs, so match the whole line, not one pixel.)
      const phase = Array.from({ length: 12 }, (_, p) => p)
        .find((p) => Array.from({ length: 12 }, (_, c) => c).every((c) => pixel(zx, (10 + c) * 8 + 3, 80) === colourAt(p + 16 + c)));
      expect(phase).toBeDefined();
      for (const k of [...Array(16).keys()].map((i) => i + 16).concat([56, 57, 58, 59, 60, 61, 62, 63])) {
        for (let c = 0; c < 12; c++) {
          expect(pixel(zx, (10 + c) * 8 + 3, 64 + k), `line ${64 + k}, column ${10 + c}`).toBe(colourAt(phase! + k + c));
        }
      }
      // In one cell of the band, the 8 lines show more colours than the ULA's 2.
      const cell = new Set(Array.from({ length: 8 }, (_, y) => pixel(zx, 83, 80 + y)));
      expect(cell.size).toBeGreaterThanOrEqual(4);
      // Its 8x8 twin, left of the band, has one colour per cell.
      const twin = new Set(Array.from({ length: 8 }, (_, y) => pixel(zx, 11, 80 + y)));
      expect(twin.size).toBe(1);
    }
  });

  it('shows colour clash: the cells under a ball take its colour', () => {
    const zx = start();
    // Clash area: attribute rows 3-6. Some cells are the green pattern, some yellow or red.
    const attrs = Array.from(zx.mem.subarray(0x5800 + 3 * 32, 0x5800 + 7 * 32));
    expect(attrs.filter((a) => a === 0x04).length).toBeGreaterThan(100);
    expect(attrs.some((a) => a === 0x46)).toBe(true);
    expect(attrs.some((a) => a === 0x42)).toBe(true);
  });

  it('goes back to BASIC on SPACE', () => {
    const zx = start();
    zx.pressKeys([KEYS.SPACE]);
    run(zx, 30);
    expect(zx.screenText().join('\n')).toContain('0 OK');
    expect(zx.cpu.im).toBe(1);
  });
});

describe('ULA.tap balls', () => {
  it('leaves no ghost where the balls started', () => {
    const zx = new Spectrum(rom);
    for (let i = 0; i < 150; i++) zx.runFrame();
    zx.tape = parseTap('ULA.tap', buildUlaTap());
    zx.pressKeys([KEYS.J], [KEYS.SS, KEYS.P], [KEYS.SS, KEYS.P], [KEYS.ENTER]);
    run(zx, 150);
    // Ball 1 started at x 20, y 30 and has moved on: the cell is the bare pattern again.
    const at = (x: number, y: number) => zx.mem[0x4000 | ((y & 0xc0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2) | (x >> 3)];
    for (let y = 32; y < 40; y++) {
      const p = y & 7;
      expect(at(24, y)).toBe(((0x80 >> p) | (1 << p)) & 0xff);
    }
  });
});

describe('ULA.tap frame budget', () => {
  it('finishes each frame\'s work in time to HALT for the next, bounces included', () => {
    const zx = start();
    let haltT = -1;
    const step = zx.cpu.step.bind(zx.cpu);
    zx.cpu.step = () => { step(); if (zx.cpu.halted && haltT < 0) haltT = zx.cpu.cycles; };
    let worst = 0;
    for (let f = 0; f < 600; f++) {
      haltT = -1;
      zx.runFrame();
      expect(haltT, `frame ${f}`).toBeGreaterThan(0);
      worst = Math.max(worst, haltT);
    }
    // A real 48K is slower writing to the screen while it is drawn: keep a margin.
    expect(worst).toBeLessThan(64_000);
  });
});
