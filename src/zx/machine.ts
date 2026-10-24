/**
 * A 48K ZX Spectrum, one of Microdigital's Brazilian clones of it (the
 * TK90X and the TK95), or a 128K or +2: a Z80 at 3.5 MHz, ROM, RAM and the
 * ULA, which draws the screen from RAM, reads the keyboard, and drives the
 * beeper and the cassette.
 *
 *   0000h–3FFFh  ROM (writes are ignored)
 *   4000h–57FFh  screen bitmap, 5800h–5AFFh attributes
 *   5B00h–FFFFh  RAM
 *
 * The 128K and +2 have 8 RAM banks of 16K and two ROMs (0: the 128 editor,
 * 1: 48 BASIC). Bank 5 is always at 4000h and bank 2 at 8000h; port 7FFDh
 * (A15 and A1 low) picks the bank at C000h (bits 0–2), the screen the ULA
 * shows (bit 3: bank 5 or 7), the ROM (bit 4), and bit 5 locks it all
 * until reset. Odd banks are contended. The AY sound chip is at FFFDh
 * (select, read) and BFFDh (write).
 *
 * The Timex TS2068 replaces the ULA with the SCLD, fully decoded: FEh as
 * the ULA, FFh the screen mode (see ula.ts; bit 6 masks the interrupt,
 * bit 7 picks EXROM over the cartridge dock), F4h maps each 8K chunk of
 * the 64K to the EXROM (an 8K ROM with the tape and cartridge code) or the
 * dock instead of the home ROM and RAM. Its AY is at F5h (select) and F6h
 * (data); register 14 reads the two joysticks. No floating bus, no
 * Kempston.
 *
 * I/O: every even port is the ULA (port FEh). OUT sets the border (bits
 * 0–2), MIC (bit 3) and EAR/beeper (bit 4); IN reads the keyboard half-rows
 * picked by the high address byte (bits 0–4) and EAR input (bit 6). Port
 * 1Fh (address bit 5 low) is the Kempston joystick. The telnet modem sits
 * on two fully decoded ports: 01BFh status (bit 0 byte ready, bit 1 can
 * send, bit 7 carrier; OUT bit 0 is DTR) and 02BFh data, so BASIC can use
 * it with IN 447, IN 703 and OUT 703,x. Other ports read FFh.
 *
 * The frame (69,888 T-states, 50.08 Hz) starts with the ULA's interrupt,
 * which is held for 32 T-states: a CPU with interrupts disabled for that
 * whole window misses it. The data bus reads FFh, so IM 2 jumps through
 * (I·256 + FFh).
 */
import { Z80 } from '../z80';
import { Ay } from './ay';
import { Beeper } from './beeper';
import { KEYS, Key, keysFor, Matrix, SS } from './keyboard';
import { Modem } from './modem';
import { checksum, Tape } from './tape';
import { contentionTable, Timing, Ula } from './ula';
import { CF } from '../z80';

export const CPU_CLOCK = 3_500_000;

/** The modem's ports: odd, A5 high (not the ULA, not Kempston), fully decoded. */
export const MODEM_STATUS = 0x01bf;
export const MODEM_DATA = 0x02bf;

/** Sinclair's ULA (Ferranti): 224 T × 312 lines at 3.5 MHz, 50.08 Hz. */
export const TIMING_48K: Timing = { clock: CPU_CLOCK, lineT: 224, frameT: 69_888, displayStart: 14_336, intLength: 32, busPhase: 2 };

/**
 * Microdigital's own ULA in the TK90X and TK95: a 14.318 MHz crystal (four
 * times the PAL-M/NTSC colour subcarrier) gives 3.575611 MHz, and every line
 * is 228 T. Brazil's PAL-M television is 60 Hz: 262 lines, 59.86 Hz. Pin 1
 * of the ULA selects 50 Hz, 312 lines, a common owner's modification.
 * Measured on a real TK90X by the Cantinho do TK90X blog (2012-13); the
 * paper's start after the interrupt, the floating bus (one T-state later
 * in the ULA's fetch cycle than Ferranti's) and the contention (Ferranti's
 * pattern from the first pixel) are ESPectrum's.
 */
