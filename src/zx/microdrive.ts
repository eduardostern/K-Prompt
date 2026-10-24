/**
 * ZX Microdrive cartridges: a loop of tape holding up to 254 blocks, each
 * a 15-byte header (flag, block number, name, checksum) and a record (a
 * 15-byte record header, 512 bytes of data, a checksum), 543 bytes in all.
 *
 * `.mdr` files (the emulators' format) are those blocks one after the
 * other, then one byte that is non-zero when the cartridge is write
 * protected: 254 × 543 + 1 = 137,923 bytes.
 *
 * On the tape, each header and each record follows a gap and a preamble
 * (ten 00h, two FFh) that the Interface 1 writes when it formats; the
 * ULA's SYNC and GAP lines tell the ROM where they are. A cartridge read
 * from a file is formatted everywhere; a blank one nowhere until FORMAT.
 */

export const BLOCK_LEN = 543;
export const HEAD_LEN = 15;
export const DATA_LEN = 512;
export const MAX_BLOCKS = 254;
export const MDR_LENGTH = MAX_BLOCKS * BLOCK_LEN + 1;

export class Cartridge {
  /** The blocks, `blocks` × 543 bytes. */
  readonly data: Uint8Array;
  writeProtect = false;
  /** Written since it was loaded (to offer a download). */
  modified = false;
  /** Written since it was last kept in the browser. */
  dirty = false;
  /** The file it came from, or the name to download it as. */
  fileName = '';
  /**
   * Whether each header (index n) and record (256 + n) has its preamble on
   * the tape: 0 none, 1-12 being written, FFh formatted.
   */
  readonly preamble = new Uint8Array(512);

  constructor(readonly blocks: number, data?: Uint8Array) {
    this.data = data ?? new Uint8Array(blocks * BLOCK_LEN).fill(0xff);
  }

  /** A new, unformatted cartridge. */
  static blank(blocks = MAX_BLOCKS): Cartridge {
    const c = new Cartridge(blocks);
    c.modified = true;
    return c;
  }

  /** From an `.mdr` file: whole blocks, then (optionally) the write-protect byte. */
  static fromMdr(bytes: Uint8Array): Cartridge {
    const extra = bytes.length % BLOCK_LEN;
    if (bytes.length < 10 * BLOCK_LEN || extra > 1 || bytes.length > MDR_LENGTH) {
      throw new Error('this is not a Microdrive cartridge (.mdr)');
    }
    const blocks = (bytes.length - extra) / BLOCK_LEN;
    const c = new Cartridge(blocks, bytes.slice(0, blocks * BLOCK_LEN));
    c.writeProtect = extra === 1 && bytes[bytes.length - 1] !== 0;
    for (let i = 0; i < blocks; i++) c.preamble[i] = c.preamble[256 + i] = 0xff;
    return c;
  }

  toMdr(): Uint8Array {
    const out = new Uint8Array(this.data.length + 1);
    out.set(this.data);
    out[this.data.length] = this.writeProtect ? 1 : 0;
    return out;
  }

  /** The cartridge's name, from the first formatted header (blank: ''). */
  get label(): string {
    for (let b = 0; b < this.blocks; b++) {
      const h = b * BLOCK_LEN;
      if (this.preamble[b] !== 0xff || !(this.data[h] & 1)) continue;
      return String.fromCharCode(...this.data.subarray(h + 4, h + 14)).trimEnd();
    }
    return '';
  }
}

/**
 * A drive: its motor, and where the head is on the loop. The model is
 * FUSE's, driven by the ROM's own accesses: each byte read or written on
 * port E7h moves the head one byte, each read of the status port counts
 * down the gap and sync, and every access to the control or status port
 * puts the head back at the start of the header or record it is in, ready
 * for the next one.
 */
export class Drive {
  cartridge: Cartridge | null = null;
  motor = false;
  head = 0;
  /** Bytes moved since the header or record began. */
  private moved = 0;
  /** How many there are in it: 15 in a header, 528 in a record. */
  private size = HEAD_LEN;
  private last = 0xff;
  private gap = 15;
  private sync = 15;

  reset(): void {
    this.motor = false;
    this.head = 0;
    this.moved = 0;
    this.gap = this.sync = 15;
  }

  private get running(): boolean {
    return this.motor && this.cartridge !== null;
  }

  private advance(): void {
    if (++this.head >= this.cartridge!.blocks * BLOCK_LEN) this.head = 0;
  }

  /** Which preamble the head is in: the block's header, or (256 +) its record. */
  private get section(): number {
    return ((this.head / BLOCK_LEN) | 0) + (this.size === HEAD_LEN ? 0 : 256);
  }

  /** Back to the start of the header or record the head is in. */
  restart(): void {
    if (!this.cartridge) return;
    while (this.head % BLOCK_LEN !== 0 && this.head % BLOCK_LEN !== HEAD_LEN) this.advance();
    this.moved = 0;
    this.size = this.head % BLOCK_LEN === 0 ? HEAD_LEN : HEAD_LEN + DATA_LEN + 1;
  }

  /** Port E7h in: the next byte under the head (FFh from a drive that is not running). */
  readData(): number {
    if (!this.running) return 0xff;
    if (this.moved < this.size) {
      this.last = this.cartridge!.data[this.head];
      this.advance();
    }
    this.moved++;
    return this.last;
  }

  /** Port E7h out: the preamble the ROM writes first, then the bytes. */
  writeData(v: number): void {
    if (!this.running) return;
    const c = this.cartridge!;
    const s = this.section;
    const n = this.moved;
    if (n === 0 && v === 0x00) c.preamble[s] = 1;
    else if (n > 0 && n < 10 && v === 0x00) c.preamble[s]++;
    else if (n > 9 && n < 12 && v === 0xff) c.preamble[s]++;
    else if (n === 12 && c.preamble[s] === 12) c.preamble[s] = 0xff;
    if (n > 11 && n < this.size + 12) {
      c.data[this.head] = v;
      this.advance();
      c.modified = c.dirty = true;
    }
    this.moved++;
  }

  /** Port EFh in, this drive's part: bit 0 write protect, bit 1 SYNC, bit 2 GAP (all active low). */
  status(): number {
    if (!this.running) return 0xff;
    let v = 0xff;
    if (this.cartridge!.preamble[this.section] === 0xff) {
      if (this.gap) this.gap--;
      else {
        v &= 0xf9;
        if (this.sync) this.sync--;
        else this.gap = this.sync = 15;
      }
    }
    if (this.cartridge!.writeProtect) v &= 0xfe;
    return v;
  }
}
