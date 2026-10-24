/**
 * The ULA's picture: 256×192 pixels in the middle of a border, drawn line
 * by line as the frame's T-states pass.
 *
 * Pixel (x, y) of the display is fetched at T = DISPLAY_START + y·224 + x/2
 * from the start of the frame (the interrupt); the same formula, with x and
 * y outside 0–255 and 0–191, gives the time of each border pixel. The border
 * colour is kept as a list of changes with their T-state, so loader stripes
 * and border effects land where they happened on the real screen.
 *
 * Memory layout: the bitmap at 4000h has the y bits split as
 * 0 1 0 y7 y6 y2 y1 y0 | y5 y4 y3 x7 x6 x5 x4 x3, and the attribute of each
 * 8×8 cell is at 5800h + (y/8)·32 + x/8: bit 7 FLASH, bit 6 BRIGHT, bits
 * 5–3 PAPER, bits 2–0 INK. FLASH swaps ink and paper every 16 frames.
 */

/** Border shown around the display, in pixels (the full side border is 48). */
export const BORDER_X = 48;
export const BORDER_TOP = 48;
export const BORDER_BOTTOM = 48;
export const WIDTH = 256 + 2 * BORDER_X;
export const HEIGHT = 192 + BORDER_TOP + BORDER_BOTTOM;