export const TK_CLOCK = 3_575_611;
export const TIMING_TK60: Timing = { clock: TK_CLOCK, lineT: 228, frameT: 228 * 262, displayStart: 8_760, intLength: 32, busPhase: 3 };
export const TIMING_TK50: Timing = { clock: TK_CLOCK, lineT: 228, frameT: 228 * 312, displayStart: 14_688, intLength: 32, busPhase: 3 };

/**
 * The 128K and +2 (Ferranti's 7C ULA): 3.5469 MHz, 228 T × 311 lines, the
 * interrupt held for 36 T-states, the first pixel at 14,362 (FUSE's).
 */
export const TIMING_128K: Timing = { clock: 3_546_900, lineT: 228, frameT: 70_908, displayStart: 14_362, intLength: 36, busPhase: 2 };

/** The TS2068 (Timex's SCLD, NTSC): 3.528 MHz, 224 T × 262 lines, the first pixel at 9,169 (FUSE's). */
export const TIMING_TS2068: Timing = { clock: 3_528_000, lineT: 224, frameT: 224 * 262, displayStart: 9_169, intLength: 32, busPhase: 2 };

export type Model = '48k' | 'tk90x' | 'tk95' | '128k' | 'plus2' | 'ts2068';

/** Which ULA a TK has: Microdigital's at 60 or 50 Hz, or a Ferranti one (some export boards). */
export type TkVideo = '60' | '50' | 'ferranti';

export const TK_VIDEO: Record<TkVideo, { label: string; timing: Timing }> = {
  60: { label: 'PAL-M, 60 Hz (Brazil)', timing: TIMING_TK60 },
  50: { label: '50 Hz (pin 1 switched)', timing: TIMING_TK50 },
  ferranti: { label: 'Ferranti ULA, as a 48K', timing: TIMING_48K },
};

export interface ModelInfo {
  label: string;
  /** What the machine shows at power-on, for tests and for the history page. */
  banner: string;
  tk: boolean;
  /** 128K memory (banks, two ROMs) and the AY. */
  paged?: boolean;
  /** Timex's SCLD: screen modes, EXROM, its own ports and AY. */
  timex?: boolean;
}

export const MODELS: Record<Model, ModelInfo> = {
  '48k': { label: 'ZX Spectrum 48K', banner: '© 1982 Sinclair Research Ltd', tk: false },
  tk90x: { label: 'Microdigital TK90X', banner: 'TK90X - Color Computer', tk: true },
  tk95: { label: 'Microdigital TK95', banner: 'TK Color Computer', tk: true },
  '128k': { label: 'ZX Spectrum 128K', banner: '© 1986 Sinclair Research Ltd', tk: false, paged: true },
  plus2: { label: 'ZX Spectrum +2', banner: '©1986, ©1982 Amstrad Consumer', tk: false, paged: true },
  ts2068: { label: 'Timex Sinclair 2068', banner: '© 1983 Timex Computer Cor', tk: false, timex: true },
};

/** Where each model's ROM keeps SA-BYTES, SA/LD-RET and LD-BYTES (the TS2068's are in its EXROM). */
const TAPE_ENTRIES = { spectrum: [0x04c2, 0x053f, 0x0556], timex: [0x0068, 0x00e5, 0x00fc] };

/** The ROM file's size for a model: 16K, both of a 128K's, or a TS2068's 16K and 8K EXROM. */
export function romSize(model: Model): number {
  return MODELS[model].paged ? 0x8000 : MODELS[model].timex ? 0x6000 : 0x4000;
}

/** The timing of a model, with a TK's choice of ULA. */
export function timingOf(model: Model, tkVideo: TkVideo = '60'): Timing {
  if (MODELS[model].paged) return TIMING_128K;
  if (MODELS[model].timex) return TIMING_TS2068;
  return MODELS[model].tk ? TK_VIDEO[tkVideo].timing : TIMING_48K;
}


