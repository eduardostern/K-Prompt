import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { KEYS, SS, Spectrum } from '../src/zx/machine';
import { CS } from '../src/zx/keyboard';
import { Cartridge, MDR_LENGTH } from '../src/zx/microdrive';
import { programTape, tokenize } from '../src/zx/basic';
import { parseTap } from '../src/zx/tape';
import { loadSnapshot, saveZ80 } from '../src/zx/snapshot';

const rom = (name: string) => new Uint8Array(readFileSync(new URL(`../src/roms/${name}.rom`, import.meta.url)));

function machine(if1 = 'if1-v2'): Spectrum {
  const zx = new Spectrum(rom('48k'));
  zx.setInterface1(rom(if1));
  for (let i = 0; i < 150; i++) zx.runFrame();
  return zx;
}

function settle(zx: Spectrum, extra = 50): void {
  for (let i = 0; i < 20000 && zx.busyTyping; i++) zx.runFrame();
  for (let i = 0; i < extra; i++) zx.runFrame();
}

const screen = (zx: Spectrum) => zx.screenText().filter((l) => l.trim()).join('\n');
/** E mode (CAPS + SYMBOL SHIFT), then SYMBOL SHIFT + key: CAT is 9, FORMAT 0. */
const extended = (zx: Spectrum, key: string) => zx.pressKeys([CS, SS], [SS, KEYS[key]]);
const enter = (zx: Spectrum) => { zx.pressKeys([KEYS.ENTER]); settle(zx, 20); };

describe('Interface 1', () => {
  for (const version of ['if1-v2', 'if1-v1']) {
    it(`${version}: pages its ROM in for CAT, and out again`, () => {
      const zx = machine(version);
      extended(zx, '9');
      zx.typeText(' 1\n');
      settle(zx, 400);
      expect(screen(zx)).toContain('Microdrive not present');
      expect(zx.if1Active).toBe(false);
      expect(zx.mem[0x0008]).toBe(rom('48k')[0x0008]);
    });

    it(`${version}: FORMATs, SAVEs, CATs and LOADs on a Microdrive`, () => {
      const zx = machine(version);
      zx.if1!.drives[0].cartridge = Cartridge.blank();
      extended(zx, '0');
      zx.typeText('"m";1;"test"\n');
      settle(zx, 1500);
      expect(screen(zx)).toContain('0 OK');
      expect(zx.if1!.drives[0].cartridge!.label).toBe('test');
      enter(zx);
      zx.typeText('10');
      zx.pressKeys([KEYS.P]);
      zx.typeText('7\n');
      zx.pressKeys([KEYS.S]);
      zx.typeText('*"m";1;"prog"\n');
      settle(zx, 1500);
      expect(screen(zx)).toContain('0 OK');
      enter(zx);
      zx.pressKeys([KEYS.A]); // NEW
      zx.typeText('\n');
      settle(zx, 60);
      enter(zx);
      extended(zx, '9');
      zx.typeText(' 1\n');
      settle(zx, 1500);
      expect(screen(zx)).toMatch(/test\nprog\n\d+\n0 OK/);
      enter(zx);
      zx.pressKeys([KEYS.J]);
      zx.typeText('*"m";1;"prog"\n');
      settle(zx, 1500);
      zx.pressKeys([KEYS.R]);
      zx.typeText('\n');
      settle(zx);
      expect(zx.screenText()[0]).toBe('7');
    });
  }

  it('keeps a cartridge as .mdr byte for byte, and refuses to write when protected', () => {
    const zx = machine();
    const c = Cartridge.blank();
    zx.if1!.drives[0].cartridge = c;
    extended(zx, '0');
    zx.typeText('"m";1;"keep"\n');
    settle(zx, 1500);
    const mdr = c.toMdr();
    expect(mdr.length).toBe(MDR_LENGTH);
    const again = Cartridge.fromMdr(mdr);
    expect(Array.from(again.toMdr())).toEqual(Array.from(mdr));
    expect(again.label).toBe('keep');
    again.writeProtect = true;
    zx.if1!.drives[0].cartridge = again;
    enter(zx);
    zx.typeText('10');
    zx.pressKeys([KEYS.P]);
    zx.typeText('1\n');
    zx.pressKeys([KEYS.S]);
    zx.typeText('*"m";1;"x"\n');
    settle(zx, 1500);
    expect(screen(zx)).toContain('Drive \'write\' protected');
  });

  it('keeps its paged ROM in a .z80 snapshot', () => {
    const zx = machine();
    zx.if1Active = true;
    const snap = saveZ80(zx);
    expect(snap[34]).toBe(1); // 48K + Interface 1
    expect(snap[36]).toBe(0xff);
    const other = machine();
    loadSnapshot(other, 'x.z80', snap);
    expect(other.if1Active).toBe(true);
    expect(other.mem[0x0008]).toBe(rom('if1-v2')[0x0008]);
  });
});

describe('Interface 1 RS232', () => {
  /** BASIC sends ATI to the modem through the RS232 and prints what comes back. */
  function ati(version: string, baud: number): { sent: string; text: string } {
    const zx = new Spectrum(rom('48k'));
    zx.setInterface1(rom(version));
    const sent: number[] = [];
    const write = zx.modem.write.bind(zx.modem);
    zx.modem.write = (b: number) => { sent.push(b); write(b); };
    const prog = tokenize(`10 FORMAT "b";${baud}\n20 OPEN #4;"b"\n30 PRINT #4;"ATI";CHR$ 13;\n40 LET a$=INKEY$#4: IF a$<>"" THEN PRINT a$;\n50 GO TO 40`);
    zx.tape = parseTap('t.tap', programTape('t', prog, 10));
    zx.typeLoad();
    for (let i = 0; i < 900; i++) zx.runFrame();
    return { sent: String.fromCharCode(...sent), text: zx.screenText().join('\n') };
  }

  for (const [version, baud] of [['if1-v2', 1200], ['if1-v2', 9600], ['if1-v2', 19200], ['if1-v1', 9600]] as const) {
    it(`${version} at ${baud} baud: BASIC talks to the modem with OPEN #4;"b"`, () => {
      const { sent, text } = ati(version, baud);
      expect(sent).toBe('ATI\r');
      expect(text).toContain('K-Prompt telnet modem');
    });
  }
});
