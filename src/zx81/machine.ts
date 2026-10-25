/**
 * The Sinclair ZX81 and ZX80, and Microdigital's Brazilian clones (TK85,
 * TK82C; TK80). These machines have no video memory or video chip worth
 * the name: the CPU makes the picture itself.
 *
 * - The display file (D_FILE) is executed at its address + 8000h. A15 is
 *   not decoded, so the fetches read RAM, but the ULA watches every opcode
 *   fetch up there: a byte with bit 6 clear is a character, latched and
 *   replaced on the bus by a NOP. During that fetch's refresh cycle the ULA
 *   reads the character's pattern from the ROM at I·256 + code·8 + the line
 *   counter and shifts it out, 8 pixels in 4 T (inverted if bit 7 is set).
 *   A HALT (76h, bit 6 set) runs as itself and ends the row.
 * - /INT is wired to A6: it is asserted when bit 6 of R, put on the address
 *   bus during refresh, goes low. The ROM loads R so that this happens at
 *   the end of each row; the INT handler steps the line counter and runs
 *   the same row again for its 8 lines.
 * - The ZX81 adds an NMI generator (OUT FEh on, OUT FDh off): one NMI per
 *   207-T line, which in SLOW mode lets the ROM count the border lines and
 *   run BASIC between them. The ZX80 has none: it shows a picture only
 *   while it waits for a key (FAST mode only).
 * - VSYNC: an IN from a port with A0 = 0 (the keyboard) starts it, any OUT
 *   ends it; a long one ends the frame.
 *
 * Sources: MAME (zx.cpp, zx_v.cpp), ZEsarUX (zx8081.c), nocash's zxdocs,
 * the annotated ZX81 and ZX80 ROM listings.
 */
import { Z80 } from '../z80';

export type Zx81Model = 'zx81' | 'tk82c' | 'tk85' | 'zx80' | 'tk80';
export type RomName = 'zx81' | 'tk85' | 'zx80';

export interface Zx81ModelInfo {
  label: string;
  rom: RomName;
  /** ZX80 hardware: no NMI generator, 4K ROM (or the ZX81's in FAST only). */
  zx80: boolean;
  /** Frame rate the machine reports (port FE bit 6): Brazil's PAL-M is 60 Hz. */
  hz: 50 | 60;
  /** RAM it came with, in K (the 16K pack was the usual upgrade). */
  ram: number;
}

export const ZX81_MODELS: Record<Zx81Model, Zx81ModelInfo> = {
  zx81: { label: 'Sinclair ZX81 (1981)', rom: 'zx81', zx80: false, hz: 50, ram: 1 },
  tk82c: { label: 'Microdigital TK82C (1981)', rom: 'zx81', zx80: false, hz: 60, ram: 2 },
  tk85: { label: 'Microdigital TK85 (1983)', rom: 'tk85', zx80: false, hz: 60, ram: 16 },
  zx80: { label: 'Sinclair ZX80 (1980)', rom: 'zx80', zx80: true, hz: 50, ram: 1 },
  tk80: { label: 'Microdigital TK80 (1981)', rom: 'zx80', zx80: true, hz: 60, ram: 1 },
};

export const CLOCK = 3_250_000;
/** T-states per scan line. */
export const LINE_T = 207;
/** The frame buffer: 2 pixels per T across a whole line, up to 320 lines. */
export const FRAME_W = LINE_T * 2;
export const FRAME_H = 320;
/** A VSYNC longer than this (T) is a frame's, not a tape or sound pulse. */
const FRAME_SYNC_T = 1000;
/** Typed keys: frames held, then frames released. */
const HOLD = 4;
const GAP = 6;

/** A program on tape: .p (ZX81, from 4009h) or .o (ZX80, from 4000h). */
export interface TapeFile {
  name: string;
  data: Uint8Array;
}

