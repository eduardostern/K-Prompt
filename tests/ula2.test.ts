// ULA2.tap: a photograph with the colour clash fixed down the middle of a
// 48K's screen (8×1 attributes, columns 8-23, all 192 lines), checked pixel
// by pixel against the picture it was converted to.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildUla2Tap, pictures } from '../scripts/build-ula2';
import { render, SpectrumImage } from '../scripts/spectrum-image';
import { KEYS, Spectrum } from '../src/zx/machine';
import { parseTap } from '../src/zx/tape';
import { BORDER_TOP, BORDER_X, WIDTH } from '../src/zx/ula';

const rom = new Uint8Array(readFileSync(new URL('../src/roms/48k.rom', import.meta.url)));
const committed = new Uint8Array(readFileSync(new URL('../src/programs/ULA2.tap', import.meta.url)));
const { clash, fixed } = pictures();

function run(zx: Spectrum, frames: number) {
  for (let i = 0; i < 20000 && zx.busyTyping; i++) zx.runFrame();
  for (let i = 0; i < frames; i++) zx.runFrame();
}

function start(): Spectrum {
  const zx = new Spectrum(rom);
  for (let i = 0; i < 150; i++) zx.runFrame();
  zx.tape = parseTap('ULA2.tap', committed);
  zx.pressKeys([KEYS.J], [KEYS.SS, KEYS.P], [KEYS.SS, KEYS.P], [KEYS.ENTER]);
  run(zx, 150);
  return zx;
}

/** The screen's colour (as K-Prompt draws it) at x, y of a converted picture. */
function expected(img: SpectrumImage): (x: number, y: number) => number {
  const rgb = render(img);
  return (x, y) => {
    const i = (y * 256 + x) * 3;
    return ((0xff << 24) | (rgb[i + 2] << 16) | (rgb[i + 1] << 8) | rgb[i]) >>> 0;
  };
}

/** Wrong pixels over `frames` frames: the middle (columns 8-23) against `middle`, the sides against the ULA's picture. */
function wrongPixels(zx: Spectrum, middle: SpectrumImage, frames: number): number {
  const mid = expected(middle);
  const side = expected(clash);
  let wrong = 0;
  for (let f = 0; f < frames; f++) {
    zx.runFrame();
    for (let y = 0; y < 192; y++) {
      for (let x = 0; x < 256; x++) {
        const want = x >= 64 && x < 192 ? mid(x, y) : side(x, y);
        if (zx.ula.frame[(BORDER_TOP + y) * WIDTH + BORDER_X + x] !== want) wrong++;
      }
    }
  }
  return wrong;
}

describe('ULA2.tap', () => {
  it('is built from programs/ULA2.asm and beach.png (npm run tapes)', () => {
    expect(Array.from(buildUla2Tap())).toEqual(Array.from(committed));
  });

  it('the fix is needed: the picture has cells whose 8 lines want more than 2 colours', () => {
    let cells = 0;
    for (let row = 0; row < 24; row++) {
      for (let col = 8; col < 24; col++) {
        const lines = new Set(Array.from({ length: 8 }, (_, i) => fixed.attrs[(row * 8 + i) * 32 + col]));
        if (lines.size > 1) cells++;
      }
    }
    expect(cells).toBeGreaterThan(200); // of the band's 384 cells
  });

  it('shows every pixel of the fixed picture in the middle, line by line, frame after frame', () => {
    expect(wrongPixels(start(), fixed, 30)).toBe(0);
  });

  it('M swaps the middle to the ULA\'s own way, and back', () => {
    const zx = start();
    zx.pressKeys([KEYS.M]);
    run(zx, 20);
    expect(wrongPixels(zx, clash, 10)).toBe(0);
    zx.pressKeys([KEYS.M]);
    run(zx, 20);
    expect(wrongPixels(zx, fixed, 10)).toBe(0);
  });

  it('finishes each frame in time to HALT for the next', () => {
    const zx = start();
    let haltT = -1;
    const step = zx.cpu.step.bind(zx.cpu);
    zx.cpu.step = () => { step(); if (zx.cpu.halted && haltT < 0) haltT = zx.cpu.cycles; };
    for (let f = 0; f < 300; f++) {
      haltT = -1;
      zx.runFrame();
      expect(haltT, `frame ${f}`).toBeGreaterThan(0);
      expect(haltT).toBeLessThan(64_000);
    }
  });

  it('goes back to BASIC on SPACE', () => {
    const zx = start();
    zx.pressKeys([KEYS.SPACE]);
    run(zx, 30);
    expect(zx.screenText().join('\n')).toContain('0 OK');
    expect(zx.cpu.im).toBe(1);
  });
});
