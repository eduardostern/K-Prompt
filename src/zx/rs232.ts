/**
 * The Interface 1's RS232 line, bit by bit in T-states, with the telnet
 * modem on the other end.
 *
 * The Interface 1 has no UART: its ROM times every bit with loops of 26
 * T-states, BAUD of them (the variable at 5CC3h, which FORMAT "b";n sets),
 * so one bit lasts 26 × (BAUD + 2) T-states: 364 at 9600 baud. The lines
 * are inverted at the ports: a 1 on F7h bit 0 (out) or bit 7 (in) is a
 * start bit or a 0, and the line rests at 0.
 *
 * To the Spectrum: the ROM raises CTS when it is ready for a byte and
 * drops it after each one, so a byte is sent only while CTS is up: a start
 * bit, eight data bits from bit 0, then the line rests.
 * From the Spectrum: the ROM waits for DTR (the modem can take a byte),
 * then sends a start bit, eight data bits and two stop bits. They are
 * decoded by sampling the middle of each bit, so any program that keeps
 * to the baud rate works, not only the ROM.
 */

export interface SerialPeer {
  /** A byte is waiting for the Spectrum. */
  available(): boolean;
  /** Takes it. */
  take(): number;
  /** Whether a byte can be sent to it now. */
  ready(): boolean;
  /** A byte from the Spectrum. */
  put(b: number): void;
}

export class Rs232 {
  // To the Spectrum.
  private cts = false;
  /** The frame being sent: its start T-state (-1: none), the byte. */
  private rxStart = -1;
  private rxByte = 0;
  /** No new frame before this T-state (the stop bits). */
  private rxFree = 0;

  // From the Spectrum: the TX level and its changes since the frame began.
  private tx = false;
  private txStart = -1;
  private changes: number[] = [];
  private levels: boolean[] = [];

  /** `bitT()`: T-states per bit now (from BAUD). */
  constructor(private readonly peer: SerialPeer, readonly bitT: () => number) {}

  reset(): void {
    this.cts = this.tx = false;
    this.rxStart = this.txStart = -1;
    this.rxFree = 0;
    this.changes = [];
    this.levels = [];
  }

  /** The Spectrum's CTS (EFh bit 4): a byte may be sent while it is up. */
  setCts(on: boolean, t: number): void {
    this.cts = on;
    if (on) this.startFrame(t);
  }

  private startFrame(t: number): void {
    if (this.rxStart >= 0 || !this.cts || t < this.rxFree || !this.peer.available()) return;
    this.rxStart = t;
    this.rxByte = this.peer.take();
  }

  /** The RX line at T-state `t`, as F7h bit 7 reads it: true for a start bit or a 0. */
  rxLevel(t: number): boolean {
    if (this.rxStart < 0) this.startFrame(t);
    if (this.rxStart < 0) return false;
    const bit = Math.floor((t - this.rxStart) / this.bitT());
    if (bit >= 10) {
      // Done, two stop bits included.
      this.rxStart = -1;
      this.rxFree = t;
      this.startFrame(t);
      return this.rxStart >= 0 ? true : false;
    }
    if (bit === 0) return true;
    if (bit <= 8) return !((this.rxByte >> (bit - 1)) & 1);
    return false;
  }

  /** DTR (EFh bit 3): the modem can take a byte. */
  dtr(t: number): boolean {
    this.flush(t);
    return this.peer.ready();
  }

  /** F7h bit 0, with RS232 selected: true is a start bit or a 0. */
  setTx(level: boolean, t: number): void {
    this.flush(t);
    if (level === this.tx) return;
    this.tx = level;
    if (this.txStart < 0) {
      if (level) { this.txStart = t; this.changes = []; this.levels = []; }
      return;
    }
    this.changes.push(t);
    this.levels.push(level);
  }

  /** The TX line at T-state `t` within the frame being decoded. */
  private txAt(t: number): boolean {
    let level = true; // the start bit
    for (let i = 0; i < this.changes.length && this.changes[i] <= t; i++) level = this.levels[i];
    return level;
  }

  /** Decodes a frame once its last data bit is past. Called on every access and each frame end. */
  flush(t: number): void {
    const bitT = this.bitT();
    // A start bit gone again before its middle was a glitch (the ROM's last
    // OUT before it switches the line off), not a frame.
    while (this.txStart >= 0 && t >= this.txStart + 0.5 * bitT && !this.txAt(this.txStart + 0.5 * bitT)) {
      const i = this.levels.findIndex((l, k) => l && this.changes[k] > this.txStart);
      if (i < 0) { this.txStart = -1; this.changes = []; this.levels = []; break; }
      this.txStart = this.changes[i];
      this.changes = this.changes.slice(i + 1);
      this.levels = this.levels.slice(i + 1);
    }
    while (this.txStart >= 0 && t >= this.txStart + 9.5 * bitT) {
      let b = 0;
      for (let k = 0; k < 8; k++) if (!this.txAt(this.txStart + (k + 1.5) * bitT)) b |= 1 << k;
      this.peer.put(b);
      // A start bit after the stop bits begins the next frame.
      const stop = this.txStart + 9.5 * bitT;
      let next = -1;
      for (let i = 0; i < this.changes.length; i++) {
        if (this.changes[i] > stop && this.levels[i]) { next = i; break; }
      }
      if (next < 0) { this.txStart = -1; this.changes = []; this.levels = []; break; }
      this.txStart = this.changes[next];
      this.changes = this.changes.slice(next + 1);
      this.levels = this.levels.slice(next + 1);
    }
  }
}