export class Zx81 {
  readonly cpu = new Z80();
  readonly info: Zx81ModelInfo;
  /** RAM at 4000h; how much of it is fitted. */
  readonly ram = new Uint8Array(0x4000);
  ramSize: number;
  /** Keyboard half-rows (A8–A15), 5 keys each, bit clear = pressed. */
  readonly keys = new Uint8Array(8).fill(0x1f);
  /** The picture being drawn, and the last whole one: 0 paper, 1 ink, 2 no signal. */
  private drawing = new Uint8Array(FRAME_W * FRAME_H);
  readonly screen = new Uint8Array(FRAME_W * FRAME_H);
  /** Frames completed since power-on. */
  frames = 0;
  /** Programs on the tape, read by LOAD; SAVE adds to it. */
  tape: TapeFile[] = [];
  tapePos = 0;
  /** Called with each program SAVEd. */
  onSave?: (file: TapeFile) => void;

  private nmiGen = false;
  private vsync = false;
  private vsyncStart = 0;
  private lastSync = 0;
  private lcntr = 0;
  private lineStart = 0;
  private lineY = 0;
  private intLine = false;
  /** Keys queued to press (typed commands), with frames left for each step. */
  private typing: { row: number; bit: number; shift: boolean }[] = [];
  private typeStep = 0;

  constructor(readonly model: Zx81Model, readonly rom: Uint8Array, ramK = ZX81_MODELS[model].ram) {
    this.info = ZX81_MODELS[model];
    this.ramSize = Math.min(16, ramK) * 1024;
    const cpu = this.cpu;
    cpu.read = (a) => this.read(a);
    cpu.write = (a, v) => this.write(a, v);
    cpu.fetchOp = (a) => this.fetch(a);
    cpu.portIn = (p) => this.portIn(p);
    cpu.portOut = (p, v) => this.portOut(p, v);
    this.powerCycle();
  }

  /** T-states per host frame, at the machine's frame rate. */
  get frameT(): number {
    return Math.round(CLOCK / this.info.hz);
  }

  powerCycle(): void {
    this.ram.fill(0);
    this.reset();
  }

  reset(): void {
    this.cpu.reset();
    this.nmiGen = this.vsync = this.intLine = false;
    this.lcntr = this.lineY = 0;
    this.lineStart = this.vsyncStart = this.lastSync = 0;
    this.drawing.fill(0);
    this.screen.fill(2);
    this.typing = [];
    this.tapePos = 0;
  }

  // ---- memory ----------------------------------------------------------------

  /** The ROM byte at an address in 0000h–3FFFh, as each ROM is wired (and mirrored). */
  private romByte(a: number): number {
    const rom = this.rom;
    if (rom.length === 0x2800) {
      // TK85: the ZX81's 8K, then its own 2K at 2000h (mirrored up to 3FFFh).
      return a < 0x2000 ? rom[a] : rom[0x2000 + (a & 0x7ff)];
    }
    return rom[a & (rom.length - 1)];
  }

  /**
   * Data reads and writes. Nothing answers above 7FFFh (the TK85's ROM
   * looks for RAM up to FEFFh and would find a mirror of its 16K); only
   * opcode fetches see RAM there, with A15 ignored (`fetch`).
   */
  read(addr: number): number {
    if (addr & 0x8000) return 0xff;
    return this.mem(addr);
  }

  write(addr: number, value: number): void {
    const r = addr - 0x4000;
    if (r >= 0 && r < this.ramSize) this.ram[r] = value & 0xff;
  }

  /** ROM or RAM at 0000h–7FFFh. */
  private mem(a: number): number {
    if (a < 0x4000) return this.romByte(a);
    const r = a - 0x4000;
    return r < this.ramSize ? this.ram[r] : 0xff;
  }

  /** An opcode fetch: in the display file (A15 set), characters become NOPs and pixels. */
  private fetch(addr: number): number {
    const v = this.mem(addr & 0x7fff); // A15 is not decoded for fetches
    if (!(addr & 0x8000) || v & 0x40 || this.cpu.halted) return v;
    const cpu = this.cpu;
    let pattern = this.romByte((((cpu.i & 0xfe) << 8) | ((v & 0x3f) << 3) | this.lcntr) & 0x3fff);
    if (v & 0x80) pattern ^= 0xff;
    this.plot(2 * (cpu.cycles - 4 - this.lineStart), pattern);
    return 0x00;
  }