/**
 * How long a typed key is held, and the gap after it, in frames. The ROM
 * takes a key pressed again within five interrupts of its release as the
 * same press, so the same key twice needs a longer gap.
 */
const KEY_HOLD = 3;
const KEY_GAP = 3;
const KEY_GAP_REPEAT = 7;

export class Spectrum {
  readonly cpu = new Z80();
  /** The whole 64K address space; 0000h–3FFFh holds the ROM. */
  readonly mem = new Uint8Array(0x10000);
  readonly matrix = new Matrix();
  readonly ula: Ula;
  readonly beeper: Beeper;
  /** The AY (128K and +2; on a 48K only with `ay48`). */
  ay: Ay;
  /** A 48K with an AY interface at the 128K's ports (as many add-ons offered). */
  ay48 = false;
  /** The ROMs, 16K each: one, or the 128K's editor and 48 BASIC. */
  private roms: Uint8Array[] = [];
  /** 128K RAM banks not currently at 4000h, 8000h or C000h (those live in `mem`). */
  private readonly banks = Array.from({ length: 8 }, () => new Uint8Array(0x4000));
  /** Port 7FFDh's last value, the bank at C000h and the ROM paged in. */
  port7ffd = 0;
  private bankC = 0;
  private romSel = 0;
  /**
   * When bank 5 or 2 is also at C000h, the distance from there to its fixed
   * place (8000h or 4000h), so a write to either copy reaches both.
   */
  private alias = 0;
  /** 8K chunks of the 64K the CPU may not write (ROM, or the TS2068's EXROM or dock). */
  private readonly readOnly = Uint8Array.from([1, 1, 0, 0, 0, 0, 0, 0]);
  /** TS2068: the EXROM, the SCLD's registers, and what each chunk holds now (0 home, 1 EXROM, 2 dock). */
  private exrom = new Uint8Array(0x2000);
  private readonly dock = new Uint8Array(0x2000).fill(0xff);
  hsr = 0;
  dec = 0;
  private readonly chunkMap = new Uint8Array(8);
  /** Home RAM put aside while the EXROM or the dock covers its chunk. */
  private readonly homeChunks = Array.from({ length: 8 }, () => new Uint8Array(0x2000));
  /** The tape routines' addresses in this model's ROM. */
  private saBytes = 0x04c2;
  private saLdRet = 0x053f;
  private ldBytes = 0x0556;
  model: Model = '48k';
  /** The ULA of a TK model (ignored for the 48K). */
  tkVideo: TkVideo = '60';
  /** Frames run since power-on. */
  frames = 0;
  /** Kempston joystick: bit 0 right, 1 left, 2 down, 3 up, 4 fire. */
  kempston = 0;
  /** Whether a Kempston interface is plugged in; without it port 1Fh is the floating bus. */
  kempstonAttached = true;
  /** Port FEh's last output. */
  private lastOut = 0;
  /** Keys being typed: one chord per entry, pressed then released. */
  private typing: Key[][] = [];
  private typeFrame = 0;
  /** Keys held by the host (the PC keyboard), kept while typing runs. */
  hostKeys: Key[] = [];
  /** The telnet modem (ports 01BFh and 02BFh). */
  readonly modem = new Modem();
  /** The cassette in the deck. */
  private deck: Tape | null = null;
  get tape(): Tape | null {
    return this.deck;
  }
  set tape(t: Tape | null) {
    this.deck = t;
    if (t) t.scale = this.ula.timing.clock / CPU_CLOCK;
  }
  /**
   * Standard blocks load at once (LD-BYTES is trapped); off, every tape
   * plays in real time, stripes and all.
   */
  fastLoad = true;
  /** Called after SAVE wrote a block onto the tape. */
  onTapeWritten?: (tape: Tape) => void;
  /** T-states from power-on to the start of this frame. */
  private frameBase = 0;

