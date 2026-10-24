import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { KEYS, Model, MODELS, Spectrum, TIMING_48K, TIMING_TK60, TkVideo } from '../src/zx/machine';
import { BORDER_TOP, BORDER_X, contentionTable, HEIGHT, PALETTE, Ula, WIDTH } from '../src/zx/ula';
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

describe('TK90X ROM extras', () => {
  /** The 21 UDGs as 8-byte glyphs. */
  const udgs = (zx: Spectrum) => {
    const at = zx.mem[0x5c7b] | (zx.mem[0x5c7c] << 8);
    return Array.from({ length: 21 }, (_, i) => Array.from(zx.mem.subarray(at + i * 8, at + i * 8 + 8)));
  };
  const glyph = (zx: Spectrum, ch: string) => Array.from(zx.mem.subarray(0x3d00 + (ch.charCodeAt(0) - 32) * 8, 0x3d00 + (ch.charCodeAt(0) - 31) * 8));

  it('SYMBOL SHIFT + X is UDG, which loads accented letters; UDG 2 is an editor', () => {
    const zx = boot('tk90x', 200);
    // At power-on the UDGs are copies of A-U, as on the 48K.
    expect(udgs(zx)[0]).toEqual(glyph(zx, 'A'));
    zx.pressKeys([KEYS.SS, KEYS.X]);
    zx.typeText('\n');
    settle(zx, 30);
    const pt = udgs(zx);
    // Á: an acute accent over the A's body, which moved down two lines.
    expect(pt[0].slice(0, 2)).toEqual([0x08, 0x10]);
    expect(pt[0].slice(2, 7)).toEqual(glyph(zx, 'A').slice(1, 6));
    // Ç and ç at T and U: a cedilla below.
    expect(pt[19][7]).toBe(0x10);
    expect(pt[20][7]).toBe(0x10);

    zx.pressKeys([KEYS.SS, KEYS.X]);
    zx.typeText('2\n');
    settle(zx, 30);
    // The editor shows the letter and its UDG, now Á (not in the ROM font).
    expect(zx.screenText().some((l) => l.startsWith('A='))).toBe(true);
    expect(zx.screenText()).toContain('ABCDEFGHIJKLMNOPQRSTU');
  });

  it('carries the messages in Portuguese and, in the spare space, in Spanish', () => {
    const text = String.fromCharCode(...rom('tk90x').map((b) => b & 0x7f));
    expect(text).toContain('Ligue o gravador, digite ENTER');
    expect(text).toContain('Conecte grabador, digite ENTER');
    expect(text).toContain('Variable inexist');
  });
});