  private plot(x: number, pattern: number): void {
    if (this.lineY >= FRAME_H || x < 0 || x + 8 > FRAME_W) return;
    const at = this.lineY * FRAME_W + x;
    for (let i = 0; i < 8; i++) this.drawing[at + i] = (pattern >> (7 - i)) & 1;
  }

  // ---- ports -------------------------------------------------------------------

  private portIn(port: number): number {
    if (port & 1) return 0xff;
    // The keyboard: it also starts VSYNC (on a ZX81 only while the NMIs are off).
    if (!this.nmiGen) {
      if (!this.vsync) {
        this.vsync = true;
        this.vsyncStart = this.cpu.cycles;
      }
      this.lcntr = 0;
    }
    let v = 0x1f;
    for (let row = 0; row < 8; row++) if (!(port & (0x100 << row))) v &= this.keys[row];
    return v | 0x20 | (this.info.hz === 50 ? 0x40 : 0) | 0x80;
  }

  private portOut(port: number, _value: number): void {
    if (!this.info.zx80) {
      if (!(port & 1)) this.nmiGen = true;
      else if (!(port & 2)) this.nmiGen = false;
    }
    if (this.vsync) {
      this.vsync = false;
      this.lcntr = 0;
      if (this.cpu.cycles - this.vsyncStart > FRAME_SYNC_T) this.endFrame();
    }
  }

  private hsync(): void {
    if (!this.vsync) this.lcntr = (this.lcntr + 1) & 7;
    this.lineY++;
  }

  private endFrame(): void {
    this.screen.set(this.drawing);
    this.drawing.fill(0);
    this.lineY = 0;
    this.lastSync = this.cpu.cycles;
    this.frames++;
  }

  // ---- running -------------------------------------------------------------------

  /** Runs one host frame's worth of T-states. */
  runFrame(): void {
    this.typeNext();
    const cpu = this.cpu;
    const end = cpu.cycles + this.frameT;
    const zx80 = this.info.zx80;
    while (cpu.cycles < end) {
      // The ZX81's line counter runs by itself; each line gives an NMI when on.
      if (!zx80) {
        while (cpu.cycles - this.lineStart >= LINE_T) {
          this.lineStart += LINE_T;
          this.hsync();
          if (this.nmiGen) cpu.nmi();
        }
      }
      // A6 low: the end of a display row. Taking it restarts the line.
      if (this.intLine && cpu.interrupt()) {
        this.lineStart = cpu.cycles;
        this.hsync();
        this.intLine = false;
        continue;
      }
      const pc = cpu.pc;
      if ((pc === 0x0347 || pc === 0x02fc || pc === 0x0206 || pc === 0x01b6) && this.trap(pc)) continue;
      cpu.step();
      this.intLine = !(cpu.r & 0x40);
    }
    // No VSYNC for a while (FAST mode while computing): the TV loses the picture.
    if (cpu.cycles - this.lastSync > 3 * this.frameT && this.screen[0] !== 2) this.screen.fill(2);
    this.rebase(end - this.frameT);
  }

  /** Keeps the counters small. */
  private rebase(by: number): void {
    if (by <= 0) return;
    this.cpu.cycles -= by;
    this.lineStart -= by;
    this.vsyncStart -= by;
    this.lastSync -= by;
  }

  // ---- tape ---------------------------------------------------------------------

  private word(a: number): number {
    return this.read(a) | (this.read(a + 1) << 8);
  }

