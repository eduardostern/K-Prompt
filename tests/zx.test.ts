import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { KEYS, Model, MODELS, Spectrum } from '../src/zx/machine';
import { HEIGHT, PALETTE, WIDTH } from '../src/zx/ula';
import { blankTape, checksum, parseTap, parseTape } from '../src/zx/tape';
import { loadSnapshot, saveSna, saveZ80 } from '../src/zx/snapshot';
import { TK_WORDS } from '../src/zx/legend';
import { fiveBytes, programTape, tokenize } from '../src/zx/basic';

const rom = (name: string) => new Uint8Array(readFileSync(new URL(`../src/roms/${name}.rom`, import.meta.url)));

function boot(model: Model = '48k', frames = 150): Spectrum {
  const zx = new Spectrum(rom(model), model);
  for (let i = 0; i < frames; i++) zx.runFrame();
  return zx;
}

/** Runs frames until the typed keys are done and the ROM has had time to answer. */
function settle(zx: Spectrum, extra = 20): void {
  for (let i = 0; i < 5000 && zx.busyTyping; i++) zx.runFrame();
  for (let i = 0; i < extra; i++) zx.runFrame();
}

const screen = (zx: Spectrum) => zx.screenText().join('\n');

describe('48K Spectrum', () => {
  it('boots to the copyright message', () => {
    const zx = boot();
    expect(screen(zx)).toContain('© 1982 Sinclair Research Ltd');
  });

  it('flashes the K cursor', () => {
    const zx = boot();
    // Press ENTER to clear the copyright screen; the editor shows the K cursor.
    zx.pressKeys([KEYS.ENTER]);
    settle(zx);
    const text = screen(zx);
    expect(text.split('\n')[23]).toBe('K');
  });

  it('runs PRINT 2+2', () => {
    const zx = boot();
    // In K mode, P is PRINT; then 2+2 in L mode.
    zx.pressKeys([KEYS.P]);
    zx.typeText('2+2\n');
    settle(zx);
    const lines = zx.screenText();
    expect(lines[0]).toBe('4');
    expect(screen(zx)).toContain('0 OK, 0:1');
  });

  it('draws the border in the colour BORDER sets, at the time it changes', () => {
    const zx = boot();
    zx.pressKeys([KEYS.B]); // BORDER in K mode
    zx.typeText('2\n');
    settle(zx);
    // Top left corner is border.
    expect(zx.ula.frame[0]).toBe(PALETTE[2]);
    expect(zx.ula.frame[WIDTH * HEIGHT - 1]).toBe(PALETTE[2]);
  });

  it('makes sound when BEEP plays', () => {
    const zx = boot();
    zx.takeAudio();
    // BEEP: CAPS + SYMBOL SHIFT selects E mode, then SYMBOL SHIFT + Z.
    zx.pressKeys([KEYS.CS, KEYS.SS], [KEYS.SS, KEYS.Z]);
    zx.typeText('.5,0\n');
    settle(zx, 40);
    const s = zx.takeAudio();
    let changes = 0;
    for (let i = 1; i < s.length; i++) if (Math.abs(s[i] - s[i - 1]) > 0.3) changes++;
    // Middle C for half a second: about 260 cycles, two edges each.
    expect(changes).toBeGreaterThan(300);
    expect(screen(zx)).toContain('0 OK');
  });
});

/** The ROM's keyword table (tokens A5h-FFh, at 0096h, last letter with bit 7 set). */
function keywords(r: Uint8Array): string[] {
  const out: string[] = [];
  let word = '';
  for (let i = 0x96; out.length < 91; i++) {
    word += String.fromCharCode(r[i] & 0x7f);
    if (r[i] & 0x80) { out.push(word.trim()); word = ''; }
  }
  return out;
}

