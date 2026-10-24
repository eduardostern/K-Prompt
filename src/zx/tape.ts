/**
 * Cassette tapes: `.tap` and `.tzx` images.
 *
 * A Spectrum tape is a series of blocks. Each standard block is a flag byte
 * (00h header, FFh data), the data, and an XOR checksum, recorded by the
 * ROM as a pilot tone, two sync pulses and two pulses per bit. A `.tap`
 * file holds only standard blocks (a 2-byte length before each); a `.tzx`
 * also records turbo loaders, pure tones, raw pulses and pauses.
 *
 * Every block becomes two things:
 *  - its bytes, when it is a standard block the ROM's LD-BYTES can load:
 *    the machine traps LD-BYTES and copies them in at once;
 *  - its pulses (T-states between edges on EAR), for real-time playing:
 *    custom loaders read the signal from port FEh bit 6, and you hear it.
 */

/** ROM timings in T-states. */
export const PILOT = 2168, SYNC1 = 667, SYNC2 = 735, ZERO = 855, ONE = 1710;
export const PILOT_HEADER = 8063, PILOT_DATA = 3223;
const MS = 3500; // T-states per millisecond

export interface Block {
  /** Flag, data and checksum, for blocks LD-BYTES can read straight away. */
  data?: Uint8Array;
  /** Pause after the block, in ms (0 = stop the tape, -1 = none: go straight on). */
  pause: number;
  /** A line for the tape's label (header names, TZX texts). */
  label?: string;
  /** Pulse lengths; built on demand. Negative = silence (EAR low) for that long. */
  pulses(): Int32Array;
}

function pushData(out: number[], data: Uint8Array, zero: number, one: number, lastBits = 8): void {
  for (let i = 0; i < data.length; i++) {
    const bits = i === data.length - 1 ? lastBits : 8;
    for (let b = 0; b < bits; b++) {
      const p = data[i] & (0x80 >> b) ? one : zero;
      out.push(p, p);
    }
  }
}

function pauseOf(out: number[], ms: number): void {
  if (ms > 0) out.push(-ms * MS);
}

/** A standard ROM block (TZX ID 10h, every .tap block). */
export function standardBlock(data: Uint8Array, pause = 1000): Block {
  return {
    data,
    pause,
    label: headerLabel(data),
    pulses() {
      const out: number[] = [];
      const pilot = data[0] < 0x80 ? PILOT_HEADER : PILOT_DATA;
      for (let i = 0; i < pilot; i++) out.push(PILOT);
      out.push(SYNC1, SYNC2);
      pushData(out, data, ZERO, ONE);
      pauseOf(out, pause);
      return Int32Array.from(out);
    },
  };
}

/** "Program: NAME", "Bytes: NAME" for header blocks. */
export function headerLabel(data: Uint8Array): string | undefined {
  if (data.length !== 19 || data[0] !== 0) return undefined;
  const kind = ['Program', 'Number array', 'Character array', 'Bytes'][data[1]] ?? 'Block';
  let name = '';
  for (let i = 2; i < 12; i++) name += String.fromCharCode(data[i] >= 0x20 && data[i] < 0x7f ? data[i] : 0x3f);
  return `${kind}: ${name.trimEnd()}`;
}

/** XOR checksum of flag and data, as the ROM writes it after them. */
export function checksum(bytes: ArrayLike<number>): number {
  let x = 0;
  for (let i = 0; i < bytes.length; i++) x ^= bytes[i];
  return x;
}

export class Tape {
  /** Where the tape is: the next block to read, and the position in its pulses. */
  block = 0;
  private pulse = 0;
  private current: Int32Array | null = null;
  /** EAR level from the tape. */
  level = false;
  /** Absolute T-state of the next edge, while playing. */
  private nextEdge = 0;
  playing = false;
  /** Blocks recorded with SAVE, appended at the end. */
  modified = false;
  /**
   * Machine T-states per tape T-state: tape timings are in T-states of the
   * 48K's 3.5 MHz, so a faster machine (a TK90X at 3.58 MHz) stretches them.
   */
  scale = 1;

  constructor(readonly name: string, readonly blocks: Block[]) {}

  get atEnd(): boolean {
    return this.block >= this.blocks.length;
  }

  rewind(): void {
    this.block = 0;
    this.pulse = 0;
    this.current = null;
    this.playing = false;
    this.level = false;
  }