  constructor(rom: Uint8Array, model: Model = '48k', sampleRate = 44100, tkVideo: TkVideo = '60') {
    this.tkVideo = tkVideo;
    this.ula = new Ula(this.mem, timingOf(model, tkVideo));
    this.beeper = new Beeper(CPU_CLOCK, sampleRate);
    this.ay = new Ay(CPU_CLOCK, sampleRate);
    const cpu = this.cpu;
    cpu.read = (a) => this.mem[a];
    cpu.write = (a, v) => {
      if (this.readOnly[a >> 13]) return;
      this.mem[a] = v;
      if (this.alias) {
        if (a >= 0xc000) this.mem[a - this.alias] = v;
        else if (a >= 0xc000 - this.alias && a < 0x10000 - this.alias) this.mem[a + this.alias] = v;
      }
    };
    cpu.portIn = (p) => this.portIn(p);
    cpu.portOut = (p, v) => this.portOut(p, v);
    this.setRom(rom, model);
  }

  /** Puts a ROM in (16K, or 32K for a 128K's two) and switches the machine's model; resets. */
  setRom(rom: Uint8Array, model: Model): void {
    const want = romSize(model);
    if (rom.length !== want) throw new Error(`the ${MODELS[model].label} ROM is ${want / 1024}K`);
    this.roms = [];
    const timex = Boolean(MODELS[model].timex);
    for (let i = 0; i < (timex ? 0x4000 : rom.length); i += 0x4000) this.roms.push(rom.slice(i, i + 0x4000));
    if (timex) this.exrom = rom.slice(0x4000, 0x6000);
    [this.saBytes, this.saLdRet, this.ldBytes] = TAPE_ENTRIES[timex ? 'timex' : 'spectrum'];
    this.cpu.ulaPort = timex
      ? (port) => { const lo = port & 0xff; return lo === 0xfe || lo === 0xff || lo === 0xf4; }
      : (port) => !(port & 1);
    this.ula.setScale(timex ? 2 : 1);
    this.model = model;
    this.applyTiming();
    this.reset();
  }

  /** The TK's ULA: 60 Hz, 50 Hz or Ferranti. Takes effect at once. */
  setTkVideo(v: TkVideo): void {
    this.tkVideo = v;
    this.applyTiming();
  }

  get timing(): Timing {
    return this.ula.timing;
  }

  /** Whether this model has the 128K's memory, ROMs and AY. */
  get paged(): boolean {
    return Boolean(MODELS[this.model].paged);
  }

  /** Whether this is a Timex (the SCLD). */
  get timex(): boolean {
    return Boolean(MODELS[this.model].timex);
  }

  private get ayOn(): boolean {
    return this.paged || this.ay48 || this.timex;
  }

  private applyTiming(): void {
    const t = timingOf(this.model, this.tkVideo);
    this.ula.timing = t;
    if (this.ay.cpuClock !== t.clock) this.ay = new Ay(t.clock, this.ay.sampleRate);
    // The ULA contends 4000h-7FFFh.
    this.cpu.contention = contentionTable(t);
    this.cpu.contendedPage.set([0, 1, 0, 0]);
    this.beeper.clock = t.clock;
    if (this.tape) this.tape.scale = t.clock / CPU_CLOCK;
    // Keep the CPU inside the (possibly shorter) frame.
    if (this.cpu.cycles >= t.frameT) this.cpu.cycles = 0;
  }

  /** Power cycle: RAM is cleared (the ROM tests and clears it again anyway). */
  reset(): void {
    this.mem.fill(0, 0x4000);
    for (const b of this.banks) b.fill(0);
    this.port7ffd = this.bankC = this.romSel = this.alias = 0;
    this.mem.set(this.roms[0], 0);
    this.hsr = this.dec = this.ula.dec = 0;
    this.chunkMap.fill(0);
    this.readOnly.set([1, 1, 0, 0, 0, 0, 0, 0]);
    this.cpu.contendedPage.set([0, 1, 0, 0]);
    this.ula.screen = this.mem.subarray(0x4000, 0x8000);
    this.ay.reset();
    this.cpu.reset();
    this.cpu.cycles = 0;
    this.frames = 0;
    this.frameBase = 0;
    this.typing = [];
    this.tape?.stop();
    this.setBorder(7);
  }