describe('TK timing', () => {
  /** Edges per second in the sound of BEEP 1,0 (middle C on the ROM's own delay loop). */
  function beepRate(model: Model, video?: TkVideo): number {
    const zx = new Spectrum(rom(model), model, 44100, video);
    for (let i = 0; i < 200; i++) zx.runFrame();
    zx.pressKeys([KEYS.CS, KEYS.SS], [KEYS.SS, KEYS.Z]);
    zx.typeText('1,0\n');
    for (let i = 0; i < 5000 && zx.busyTyping; i++) zx.runFrame();
    zx.takeAudio();
    for (let i = 0; i < 20; i++) zx.runFrame();
    const s = zx.takeAudio();
    // Crossings of the middle level (an edge between samples leaves one in-between value).
    let edges = 0;
    for (let i = 1; i < s.length; i++) if ((s[i] > 0.375) !== (s[i - 1] > 0.375)) edges++;
    return edges / (s.length / 44100);
  }

  it('runs the TK at 60 Hz with 228-T lines, and at 50 Hz or as a Ferranti on request', () => {
    expect(new Spectrum(rom('tk90x'), 'tk90x').timing).toEqual(TIMING_TK60);
    expect(TIMING_TK60.frameT).toBe(59_736);
    expect(new Spectrum(rom('tk90x'), 'tk90x', 44100, '50').timing.frameT).toBe(71_136);
    expect(new Spectrum(rom('tk90x'), 'tk90x', 44100, 'ferranti').timing.frameT).toBe(69_888);
    const zx = new Spectrum(rom('tk95'), 'tk95');
    zx.runFrame();
    expect(zx.cpu.cycles).toBeLessThan(40);
  });

  it('plays BEEP higher on the TK clock, as the real one did', () => {
    const sinclair = beepRate('48k');
    const tk = beepRate('tk90x', '60');
    expect(sinclair / 2).toBeGreaterThan(255);
    expect(sinclair / 2).toBeLessThan(268); // middle C, 261.6 Hz
    expect(tk / sinclair).toBeCloseTo(3_575_611 / 3_500_000, 1);
  });

  it('loads a tape in real time at 60 Hz', () => {
    const zx = boot();
    zx.tape = blankTape();
    zx.typeText('10');
    zx.pressKeys([KEYS.P]);
    zx.typeText('7\n');
    zx.pressKeys([KEYS.S]);
    zx.typeText('"seven"\n');
    settle(zx, 30);
    zx.pressKeys([KEYS.ENTER]);
    settle(zx, 120);
    const tk = boot('tk90x', 200);
    tk.fastLoad = false;
    tk.tape = parseTap('seven.tap', zx.tape.toTap());
    tk.pressKeys([KEYS.J], [KEYS.SS, KEYS.P], [KEYS.SS, KEYS.P]);
    tk.typeText('\n');
    settle(tk, 800);
    tk.pressKeys([KEYS.R]);
    tk.typeText('\n');
    settle(tk);
    expect(tk.screenText()).toContain('7');
  });
});

describe('the ULA reads each cell as the beam reaches it', () => {
  it('shows an attribute change mid-line from that cell on', () => {
    const mem = new Uint8Array(0x10000);
    const ula = new Ula(mem, TIMING_48K);
    mem.fill(0x38, 0x5800, 0x5b00); // white paper everywhere
    const line = 40; // pixel line 40: attribute row 5
    const start = TIMING_48K.displayStart + line * TIMING_48K.lineT;
    // The beam is half-way along the line: cells 0-15 have been read.
    ula.catchUp(start + 64);
    mem.fill(0x10, 0x5800 + 5 * 32, 0x5800 + 6 * 32); // red paper for the whole row
    ula.catchUp(start + 224);
    const row = (BORDER_TOP + line) * WIDTH + BORDER_X;
    expect(ula.frame[row + 8 * 15]).toBe(PALETTE[7]); // read before the change
    expect(ula.frame[row + 8 * 16]).toBe(PALETTE[2]); // read after it
    // The next line of the same cells is all red.
    ula.endFrame();
    expect(ula.frame[row + WIDTH]).toBe(PALETTE[2]);
  });
});

/** Runs one instruction placed at 8000h (uncontended) from T-state `t`; returns its length. */
function timeAt(zx: Spectrum, code: number[], t: number): number {
  zx.mem.set(code, 0x8000);
  zx.cpu.pc = 0x8000;
  zx.cpu.cycles = t;
  zx.cpu.step();
  return zx.cpu.cycles - t;
}

