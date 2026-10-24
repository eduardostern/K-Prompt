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
}

export class Ula {
  /** The picture, WIDTH × HEIGHT. */
  readonly frame = new Uint32Array(WIDTH * HEIGHT);
  border = 7;
  /** Border changes this frame: T-states and colours, in order. */
  private changeT: number[] = [];
  private changeC: number[] = [];
  /** The next picture line to draw (0 = the top of the border). */
  private line = 0;
  /** FLASH phase: swaps every 16 frames. */
  private flashCount = 0;
  flashOn = false;

  constructor(private readonly mem: Uint8Array, public timing: Timing) {}

  /** T-state at which picture line `row` (0 = top of the visible border) is complete. */
  private lineEnd(row: number): number {
    const y = row - BORDER_TOP;
    return this.timing.displayStart + y * this.timing.lineT + (256 + BORDER_X) / 2;
  }

  /** Sets the border at once, for the whole frame (reset, snapshots). */
  setBorderNow(colour: number): void {
    this.border = this.startColour = colour & 7;
    this.changeT.length = this.changeC.length = 0;
  }

  setBorder(t: number, colour: number): void {
    colour &= 7;
    if (colour === this.border) return;
    this.border = colour;
    this.changeT.push(t);
    this.changeC.push(colour);
  }

  /** Draws every line that is complete by T-state `t`. */
  catchUp(t: number): void {
    while (this.line < HEIGHT && t >= this.lineEnd(this.line)) this.drawLine(this.line++);
  }

  /** Finishes the picture and starts the next frame. */
  endFrame(): void {
    this.catchUp(Infinity);
    this.line = 0;
    // The colour in effect carries into the next frame, from its start.
    this.changeT.length = 0;
    this.changeC.length = 0;
    this.startColour = this.border;
    if (++this.flashCount >= 16) {
      this.flashCount = 0;
      this.flashOn = !this.flashOn;
    }
  }

  /** The border colour at the start of this frame. */
  private startColour = 7;
  /** Index into the change list for the line being drawn. */
  private colourAt(t: number, from: { i: number; c: number }): number {
    while (from.i < this.changeT.length && this.changeT[from.i] <= t) from.c = this.changeC[from.i++];
    return from.c;
  }

  private drawLine(row: number): void {
    const { displayStart, lineT } = this.timing;
    const y = row - BORDER_TOP;
    const out = this.frame;
    let o = row * WIDTH;
    const t0 = displayStart + y * lineT;
    // Find the colour in effect at the start of this line.
    const cursor = { i: 0, c: this.startColour };
    const inDisplay = y >= 0 && y < 192;
    for (let x = -BORDER_X; x < 256 + BORDER_X; x += 2) {
      if (inDisplay && x === 0) {
        this.drawDisplay(y, o);
        o += 256;
        x = 254;
        continue;
      }
      const c = PALETTE[this.colourAt(t0 + (x >> 1), cursor)];
      out[o++] = c;
      out[o++] = c;
    }
  }

  private drawDisplay(y: number, o: number): void {
    const mem = this.mem;
    const out = this.frame;
    const bitmap = 0x4000 | ((y & 0xc0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2);
    const attrs = 0x5800 + (y >> 3) * 32;
    for (let col = 0; col < 32; col++) {
      const attr = mem[attrs + col];
      let bits = mem[bitmap + col];
      if (attr & 0x80 && this.flashOn) bits ^= 0xff;
      const bright = attr & 0x40 ? 8 : 0;
      const ink = PALETTE[(attr & 7) | bright];
      const paper = PALETTE[((attr >> 3) & 7) | bright];
      for (let b = 0x80; b; b >>= 1) out[o++] = bits & b ? ink : paper;
    }
  }
}