/** Colours as canvas pixels (ABGR in a Uint32Array on little-endian hosts). */
function rgb(r: number, g: number, b: number): number {
  return ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** Normal and BRIGHT palettes: black, blue, red, magenta, green, cyan, yellow, white. */
export const PALETTE: number[] = (() => {
  const out: number[] = [];
  for (const level of [0xd8, 0xff]) {
    for (let c = 0; c < 8; c++) {
      out.push(rgb(c & 2 ? level : 0, c & 4 ? level : 0, c & 1 ? level : 0));
    }
  }
  return out;
})();

export interface Timing {
  /** CPU clock in Hz. */
  clock: number;
  /** T-states per line. */
  lineT: number;
  /** T-states per frame. */
  frameT: number;
  /** T-state of the first display pixel (top left of the 256×192). */
  displayStart: number;
  /** How long the interrupt is held at the start of the frame. */
  intLength: number;
  /**
   * The floating bus: T-states after a display line's start at which the
   * ULA's first fetch (bitmap byte 0) is on the data bus.
   */
  busPhase: number;
}

/** The ULA's wait states, by T-state within each 8 of a display line's 128 (FUSE's and ESPectrum's). */
const DELAYS = [6, 5, 4, 3, 2, 1, 0, 0];

/**
 * Contention: the wait states at every T-state of the frame. While the ULA
 * reads the display (128 T-states of each of the 192 lines) it holds the
 * CPU off contended memory, and an access waits for the ULA's free slot:
 * 6 T-states at the first one, down to none for the last two of each 8.
 * It starts one T-state before the first pixel: 14,335 on the 48K. A few
 * spare entries follow the frame for an instruction that runs past its end.
 */
export function contentionTable(t: Timing): Uint8Array {
  const table = new Uint8Array(t.frameT + 64);
  for (let y = 0; y < 192; y++) {
    const line = t.displayStart - 1 + y * t.lineT;
    for (let x = 0; x < 128; x++) table[line + x] = DELAYS[x & 7];
  }
  return table;
}

/** The picture is drawn in 8-pixel cells: 44 per line (48 + 256 + 48 pixels). */
const CELLS = WIDTH / 8;

export class Ula {
  /** The picture, WIDTH × HEIGHT. */
  readonly frame = new Uint32Array(WIDTH * HEIGHT);
  border = 7;
  /** Border changes this frame: T-states and colours, in order. */
  private changeT: number[] = [];
  private changeC: number[] = [];
  /** The next cell to draw: line × CELLS + cell, from the top left of the border. */
  private next = 0;
  /** T-state by which that cell is complete. */
  private nextT = 0;
  /** Where the border colour lookup has got to this frame. */
  private change = 0;
  private colour = 7;
  /** The border colour at the start of this frame. */
  private startColour = 7;
  /** FLASH phase: swaps every 16 frames. */
  private flashCount = 0;
  flashOn = false;

  constructor(private readonly mem: Uint8Array, public timing: Timing) {
    this.nextT = this.cellEnd(0);
  }

  /**
   * T-state at which cell `n` has been shown: pixel x of line y is shown at
   * displayStart + y·lineT + x/2, so an 8-pixel cell takes 4 T-states. The
   * display's cells are read from memory then, as the ULA reads each cell
   * as the beam reaches it: a program that changes the screen mid-line
   * (multicolour, border effects) is seen exactly where it acts.
   */
  private cellEnd(n: number): number {
    const y = ((n / CELLS) | 0) - BORDER_TOP;
    const x = (n % CELLS) * 8 - BORDER_X;
    return this.timing.displayStart + y * this.timing.lineT + ((x + 8) >> 1);
  }

  /** Sets the border at once, for the whole frame (reset, snapshots). */
  setBorderNow(colour: number): void {
    this.border = this.startColour = this.colour = colour & 7;
    this.changeT.length = this.changeC.length = 0;
    this.change = 0;
  }

  setBorder(t: number, colour: number): void {
    colour &= 7;
    if (colour === this.border) return;
    this.border = colour;
    this.changeT.push(t);
    this.changeC.push(colour);
  }

  /** Draws every cell that has been shown by T-state `t`. */
  catchUp(t: number): void {
    if (t < this.nextT) return;
    const total = CELLS * HEIGHT;
    while (this.next < total && t >= this.nextT) {
      this.drawCell(this.next++);
      this.nextT = this.cellEnd(this.next);
    }
    if (this.next >= total) this.nextT = Infinity;
  }

  /** Finishes the picture and starts the next frame. */
  endFrame(): void {
    this.catchUp(Infinity);
    this.next = 0;
    this.nextT = this.cellEnd(0);
    // The colour in effect carries into the next frame, from its start.
    this.changeT.length = 0;
    this.changeC.length = 0;
    this.change = 0;
    this.startColour = this.colour = this.border;
    if (++this.flashCount >= 16) {
      this.flashCount = 0;
      this.flashOn = !this.flashOn;
    }
  }

  /** The border colour at T-state `t`; times only move forward through a frame. */
  private colourAt(t: number): number {
    while (this.change < this.changeT.length && this.changeT[this.change] <= t) this.colour = this.changeC[this.change++];
    return this.colour;
  }

  private drawCell(n: number): void {
    const row = (n / CELLS) | 0;
    const cell = n % CELLS;
    const y = row - BORDER_TOP;
    const x = cell * 8 - BORDER_X;
    const o = row * WIDTH + cell * 8;
    if (y >= 0 && y < 192 && x >= 0 && x < 256) {
      this.drawDisplay(y, x >> 3, o);
      return;
    }
    const t0 = this.timing.displayStart + y * this.timing.lineT + (x >> 1);
    const out = this.frame;
    for (let p = 0; p < 8; p += 2) {
      const c = PALETTE[this.colourAt(t0 + (p >> 1))];
      out[o + p] = c;
      out[o + p + 1] = c;
    }
  }

  /**
   * The floating bus: what an unattached port reads at T-state `t`. During
   * the display the ULA is fetching, in each 8 T-states, a bitmap byte, its
   * attribute, the next bitmap byte and its attribute, then nothing for 4;
   * that byte is on the data bus. Anywhere else the bus is idle (FFh).
   */
  floatingBus(t: number): number {
    const { displayStart, lineT, busPhase } = this.timing;
    const k = t - displayStart - busPhase;
    if (k < 0) return 0xff;
    const y = (k / lineT) | 0;
    const x = k - y * lineT;
    if (y >= 192 || x >= 128 || (x & 7) > 3) return 0xff;
    const col = (x >> 3) * 2 + ((x >> 1) & 1);
    if (x & 1) return this.mem[0x5800 + (y >> 3) * 32 + col];
    return this.mem[(0x4000 | ((y & 0xc0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2)) + col];
  }

  private drawDisplay(y: number, col: number, o: number): void {
    const mem = this.mem;
    const out = this.frame;
    const attr = mem[0x5800 + (y >> 3) * 32 + col];
    let bits = mem[(0x4000 | ((y & 0xc0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2)) + col];
    if (attr & 0x80 && this.flashOn) bits ^= 0xff;
    const bright = attr & 0x40 ? 8 : 0;
    const ink = PALETTE[(attr & 7) | bright];
    const paper = PALETTE[((attr >> 3) & 7) | bright];
    for (let b = 0x80; b; b >>= 1) out[o++] = bits & b ? ink : paper;
  }
}