  /** Sets the border colour at once (snapshots, reset). */
  setBorder(colour: number): void {
    this.ula.setBorderNow(colour);
    this.lastOut = colour & 7;
  }

  // ---- 128K memory ----------------------------------------------------------

  /** Port 7FFDh: the bank at C000h, the screen, the ROM, and the lock. */
  private page(v: number): void {
    if (this.port7ffd & 0x20) return;
    // The ULA draws what it has passed from the screen as it was.
    this.ula.catchUp(this.cpu.cycles);
    this.port7ffd = v & 0xff;
    const bank = v & 7;
    if (bank !== this.bankC) {
      if (this.bankC !== 5 && this.bankC !== 2) this.banks[this.bankC].set(this.mem.subarray(0xc000));
      this.bankC = bank;
      if (bank === 5) this.mem.copyWithin(0xc000, 0x4000, 0x8000);
      else if (bank === 2) this.mem.copyWithin(0xc000, 0x8000, 0xc000);
      else this.mem.set(this.banks[bank], 0xc000);
      this.alias = bank === 5 ? 0x8000 : bank === 2 ? 0x4000 : 0;
      this.cpu.contendedPage[3] = bank & 1;
    }
    const rom = (v >> 4) & 1;
    if (rom !== this.romSel) {
      this.romSel = rom;
      this.mem.set(this.roms[rom], 0);
    }
    this.ula.screen = this.bank(v & 8 ? 7 : 5);
  }

  /** RAM bank `n` as it is now (a view into `mem` when it is mapped). */
  bank(n: number): Uint8Array {
    if (n === 5) return this.mem.subarray(0x4000, 0x8000);
    if (n === 2) return this.mem.subarray(0x8000, 0xc000);
    if (n === this.bankC) return this.mem.subarray(0xc000);
    return this.banks[n];
  }

  /** Writes port 7FFDh as a program would (snapshots); unlocks first. */
  setPaging(v: number): void {
    this.port7ffd = 0;
    this.page(v);
  }

  /** Whether the ROM with the tape routines is at 0000h: 48 BASIC, or the TS2068's EXROM. */
  private get basicRom(): boolean {
    if (this.timex) return this.chunkMap[0] === 1;
    return this.romSel === this.roms.length - 1;
  }

  // ---- the TS2068's SCLD ----------------------------------------------------

  /** Maps each 8K chunk to home, the EXROM or the dock, as HSR (F4h) and DEC bit 7 say. */
  private mapChunks(): void {
    for (let i = 0; i < 8; i++) {
      const want = this.hsr & (1 << i) ? (this.dec & 0x80 ? 1 : 2) : 0;
      const had = this.chunkMap[i];
      if (want === had) continue;
      const at = i * 0x2000;
      if (had === 0 && i >= 2) this.homeChunks[i].set(this.mem.subarray(at, at + 0x2000));
      if (want === 0) {
        if (i < 2) this.mem.set(this.roms[0].subarray(at, at + 0x2000), at);
        else this.mem.set(this.homeChunks[i], at);
      } else this.mem.set(want === 1 ? this.exrom : this.dock, at);
      this.chunkMap[i] = want;
      this.readOnly[i] = want !== 0 || i < 2 ? 1 : 0;
    }
  }

  /** Sets the SCLD's two registers (snapshots). */
  setScld(hsr: number, dec: number): void {
    this.hsr = hsr & 0xff;
    this.setDec(dec);
  }

  /** Port FFh: the screen mode (drawn from now on), the interrupt mask, EXROM or dock. */
  private setDec(v: number): void {
    this.ula.catchUp(this.cpu.cycles);
    this.dec = this.ula.dec = v & 0xff;
    this.mapChunks();
  }

  /** The TS2068's joysticks through AY port A (F6h with R14): active low, stick 1 when A8 is set. */
  private timexSticks(port: number): number {
    let v = this.ay.regs[7] & 0x40 ? this.ay.regs[14] : 0xff;
    if (port & 0x100) {
      const k = this.kempston;
      v &= ~((k & 8 ? 0x01 : 0) | (k & 4 ? 0x02 : 0) | (k & 2 ? 0x04 : 0) | (k & 1 ? 0x08 : 0) | (k & 0x10 ? 0x80 : 0));
    }
    return v & 0xff;
  }