describe('contention', () => {
  it('delays 4000h-7FFFh by 6,5,4,3,2,1,0,0 while the ULA reads the display', () => {
    const c = contentionTable(TIMING_48K);
    expect(Array.from(c.subarray(14_335, 14_343))).toEqual([6, 5, 4, 3, 2, 1, 0, 0]);
    expect(c[14_334]).toBe(0); // the line's display has not started
    expect(c[14_335 + 128]).toBe(0); // right border
    expect(c[14_335 + 224]).toBe(6); // the next line
    expect(c[14_335 + 191 * 224]).toBe(6); // the last display line
    expect(c[14_335 + 192 * 224]).toBe(0); // bottom border
  });

  it('makes LD A,(4000h) wait when its read lands in a busy slot, and only then', () => {
    const zx = boot();
    // LD A,(nn) is 13 T-states: fetch 4, nn 3+3, then the read at +10.
    expect(timeAt(zx, [0x3a, 0x00, 0x40], 14_325)).toBe(13 + 6); // read at 14,335
    expect(timeAt(zx, [0x3a, 0x00, 0x40], 14_329)).toBe(13 + 2); // read at 14,339
    expect(timeAt(zx, [0x3a, 0x00, 0x40], 14_331)).toBe(13); // read at 14,341: the free slot
    expect(timeAt(zx, [0x3a, 0x00, 0x80], 14_325)).toBe(13); // 8000h is never contended
    expect(timeAt(zx, [0x3a, 0x00, 0x40], 1_000)).toBe(13); // top border
  });

  it('contends the ULA\'s port wherever it is, and other ports only in 4000h-7FFFh', () => {
    const zx = boot();
    // OUT (n),A is 11 T-states; the I/O cycle starts at +7.
    zx.cpu.a = 0x07; // port 07FEh: the ULA, high byte not in 40h-7Fh
    expect(timeAt(zx, [0xd3, 0xfe], 14_335 - 8)).toBe(11 + 6); // its contended T-state is +8
    zx.cpu.a = 0x07; // port 07FFh: not the ULA, not in 4000h-7FFFh
    expect(timeAt(zx, [0xd3, 0xff], 14_335 - 8)).toBe(11);
    zx.cpu.a = 0x40; // port 40FFh: contended at every T-state of the cycle
    expect(timeAt(zx, [0xd3, 0xff], 14_335 - 7)).toBeGreaterThan(11 + 6);
  });

  it('follows the TK\'s own frame', () => {
    const c = contentionTable(TIMING_TK60);
    expect(Array.from(c.subarray(8_759, 8_767))).toEqual([6, 5, 4, 3, 2, 1, 0, 0]);
    expect(c[8_759 + 228]).toBe(6);
    expect(c[8_759 + 224]).toBe(0);
  });
});

describe('floating bus', () => {
  it('reads the byte the ULA is fetching, and FFh when it fetches nothing', () => {
    const mem = new Uint8Array(0x10000);
    const ula = new Ula(mem, TIMING_48K);
    mem[0x4000] = 0x11; mem[0x4001] = 0x22; mem[0x5800] = 0x33; mem[0x5801] = 0x44;
    mem[0x4100] = 0x55; // pixel line 1, column 0
    // As FUSE: bitmap 0 at 14,338, its attribute, bitmap 1, its attribute, then idle.
    expect([14_337, 14_338, 14_339, 14_340, 14_341, 14_342].map((t) => ula.floatingBus(t)))
      .toEqual([0xff, 0x11, 0x33, 0x22, 0x44, 0xff]);
    expect(ula.floatingBus(14_338 + 224)).toBe(0x55);
    expect(ula.floatingBus(14_338 + 128)).toBe(0xff); // right border
    expect(ula.floatingBus(5_000)).toBe(0xff); // top border
  });

  it('answers IN from an unattached port, and port 1Fh with no Kempston', () => {
    const zx = boot();
    zx.mem.fill(0x5a, 0x5800, 0x5b00);
    zx.mem.fill(0x00, 0x4000, 0x5800);
    // IN A,(FFh): the core asks at +8; the bus is sampled two T-states later.
    zx.cpu.a = 0;
    timeAt(zx, [0xdb, 0xff], 14_339 - 10);
    expect(zx.cpu.a).toBe(0x5a);
    zx.cpu.a = 0;
    timeAt(zx, [0xdb, 0xff], 14_342 - 10);
    expect(zx.cpu.a).toBe(0xff);
    zx.kempston = 0;
    zx.cpu.a = 0;
    timeAt(zx, [0xdb, 0x1f], 14_339 - 10);
    expect(zx.cpu.a).toBe(0); // Kempston, nothing pressed
    zx.kempstonAttached = false;
    timeAt(zx, [0xdb, 0x1f], 14_339 - 10);
    expect(zx.cpu.a).toBe(0x5a);
  });
});