describe('Microdigital clones', () => {
  it('rename the keywords the on-screen keyboard says they do', () => {
    const sinclair = keywords(rom('48k'));
    for (const model of ['tk90x', 'tk95']) {
      const tk = keywords(rom(model));
      const renamed = Object.fromEntries(sinclair.map((w, i) => [w, tk[i]]).filter(([a, b]) => a !== b));
      expect(renamed).toEqual({ ...TK_WORDS, CONTINUE: 'CONT', RANDOMIZE: 'RAND' });
    }
  });

  it('answer Ok, in Portuguese, under their banner', () => {
    const zx = boot('tk90x', 200);
    zx.pressKeys([KEYS.P]);
    zx.typeText('2+2\n');
    settle(zx);
    // The banner stays; the report has no comma.
    expect(zx.screenText().slice(0, 2)).toEqual(['     ' + MODELS.tk90x.banner, '4']);
    expect(screen(zx)).toContain('0 Ok 0:1');
    zx.pressKeys([KEYS.P]);
    zx.typeText('x\n');
    settle(zx);
    expect(screen(zx)).toContain('2 Variavel inexiste 0:1');
  });

  it.each(['tk90x', 'tk95'] as const)('%s boots to its own banner', (model) => {
    const zx = boot(model, 200);
    expect(zx.screenText()[0].trim()).toBe(MODELS[model].banner);
  });
});

describe('tapes', () => {
  /** Types a one-line program, `10 PRINT 7`, and SAVEs it as "seven". */
  function saveSeven(): Uint8Array {
    const zx = boot();
    zx.tape = blankTape();
    zx.typeText('10');
    zx.pressKeys([KEYS.P]); // PRINT
    zx.typeText('7\n');
    zx.pressKeys([KEYS.S]); // SAVE
    zx.typeText('"seven"\n');
    settle(zx, 30);
    expect(screen(zx)).toContain('Start tape, then press any key');
    zx.pressKeys([KEYS.ENTER]);
    // The ROM pauses a second between the header and the data.
    settle(zx, 120);
    expect(screen(zx)).toContain('0 OK');
    return zx.tape.toTap();
  }

  /** LOAD "" then RUN. */
  function loadAndRun(zx: Spectrum, frames = 30): void {
    zx.pressKeys([KEYS.J], [KEYS.SS, KEYS.P], [KEYS.SS, KEYS.P]);
    zx.typeText('\n');
    settle(zx, frames);
    zx.pressKeys([KEYS.R]); // RUN
    zx.typeText('\n');
    settle(zx);
  }

  it('SAVE writes a header and a data block', () => {
    const tap = saveSeven();
    const tape = parseTap('seven.tap', tap);
    expect(tape.blocks.length).toBe(2);
    expect(tape.labels()).toEqual(['Program: seven']);
    for (const b of tape.blocks) expect(checksum(b.data!)).toBe(0);
  });

  it('LOAD "" reads it back at once', () => {
    const tap = saveSeven();
    const zx = boot();
    zx.tape = parseTap('seven.tap', tap);
    loadAndRun(zx);
    expect(zx.screenText()[0]).toBe('7');
  });

  it('LOAD "" reads it in real time from the pulses, with fast loading off', () => {
    const tap = saveSeven();
    const zx = boot();
    zx.fastLoad = false;
    zx.tape = parseTap('seven.tap', tap);
    // A header (5 s of pilot) and the data: about 10 s of tape.
    loadAndRun(zx, 700);
    expect(zx.screenText()[0]).toBe('7');
  });

  it('reads a .tzx with a standard block', () => {
    const tap = saveSeven();
    const blocks: number[] = [...'ZXTape!'].map((c) => c.charCodeAt(0));
    blocks.push(0x1a, 1, 20);
    for (let i = 0; i < tap.length;) {
      const len = tap[i] | (tap[i + 1] << 8);
      blocks.push(0x10, 0xe8, 0x03, ...tap.subarray(i, i + 2 + len));
      i += 2 + len;
    }
    const zx = boot();
    zx.tape = parseTape('seven.tzx', Uint8Array.from(blocks));
    loadAndRun(zx);
    expect(zx.screenText()[0]).toBe('7');
  });
});