  /** The next block, if LD-BYTES can take it whole; moves past it. */
  takeStandard(): Uint8Array | null {
    const b = this.blocks[this.block];
    if (!b?.data || this.pulse) return null;
    this.block++;
    this.current = null;
    return b.data;
  }

  /** Whether the next block is one LD-BYTES can take whole. */
  get nextIsStandard(): boolean {
    return Boolean(this.blocks[this.block]?.data) && this.pulse === 0;
  }

  /** Starts playing at absolute T-state `now`. */
  play(now: number): void {
    if (this.atEnd) return;
    this.playing = true;
    this.nextEdge = now;
  }

  stop(): void {
    this.playing = false;
  }

  /**
   * Plays up to absolute T-state `now`; calls `edge(t, level)` for each
   * change of level (for the speaker). Stops at the end of the tape and at
   * blocks that say to stop.
   */
  advance(now: number, edge?: (t: number, level: boolean) => void): void {
    while (this.playing && this.nextEdge <= now) {
      if (!this.current) {
        const b = this.blocks[this.block];
        if (!b) { this.playing = false; this.level = false; return; }
        this.current = b.pulses();
        this.pulse = 0;
      }
      if (this.pulse >= this.current.length) {
        const b = this.blocks[this.block++];
        this.current = null;
        this.pulse = 0;
        if (b.pause === 0 || this.atEnd) { this.playing = false; this.level = false; return; }
        continue;
      }
      const p = this.current[this.pulse++];
      if (p < 0) {
        if (this.level) { this.level = false; edge?.(this.nextEdge, false); }
        this.nextEdge += -p * this.scale;
      } else {
        this.level = !this.level;
        edge?.(this.nextEdge, this.level);
        this.nextEdge += p * this.scale;
      }
    }
  }

  /** Records a block that SAVE wrote (flag, data, checksum). */
  append(data: Uint8Array): void {
    this.blocks.push(standardBlock(data));
    this.modified = true;
    this.block = this.blocks.length;
  }

  /** The tape as a .tap file (standard blocks only). */
  toTap(): Uint8Array {
    const parts: number[] = [];
    for (const b of this.blocks) {
      if (!b.data) continue;
      parts.push(b.data.length & 0xff, b.data.length >> 8, ...b.data);
    }
    return Uint8Array.from(parts);
  }

  /** The labels of the blocks, for the deck. */
  labels(): string[] {
    return this.blocks.map((b) => b.label).filter((l): l is string => Boolean(l));
  }
}

export function parseTap(name: string, bytes: Uint8Array): Tape {
  const blocks: Block[] = [];
  let i = 0;
  while (i + 2 <= bytes.length) {
    const len = bytes[i] | (bytes[i + 1] << 8);
    i += 2;
    if (!len) continue;
    if (i + len > bytes.length) throw new Error('the .tap file ends in the middle of a block');
    blocks.push(standardBlock(bytes.slice(i, i + len)));
    i += len;
  }
  if (!blocks.length) throw new Error('no blocks on this tape');
  return new Tape(name, blocks);
}

const word = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const triple = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const ascii = (b: Uint8Array) => String.fromCharCode(...b).replace(/[^\x20-\x7e]/g, ' ').trim();

/**
 * Reads a .tzx. Blocks 10h–15h (standard, turbo, tone, pulses, pure data,
 * direct recording), 20h (pause/stop), 24h/25h (loops), 2Ah (stop on 48K)
 * play; groups, texts and archive info become labels; others are skipped by
 * their length.
 */