  private timexIn(port: number): number {
    const lo = port & 0xff;
    if (lo === 0xfe) return this.ulaIn(port);
    if (port === MODEM_STATUS) return this.modem.status();
    if (port === MODEM_DATA) return this.modem.read();
    if (lo === 0xff) return this.dec;
    if (lo === 0xf4) return this.hsr;
    if (lo === 0xf5) return this.ay.selectedRegister === 14 ? 0xff : this.ay.read();
    if (lo === 0xf6) return this.ay.selectedRegister === 14 ? this.timexSticks(port) : this.ay.read();
    return 0xff;
  }

  /** Writes a byte as the CPU would (both copies of an aliased bank). */
  poke(a: number, v: number): void {
    this.cpu.write(a & 0xffff, v & 0xff);
  }

  private portIn(port: number): number {
    const v = this.readPort(port);
    // On a 128K, reading a port that 7FFDh's decoding sees writes the byte
    // on the bus there too (a quirk of the real machine, as FUSE has it).
    if (this.paged && !(port & 0x8002)) this.page(v);
    return v;
  }

  /** Port FEh: the keyboard half-rows the high byte picks, and EAR. */
  private ulaIn(port: number): number {
    // Bit 6 is the EAR input: the tape while it plays; otherwise it follows
    // EAR output, as on issue 3 boards.
    let ear: number;
    if (this.tape?.playing) {
      this.playTape();
      ear = this.tape.level ? 0x40 : 0;
    } else ear = this.lastOut & 0x10 ? 0x40 : 0;
    return 0xa0 | ear | this.matrix.read(port >> 8);
  }

  private readPort(port: number): number {
    if (this.timex) return this.timexIn(port);
    if (!(port & 1)) return this.ulaIn(port);
    if (port === MODEM_STATUS) return this.modem.status();
    if (port === MODEM_DATA) return this.modem.read();
    if (this.ayOn && (port & 0xc002) === 0xc000) return this.ay.read();
    if (!(port & 0x20) && this.kempstonAttached) return this.kempston & 0x1f;
    return this.ula.floatingBus(this.busReadT(port));
  }

  /**
   * When the data bus is sampled: the core calls portIn one T-state into
   * the I/O cycle; the byte is read two T-states later, after any
   * contention of a port in 4000h-7FFFh (as FUSE times it).
   */
  private busReadT(port: number): number {
    const c = this.cpu.contention!;
    let t = this.cpu.cycles;
    if (this.cpu.contendedPage[port >> 14]) {
      for (let k = 0; k < 2; k++) t += (c[t] | 0) + 1;
      return t + (c[t] | 0);
    }
    return t + 2;
  }

  private portOut(port: number, v: number): void {
    if (port === MODEM_STATUS) return this.modem.control(v);
    if (port === MODEM_DATA) return this.modem.write(v);
    if (this.timex) {
      const lo = port & 0xff;
      if (lo === 0xff) return this.setDec(v);
      if (lo === 0xf4) { this.hsr = v & 0xff; this.mapChunks(); return; }
      if (lo === 0xf5) return this.ay.select(v);
      if (lo === 0xf6) return this.ay.write(v, this.cpu.cycles);
      if (lo !== 0xfe) return;
    } else {
      if (this.paged && !(port & 0x8002)) this.page(v);
      if (this.ayOn && (port & 0x8002) === 0x8000) {
        if (port & 0x4000) this.ay.select(v);
        else this.ay.write(v, this.cpu.cycles);
      }
      if (port & 1) return;
    }
    const t = this.cpu.cycles;
    if (this.tape?.playing) this.playTape(); // keep the speaker's events in order
    this.ula.catchUp(t);
    this.ula.setBorder(t, v & 7);
    this.beeper.setOutput(t, (v & 0x10) !== 0, (v & 0x08) !== 0);
    this.lastOut = v;
  }

