/**
 * A 48K ZX Spectrum, or one of Microdigital's Brazilian clones of it (the
 * TK90X and the TK95): a Z80 at 3.5 MHz, 16K of ROM, 48K of RAM and the
 * ULA, which draws the screen from RAM, reads the keyboard, and drives the
 * beeper and the cassette.
 *
 *   0000h–3FFFh  ROM (writes are ignored)
 *   4000h–57FFh  screen bitmap, 5800h–5AFFh attributes
 *   5B00h–FFFFh  RAM
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
import { Beeper } from './beeper';
import { KEYS, Key, keysFor, Matrix, SS } from './keyboard';
import { Modem } from './modem';
import { checksum, Tape } from './tape';
import { Timing, Ula } from './ula';
import { CF } from '../z80';

export const CPU_CLOCK = 3_500_000;

/** The modem's ports: odd, A5 high (not the ULA, not Kempston), fully decoded. */
export const MODEM_STATUS = 0x01bf;
export const MODEM_DATA = 0x02bf;

export const TIMING_48K: Timing = { lineT: 224, frameT: 69_888, displayStart: 14_336 };

export type Model = '48k' | 'tk90x' | 'tk95';

export interface ModelInfo {
  label: string;
  /** What the machine shows at power-on, for tests and for the history page. */
  banner: string;
  timing: Timing;
}

export const MODELS: Record<Model, ModelInfo> = {
  '48k': { label: 'ZX Spectrum 48K', banner: '© 1982 Sinclair Research Ltd', timing: TIMING_48K },
  tk90x: { label: 'Microdigital TK90X', banner: 'TK90X - Color Computer', timing: TIMING_48K },
  tk95: { label: 'Microdigital TK95', banner: 'TK Color Computer', timing: TIMING_48K },
};

// ROM entry points (the same in the 48K, TK90X and TK95 ROMs).
const SA_BYTES = 0x04c2, SA_LD_RET = 0x053f, LD_BYTES = 0x0556;

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
  model: Model = '48k';
  /** Frames run since power-on. */
  frames = 0;
  /** Kempston joystick: bit 0 right, 1 left, 2 down, 3 up, 4 fire. */
  kempston = 0;
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
  tape: Tape | null = null;
  /**
   * Standard blocks load at once (LD-BYTES is trapped); off, every tape
   * plays in real time, stripes and all.
   */
  fastLoad = true;
  /** Called after SAVE wrote a block onto the tape. */
  onTapeWritten?: (tape: Tape) => void;
  /** T-states from power-on to the start of this frame. */
  private frameBase = 0;

  constructor(rom: Uint8Array, model: Model = '48k', sampleRate = 44100) {
    this.ula = new Ula(this.mem, MODELS[model].timing);
    this.beeper = new Beeper(CPU_CLOCK, sampleRate);
    const cpu = this.cpu;
    cpu.read = (a) => this.mem[a];
    cpu.write = (a, v) => { if (a >= 0x4000) this.mem[a] = v; };
    cpu.portIn = (p) => this.portIn(p);
    cpu.portOut = (p, v) => this.portOut(p, v);
    this.setRom(rom, model);
  }

  /** Puts a ROM in and switches the machine's model (call reset() after). */
  setRom(rom: Uint8Array, model: Model): void {
    if (rom.length !== 0x4000) throw new Error('a Spectrum ROM is 16K');
    this.mem.set(rom, 0);
    this.model = model;
    this.ula.timing = MODELS[model].timing;
    this.reset();
  }

  /** Power cycle: RAM is cleared (the ROM tests and clears it again anyway). */
  reset(): void {
    this.mem.fill(0, 0x4000);
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

  private portIn(port: number): number {
    if (!(port & 1)) {
      // Bit 6 is the EAR input: the tape while it plays; otherwise it follows
      // EAR output, as on issue 3 boards.
      let ear: number;
      if (this.tape?.playing) {
        this.playTape();
        ear = this.tape.level ? 0x40 : 0;
      } else ear = this.lastOut & 0x10 ? 0x40 : 0;
      return 0xa0 | ear | this.matrix.read(port >> 8);
    }
    if (port === MODEM_STATUS) return this.modem.status();
    if (port === MODEM_DATA) return this.modem.read();
    if (!(port & 0x20)) return this.kempston & 0x1f;
    return 0xff;
  }

  private portOut(port: number, v: number): void {
    if (port === MODEM_STATUS) return this.modem.control(v);
    if (port === MODEM_DATA) return this.modem.write(v);
    if (port & 1) return;
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
    const { frameT } = this.ula.timing;
    while (cpu.cycles < frameT) {
      if (cpu.cycles < 32) cpu.interrupt(0xff);
      if (this.tape && (cpu.pc === LD_BYTES || cpu.pc === SA_BYTES)) this.tapeTrap();
      cpu.step();
      this.ula.catchUp(cpu.cycles);
    }
    if (this.tape?.playing) this.playTape(this.frameBase + frameT);
    this.ula.endFrame();
    this.beeper.endFrame(frameT);
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
    if (cpu.pc === SA_BYTES) {
      const block = new Uint8Array(cpu.de + 2);
      block[0] = cpu.a;
      for (let i = 0; i < cpu.de; i++) block[1 + i] = this.mem[(cpu.ix + i) & 0xffff];
      block[block.length - 1] = checksum(block.subarray(0, block.length - 1));
      tape.append(block);
      cpu.ix = (cpu.ix + cpu.de) & 0xffff;
      cpu.de = 0;
      cpu.f |= CF;
      cpu.pc = SA_LD_RET;
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
        else if (addr >= 0x4000) this.mem[addr] = b;
      }
      // The checksum byte follows the data; a block of another length fails.
      ok = ok && n === want && data.length === want + 2 && (parity ^ data[data.length - 1]) === 0;
    }
    cpu.ix = (cpu.ix + n) & 0xffff;
    cpu.de = (cpu.de - n) & 0xffff;
    if (ok) cpu.f |= CF; else cpu.f &= ~CF;
    cpu.pc = SA_LD_RET;
  }

  /** The sound made since the last call. */
  takeAudio(): Float32Array<ArrayBuffer> {
    return this.beeper.take();
  }

  // ---- typing --------------------------------------------------------------

  /**
   * Types keys, one chord at a time, held for a few frames each so the
   * ROM's keyboard scan (every interrupt) sees each press and release.
   */
  pressKeys(...chords: Key[][]): void {
    this.typing.push(...chords);
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
    const glyphs = new Map<string, string>();
    for (let c = 0; c < 96; c++) {
      const g = this.mem.subarray(font + c * 8, font + c * 8 + 8);
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
          cell.push(this.mem[0x4000 | ((py & 0xc0) << 5) | ((py & 7) << 8) | ((py & 0x38) << 2) | col]);
        }
        line += glyphs.get(String(cell)) ?? '·';
      }
      lines.push(line.trimEnd());
    }
    return lines;
  }
}

export { KEYS, SS };