  /** LOAD and SAVE, done at the ROM's entry: the bytes go straight to or from RAM. */
  private trap(pc: number): boolean {
    const zx80Rom = this.rom.length === 0x1000;
    const cpu = this.cpu;
    const ret = () => {
      if (zx80Rom) {
        cpu.sp = (cpu.sp + 2) & 0xffff; // the routine's POP DE
        cpu.pc = 0x0283;
      } else {
        cpu.pc = 0x0207; // SLOW/FAST, which returns to LOAD's or SAVE's caller
      }
    };
    if (zx80Rom ? pc === 0x0206 : pc === 0x0347) {
      const file = this.nextFile(zx80Rom ? '' : this.tapeName(cpu.de));
      if (!file) return false; // no tape: the ROM listens for one, as on the real machine
      const base = zx80Rom ? 0x4000 : 0x4009;
      file.data.forEach((b, i) => this.write(base + i, b));
      ret();
      return true;
    }
    if (zx80Rom ? pc === 0x01b6 : pc === 0x02fc) {
      const base = zx80Rom ? 0x4000 : 0x4009;
      const end = this.word(zx80Rom ? 0x400a : 0x4014);
      const data = Uint8Array.from({ length: Math.max(0, end - base) }, (_, i) => this.read(base + i));
      const name = zx80Rom ? 'zx80' : this.tapeName(cpu.hl) || 'program';
      const file = { name, data };
      this.tape.push(file);
      this.onSave?.(file);
      ret();
      return true;
    }
    return false;
  }

  /** The name a LOAD or SAVE gave (ZX81 codes, last one with bit 7 set); '' for LOAD "". */
  private tapeName(at: number): string {
    if (at & 0x8000) return '';
    let s = '';
    for (let i = 0; i < 128; i++) {
      const c = this.read(at + i);
      s += zx81Char(c & 0x7f);
      if (c & 0x80) break;
    }
    return s.trim();
  }

  /** The next program on the tape, or the next one with that name. */
  private nextFile(name: string): TapeFile | null {
    for (let i = this.tapePos; i < this.tape.length; i++) {
      if (!name || this.tape[i].name.toUpperCase() === name.toUpperCase()) {
        this.tapePos = i + 1;
        return this.tape[i];
      }
    }
    return null;
  }

  // ---- keys and typing ------------------------------------------------------------

  key(row: number, bit: number, down: boolean): void {
    if (down) this.keys[row] &= ~(1 << bit);
    else this.keys[row] |= 1 << bit;
  }

  /** Presses keys one after another, each held a few frames (SHIFT with it if asked). */
  pressKeys(seq: { row: number; bit: number; shift?: boolean }[]): void {
    this.typing.push(...seq.map((k) => ({ ...k, shift: Boolean(k.shift) })));
  }

  get isTyping(): boolean {
    return this.typing.length > 0;
  }

  private typeNext(): void {
    if (!this.typing.length) return;
    const k = this.typing[0];
    // Hold 4 frames, release 6: the ROM scans once a frame and wants a key up for a while.
    if (this.typeStep === 0) {
      if (k.shift) this.key(0, 0, true);
      this.key(k.row, k.bit, true);
    } else if (this.typeStep === HOLD) {
      this.key(k.row, k.bit, false);
      if (k.shift) this.key(0, 0, false);
    }
    if (++this.typeStep === HOLD + GAP) {
      this.typeStep = 0;
      this.typing.shift();
    }
  }

  /** The text on the screen, from the display file (for tests and the page). */
  screenText(): string {
    const zx80 = this.rom.length === 0x1000;
    let a = this.word(0x400c) & 0x7fff;
    if (a < 0x4000) return '';
    const lines: string[] = [];
    let line = '';
    a++; // the first HALT
    for (let n = 0; n < 33 * 24 + 1 && lines.length < 24; n++, a++) {
      const c = this.read(a);
      if (c === 0x76) {
        lines.push(line.trimEnd());
        line = '';
      } else {
        line += zx80 ? zx80Char(c & 0x7f) : zx81Char(c & 0x7f);
      }
    }
    return lines.join('\n');
  }
}

const ZX81_CHARS = ' ??????????"£$:?()><=+-*/;,.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ZX80_CHARS = ' "??????????£$:?()-+*/=><;,.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A ZX81 character code (0–3Fh) as text; graphics show as '?'. */
export function zx81Char(c: number): string {
  return c < 0x40 ? ZX81_CHARS[c] : '?';
}

export function zx80Char(c: number): string {
  return c < 0x40 ? ZX80_CHARS[c] : '?';
}