  /** Runs one frame: the interrupt, then 69,888 T-states of program. */
  runFrame(): void {
    this.stepTyping();
    const cpu = this.cpu;
    const { frameT, intLength } = this.ula.timing;
    while (cpu.cycles < frameT) {
      if (cpu.cycles < intLength && !(this.dec & 0x40)) cpu.interrupt(0xff);
      if (this.tape && (cpu.pc === this.ldBytes || cpu.pc === this.saBytes) && this.basicRom) this.tapeTrap();
      cpu.step();
      this.ula.catchUp(cpu.cycles);
    }
    if (this.tape?.playing) this.playTape(this.frameBase + frameT);
    this.ula.endFrame();
    this.beeper.endFrame(frameT);
    if (this.ayOn) {
      this.ay.advanceTo(frameT);
      this.ay.rebase(frameT);
    }
    cpu.cycles -= frameT;
    this.frameBase += frameT;
    this.frames++;
  }

  /** Whether the tape is turning (playing in real time). */
  get tapePlaying(): boolean {
    return Boolean(this.tape?.playing);
  }

  // ---- the cassette --------------------------------------------------------

  private playTape(now = this.frameBase + this.cpu.cycles): void {
    this.tape!.advance(now, (t, level) => this.beeper.setTape(t - this.frameBase, level));
  }

  /** Starts the tape playing in real time (the PLAY key). */
  playTapeNow(): void {
    this.tape?.play(this.frameBase + this.cpu.cycles);
  }

  /**
   * The ROM is at LD-BYTES or SA-BYTES. LD-BYTES: A is the flag byte
   * wanted, carry set for LOAD (clear for VERIFY), IX the address, DE the
   * length. A standard block is copied in at once; anything else (a turbo
   * block, or fast loading off) starts the tape so the ROM reads it.
   * SA-BYTES: the same registers; the block goes onto the tape.
   * Both leave through SA/LD-RET, which restores the border and enables
   * interrupts, as the ROM does.
   */
  private tapeTrap(): void {
    const cpu = this.cpu;
    const tape = this.tape!;
    if (cpu.pc === this.saBytes) {
      const block = new Uint8Array(cpu.de + 2);
      block[0] = cpu.a;
      for (let i = 0; i < cpu.de; i++) block[1 + i] = this.mem[(cpu.ix + i) & 0xffff];
      block[block.length - 1] = checksum(block.subarray(0, block.length - 1));
      tape.append(block);
      cpu.ix = (cpu.ix + cpu.de) & 0xffff;
      cpu.de = 0;
      cpu.f |= CF;
      cpu.pc = this.saLdRet;
      this.onTapeWritten?.(tape);
      return;
    }
    if (tape.playing) return;
    if (!this.fastLoad || !tape.nextIsStandard) {
      if (!tape.atEnd) this.playTapeNow();
      return;
    }
    const data = tape.takeStandard()!;
    const verify = !(cpu.f & CF);
    let ok = data[0] === cpu.a;
    let n = 0;
    if (ok) {
      const want = cpu.de;
      let parity = data[0];
      for (; n < want && 1 + n < data.length - 1; n++) {
        const b = data[1 + n];
        parity ^= b;
        const addr = (cpu.ix + n) & 0xffff;
        if (verify) { if (this.mem[addr] !== b) { ok = false; break; } }
        else this.poke(addr, b);
      }
      // The checksum byte follows the data; a block of another length fails.
      ok = ok && n === want && data.length === want + 2 && (parity ^ data[data.length - 1]) === 0;
    }
    cpu.ix = (cpu.ix + n) & 0xffff;
    cpu.de = (cpu.de - n) & 0xffff;
    if (ok) cpu.f |= CF; else cpu.f &= ~CF;
    cpu.pc = this.saLdRet;
  }

  /** The sound made since the last call. */
  takeAudio(): Float32Array<ArrayBuffer> {
    const out = this.beeper.take();
    if (!this.ayOn) return out;
    // Both render the same stretch of time; their counts can differ by a sample.
    const ay = this.ay.take();
    const last = ay.length ? ay[ay.length - 1] : 0;
    // The AY's three channels at full volume make 0.6; the beeper is quieter beside it, as on a 128K.
    for (let i = 0; i < out.length; i++) out[i] = out[i] * 0.5 + (i < ay.length ? ay[i] : last);
    return out;
  }

