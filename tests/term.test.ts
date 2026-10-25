import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assembleTerm, buildI1termTap, buildTermTap, TermIo } from '../scripts/build-term';
import { KEYS, Spectrum } from '../src/zx/machine';
import { CS } from '../src/zx/keyboard';
import type { Dialer, LinkHandlers } from '../src/zx/modem';
import { parseTap } from '../src/zx/tape';

const file = (path: string) => new Uint8Array(readFileSync(new URL(path, import.meta.url)));
const rom = file('../src/roms/48k.rom');

/** The 4-pixel font from TERM's code, to read its 64-column screen back. */
function fontOf(code: Uint8Array): Map<string, string> {
  const glyphs = new Map<string, string>();
  // The font is the last 96 × 8 bytes of the code.
  const font = code.subarray(code.length - 96 * 8);
  for (let c = 0; c < 96; c++) {
    const g = Array.from(font.subarray(c * 8, c * 8 + 8), (b) => b >> 4);
    const ch = String.fromCharCode(c + 32);
    // Plain glyphs first; reverse video only where it is not another glyph.
    if (!glyphs.has(String(g))) glyphs.set(String(g), ch);
  }
  for (let c = 0; c < 96; c++) {
    const g = Array.from(font.subarray(c * 8, c * 8 + 8), (b) => (b >> 4) ^ 15);
    if (!glyphs.has(String(g))) glyphs.set(String(g), String.fromCharCode(c + 32));
  }
  return glyphs;
}

function termText(zx: Spectrum, glyphs: Map<string, string>): string[] {
  const lines: string[] = [];
  for (let row = 0; row < 24; row++) {
    let s = '';
    for (let col = 0; col < 64; col++) {
      const cell: number[] = [];
      for (let y = 0; y < 8; y++) {
        const py = row * 8 + y;
        const b = zx.mem[0x4000 | ((py & 0xc0) << 5) | ((py & 7) << 8) | ((py & 0x38) << 2) | (col >> 1)];
        cell.push(col & 1 ? b & 15 : b >> 4);
      }
      s += glyphs.get(String(cell)) ?? '·';
    }
    lines.push(s.trimEnd().replace(/\x7f$/, '').trimEnd()); // the cursor is an inverted space
  }
  return lines;
}

class FakeLine {
  sent: number[] = [];
  handlers?: LinkHandlers;
  dialer: Dialer = (_target, handlers) => {
    this.handlers = handlers;
    return { send: (b) => this.sent.push(...b), close: () => {} };
  };
  receive(s: string) { this.handlers!.onData(Uint8Array.from(s, (c) => c.charCodeAt(0))); }
}

function run(zx: Spectrum, frames = 10) {
  for (let i = 0; i < 20000 && zx.busyTyping; i++) zx.runFrame();
  for (let i = 0; i < frames; i++) zx.runFrame();
}

/** TERM on K-Prompt's modem ports; I1TERM on the Interface 1's RS232, at 19200 baud. */
const TERMS: { name: string; io: TermIo; build: () => Uint8Array; banner: string; below: number }[] = [
  { name: 'TERM', io: 'ports', build: buildTermTap, banner: 'K-Prompt TERM: 64 columns on the telnet modem.', below: 6 },
  { name: 'I1TERM', io: 'if1', build: buildI1termTap, banner: 'K-Prompt I1TERM: 64 columns on the Interface 1\'s RS232,', below: 7 },
];

for (const { name, io, build, banner, below } of TERMS) describe(name, () => {
  const committed = file(`../src/programs/${name}.tap`);

  it(`the committed ${name}.tap is built from programs/TERM.asm and io-${io}.asm (npm run tapes)`, () => {
    expect(Array.from(build())).toEqual(Array.from(committed));
  });

  it('loads from tape, talks to the modem and follows ANSI', () => {
    const code = assembleTerm(io);
    const glyphs = fontOf(code);
    const zx = new Spectrum(rom);
    if (io === 'if1') zx.setInterface1(file('../src/roms/if1-v2.rom'));
    const line = new FakeLine();
    zx.modem.dialer = line.dialer;
    zx.modem.speaker = 0;
    for (let i = 0; i < 150; i++) zx.runFrame();
    zx.tape = parseTap(`${name}.tap`, committed);
    zx.pressKeys([KEYS.J], [KEYS.SS, KEYS.P], [KEYS.SS, KEYS.P], [KEYS.ENTER]);
    run(zx, 200);
    let text = termText(zx, glyphs);
    expect(text[0]).toBe(banner);

    // AT commands go to the modem, its answers come back on the screen.
    zx.typeText('ati\n');
    run(zx, 20);
    text = termText(zx, glyphs);
    expect(text.join('\n')).toContain('K-Prompt telnet modem');
    expect(text.join('\n')).toMatch(/1 {2}vert\.synchro\.net:23/);

    zx.typeText('atdt2\n');
    run(zx, 20);
    expect(line.handlers).toBeDefined();
    line.handlers!.onOpen();
    run(zx, 5);
    expect(zx.modem.online).toBe(true);

    // ANSI: clear, position, text, then a cursor position report.
    line.receive('\x1b[2J\x1b[5;10HHello, \x1b[7mSpectrum\x1b[0m!\x1b[6n');
    run(zx, 10);
    text = termText(zx, glyphs);
    expect(text[0]).toBe('');
    expect(text[4]).toBe(' '.repeat(9) + 'Hello, Spectrum!');
    expect(String.fromCharCode(...line.sent)).toContain('\x1b[5;26R');

    // Keys: letters, cursor up as ANSI, BREAK as ESC, EXTEND then C as CTRL+C.
    line.sent.length = 0;
    zx.typeText('x');
    zx.pressKeys([CS, KEYS['7']], [CS, KEYS.SPACE], [CS, KEYS.SS], [KEYS.C]);
    run(zx, 10);
    expect(line.sent).toEqual([0x78, 0x1b, 0x5b, 0x41, 0x1b, 0x03]);

    // Lines that run off the bottom scroll the screen up.
    line.receive('\x1b[24;1Hlast line\r\nafter');
    run(zx, 10);
    text = termText(zx, glyphs);
    expect(text[22]).toBe('last line');
    expect(text[23]).toBe('after');
    expect(text[3]).toBe(' '.repeat(9) + 'Hello, Spectrum!');

    // EDIT leaves for BASIC with the call up.
    zx.pressKeys([CS, KEYS['1']]);
    run(zx, 20);
    expect(zx.modem.online).toBe(true);
    expect(zx.screenText().join('\n')).toContain('0 OK');

    // RUN 20 goes back to the terminal, still online.
    zx.pressKeys([KEYS.R]);
    zx.typeText('20\n');
    run(zx, 30);
    expect(termText(zx, glyphs)[0]).toBe(banner);
    line.receive('back');
    run(zx, 5);
    expect(termText(zx, glyphs)[below]).toBe('back'); // the line under the banner
  });
});