describe('snapshots', () => {
  it('.sna and .z80 save and load the running machine', () => {
    for (const [save, name] of [[saveSna, 'x.sna'], [saveZ80, 'x.z80']] as const) {
      const zx = boot();
      zx.pressKeys([KEYS.B]); // BORDER 4
      zx.typeText('4\n');
      settle(zx);
      const snap = save(zx);
      const before = zx.screenText();
      const other = new Spectrum(rom('48k'));
      loadSnapshot(other, name, snap);
      expect(other.ula.border).toBe(4);
      // The loaded machine carries on: PRINT 3*3 runs on it.
      other.pressKeys([KEYS.P]);
      other.typeText('3*3\n');
      settle(other);
      expect(other.screenText()[0]).toBe('9');
      expect(before.join('\n')).toContain('0 OK');
    }
  });

  it('reads a compressed version 1 .z80', () => {
    const zx = boot();
    const v3 = saveZ80(zx);
    // Build a v1 file by hand: header with PC, compressed RAM, end marker.
    const head = v3.slice(0, 30);
    head[6] = zx.cpu.pc & 0xff;
    head[7] = zx.cpu.pc >> 8;
    head[12] |= 0x20;
    const ram = zx.mem.subarray(0x4000);
    const body: number[] = [];
    for (let i = 0; i < ram.length;) {
      let n = 1;
      while (i + n < ram.length && ram[i + n] === ram[i] && n < 255) n++;
      if (n >= 5 || (ram[i] === 0xed && n >= 2)) { body.push(0xed, 0xed, n, ram[i]); i += n; }
      else { body.push(ram[i]); if (ram[i] === 0xed && i + 1 < ram.length) { body.push(ram[i + 1]); i += 2; } else i++; }
    }
    const file = Uint8Array.from([...head, ...body, 0, 0xed, 0xed, 0]);
    const other = new Spectrum(rom('48k'));
    loadSnapshot(other, 'v1.z80', file);
    expect(Array.from(other.mem.subarray(0x4000))).toEqual(Array.from(ram));
    expect(other.cpu.pc).toBe(zx.cpu.pc);
  });
});

describe('pasted BASIC', () => {
  it('writes numbers in the ROM 5-byte form', () => {
    expect(fiveBytes(10)).toEqual([0, 0, 10, 0, 0]);
    expect(fiveBytes(-1)).toEqual([0, 0xff, 0xff, 0xff, 0]);
    expect(fiveBytes(0.5)).toEqual([0x80, 0, 0, 0, 0]);
    expect(fiveBytes(1e6)).toEqual([0x94, 0x74, 0x24, 0, 0]);
    expect(fiveBytes(-2.5)).toEqual([0x82, 0xa0, 0, 0, 0]);
  });

  it('tokenizes a listing that the ROM runs and LISTs back', () => {
    const listing = [
      '10 REM K-Prompt test: GOTO stays text',
      '20 LET total=0',
      '30 FOR i=1 TO 10: LET total=total+i: NEXT i',
      '40 IF total>=55 THEN PRINT "sum ";total;" ok"',
      '50 PRINT 3.5*2, BIN 101, INT PI',
      '60 GOTO 80',
      '70 PRINT "skipped"',
      '80 PRINT CHR$ 65+STR$ 7',
    ].join('\n');
    const zx = boot();
    // Saved with an autostart line: LOAD "" runs it.
    zx.tape = parseTap('basic.tap', programTape('test', tokenize(listing), 10));
    zx.pressKeys([KEYS.J], [KEYS.SS, KEYS.P], [KEYS.SS, KEYS.P]);
    zx.typeText('\n');
    settle(zx, 60);
    // Under the "Program: test" the ROM printed while loading.
    const out = zx.screenText();
    expect(out.slice(1, 6)).toEqual(['Program: test', 'sum 55 ok', '7               5', '3', 'A7']);
    expect(screen(zx)).toContain('0 OK, 80:1');
    // LIST shows the lines as typed, the keywords spaced by the ROM.
    zx.pressKeys([KEYS.K]);
    zx.typeText('\n');
    settle(zx, 30);
    const list = zx.screenText();
    expect(list).toContain('  10 REM K-Prompt test: GOTO sta');
    expect(list).toContain('  30 FOR i=1 TO 10: LET total=to');
    expect(list).toContain('  50 PRINT 3.5*2,BIN 101,INT PI');
    expect(list).toContain('  60 GO TO 80');
  });
});