  // ---- typing --------------------------------------------------------------

  /**
   * Types keys, one chord at a time, held for a few frames each so the
   * ROM's keyboard scan (every interrupt) sees each press and release.
   */
  pressKeys(...chords: Key[][]): void {
    this.typing.push(...chords);
  }

  /**
   * Starts the tape in the deck from a fresh reset, as a person would: on a
   * 48K or TK, LOAD "" (J, then SYMBOL SHIFT + P twice, ENTER) once the
   * ROM's memory test is done; on a 128K or +2, ENTER on the boot menu's
   * first item, Tape Loader.
   */
  typeLoad(): void {
    const wait = this.paged ? 12 : 24; // chords of nothing, 6 frames each
    for (let i = 0; i < wait; i++) this.pressKeys([]);
    if (this.paged) this.pressKeys([KEYS.ENTER]);
    else this.pressKeys([KEYS.J], [SS, KEYS.P], [SS, KEYS.P], [KEYS.ENTER]);
  }

  /** Types text letter by letter (in L mode; keywords are typed by their key in K mode). */
  typeText(text: string): void {
    for (const ch of text) {
      const k = keysFor(ch);
      if (k) this.typing.push(k);
    }
  }

  /** Whether typed keys are still waiting. */
  get busyTyping(): boolean {
    return this.typing.length > 0;
  }

  private stepTyping(): void {
    if (!this.typing.length) {
      this.matrix.set(this.hostKeys);
      return;
    }
    const f = this.typeFrame++;
    if (f < KEY_HOLD) this.matrix.set([...this.hostKeys, ...this.typing[0]]);
    else this.matrix.set(this.hostKeys);
    const next = this.typing[1];
    const same = next && next.some((k) => this.typing[0].includes(k));
    if (f >= KEY_HOLD + (same ? KEY_GAP_REPEAT : KEY_GAP) - 1) {
      this.typing.shift();
      this.typeFrame = 0;
    }
  }

  // ---- reading the screen (tests, accessibility) ---------------------------

  /**
   * The text on the screen, 24 lines of 32, by matching every 8×8 cell
   * against the ROM's character set (at 3D00h, pointed to by CHARS); inverse
   * cells (the cursor) match too. Unknown cells read as '·'.
   */
  screenText(): string[] {
    // CHARS holds the font address minus 256; it is 0 until the ROM sets it up.
    const chars = this.mem[0x5c36] | (this.mem[0x5c37] << 8);
    const font = chars ? (chars + 0x100) & 0xffff : 0x3d00;
    // A font in ROM is 48 BASIC's, whichever ROM is paged in now.
    const fontMem = font < 0x4000 ? this.roms[this.roms.length - 1] : this.mem;
    const screen = this.ula.screen;
    const glyphs = new Map<string, string>();
    for (let c = 0; c < 96; c++) {
      const g = fontMem.subarray(font + c * 8, font + c * 8 + 8);
      const ch = c === 0x60 - 0x20 ? '£' : c === 0x7f - 0x20 ? '©' : String.fromCharCode(c + 0x20);
      glyphs.set(String(Array.from(g)), ch);
      glyphs.set(String(Array.from(g, (b) => b ^ 0xff)), ch);
    }
    const lines: string[] = [];
    for (let row = 0; row < 24; row++) {
      let line = '';
      for (let col = 0; col < 32; col++) {
        const cell: number[] = [];
        for (let y = 0; y < 8; y++) {
          const py = row * 8 + y;
          cell.push(screen[((py & 0xc0) << 5) | ((py & 7) << 8) | ((py & 0x38) << 2) | col]);
        }
        line += glyphs.get(String(cell)) ?? '·';
      }
      lines.push(line.trimEnd());
    }
    return lines;
  }
}

export { KEYS, SS };