export function parseTzx(name: string, bytes: Uint8Array): Tape {
  if (ascii(bytes.subarray(0, 7)) !== 'ZXTape!' || bytes[7] !== 0x1a) throw new Error('not a TZX file');
  const blocks: Block[] = [];
  let loopStart = -1, loopCount = 0;
  let i = 10;
  const pulsesBlock = (fn: (out: number[]) => void, pause: number, label?: string): Block => ({
    pause, label,
    pulses() { const out: number[] = []; fn(out); pauseOf(out, pause); return Int32Array.from(out); },
  });
  while (i < bytes.length) {
    const id = bytes[i++];
    switch (id) {
      case 0x10: {
        const pause = word(bytes, i), len = word(bytes, i + 2);
        blocks.push(standardBlock(bytes.slice(i + 4, i + 4 + len), pause));
        i += 4 + len;
        break;
      }
      case 0x11: {
        const [pilot, s1, s2, zero, one, count] = [0, 2, 4, 6, 8, 10].map((o) => word(bytes, i + o));
        const lastBits = bytes[i + 12], pause = word(bytes, i + 13), len = triple(bytes, i + 15);
        const data = bytes.slice(i + 18, i + 18 + len);
        blocks.push(pulsesBlock((out) => {
          for (let k = 0; k < count; k++) out.push(pilot);
          out.push(s1, s2);
          pushData(out, data, zero, one, lastBits);
        }, pause, headerLabel(data)));
        i += 18 + len;
        break;
      }
      case 0x12: {
        const len = word(bytes, i), count = word(bytes, i + 2);
        blocks.push(pulsesBlock((out) => { for (let k = 0; k < count; k++) out.push(len); }, -1));
        i += 4;
        break;
      }
      case 0x13: {
        const n = bytes[i];
        const lens = Array.from({ length: n }, (_, k) => word(bytes, i + 1 + 2 * k));
        blocks.push(pulsesBlock((out) => out.push(...lens), -1));
        i += 1 + 2 * n;
        break;
      }
      case 0x14: {
        const zero = word(bytes, i), one = word(bytes, i + 2), lastBits = bytes[i + 4];
        const pause = word(bytes, i + 5), len = triple(bytes, i + 7);
        const data = bytes.slice(i + 10, i + 10 + len);
        blocks.push(pulsesBlock((out) => pushData(out, data, zero, one, lastBits), pause));
        i += 10 + len;
        break;
      }
      case 0x15: {
        const tPerSample = word(bytes, i), pause = word(bytes, i + 2), lastBits = bytes[i + 4];
        const len = triple(bytes, i + 5);
        const data = bytes.slice(i + 8, i + 8 + len);
        blocks.push(pulsesBlock((out) => {
          // Samples are levels: turn runs of equal samples into pulses.
          let level = 1, run = 0;
          for (let k = 0; k < data.length; k++) {
            const bits = k === data.length - 1 ? lastBits : 8;
            for (let b = 0; b < bits; b++) {
              const s = data[k] & (0x80 >> b) ? 1 : 0;
              if (s !== level) { if (run) out.push(run); run = 0; level = s; }
              run += tPerSample;
            }
          }
          if (run) out.push(run);
        }, pause));
        i += 8 + len;
        break;
      }
      case 0x20: {
        const pause = word(bytes, i);
        blocks.push(pulsesBlock(() => {}, pause));
        i += 2;
        break;
      }
      case 0x21: blocks.push(pulsesBlock(() => {}, -1, ascii(bytes.subarray(i + 1, i + 1 + bytes[i])))); i += 1 + bytes[i]; break;
      case 0x22: break;
      case 0x23: i += 2; break;
      case 0x24: loopCount = word(bytes, i); loopStart = blocks.length; i += 2; break;
      case 0x25: {
        if (loopStart >= 0) {
          const body = blocks.slice(loopStart);
          for (let k = 1; k < loopCount; k++) blocks.push(...body);
        }
        loopStart = -1;
        break;
      }
      case 0x26: i += 2 + 2 * word(bytes, i); break;
      case 0x27: break;
      case 0x28: i += 2 + word(bytes, i); break;
      case 0x2a: blocks.push(pulsesBlock(() => {}, 0)); i += 4; break;
      case 0x2b: i += 5; break;
      case 0x30: blocks.push(pulsesBlock(() => {}, -1, ascii(bytes.subarray(i + 1, i + 1 + bytes[i])))); i += 1 + bytes[i]; break;
      case 0x31: i += 2 + bytes[i + 1]; break;
      case 0x32: i += 2 + word(bytes, i); break;
      case 0x33: i += 1 + 3 * bytes[i]; break;
      case 0x35: i += 0x14 + (bytes[i + 0x10] | (bytes[i + 0x11] << 8) | (bytes[i + 0x12] << 16) | (bytes[i + 0x13] << 24)); break;
      case 0x5a: i += 9; break;
      default: {
        // Unknown blocks from TZX 1.10 on carry a 4-byte length.
        const len = bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
        i += 4 + len;
      }
    }
  }
  if (!blocks.length) throw new Error('no blocks on this tape');
  return new Tape(name, blocks);
}

export function parseTape(name: string, bytes: Uint8Array): Tape {
  return /\.tzx$/i.test(name) || ascii(bytes.subarray(0, 7)) === 'ZXTape!' ? parseTzx(name, bytes) : parseTap(name, bytes);
}

/** A blank tape to SAVE onto. */
export function blankTape(): Tape {
  return new Tape('blank.tap', []);
}
