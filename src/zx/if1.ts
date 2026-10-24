/**
 * Sinclair's ZX Interface 1 (1983): eight Microdrives, an RS232 port and
 * the ZX Net, run by its own 8K ROM.
 *
 * The ROM is "shadow": it covers 0000h–3FFFh (8K, mirrored) when the CPU
 * fetches an opcode from 0008h (RST 8: the errors BASIC cannot handle,
 * and the hook codes) or 1708h (CLOSE #), and it leaves after the fetch at
 * 0700h. The machine does the paging; this class holds the ROM and the
 * hardware behind three ports, decoded by A4 and A3:
 *
 *   E7h  in/out  Microdrive data
 *   EFh  out     bit 0 COMMS DATA (drive select bit; 1 also picks RS232
 *                over the network), bit 1 COMMS CLK (a fall shifts the
 *                motor register), bit 2 R/W, bit 3 ERASE, bit 4 CTS, bit 5 WAIT
 *        in      bit 0 write protect, 1 SYNC, 2 GAP (low = active), bit 3
 *                DTR (the RS232 device is ready), bit 4 BUSY
 *   F7h  out     bit 0 the RS232 TX line (or the network)
 *        in      bit 7 the RS232 RX line, bit 0 the network
 *
 * The motor register is a shift register: each clock fall moves every
 * drive's "on" bit along and puts COMMS DATA (low = on) into drive 1, so
 * the ROM picks drive n with a 0 followed by n-1 ones. The serial line
 * (see rs232.ts) is wired to the telnet modem.
 */
import { Drive } from './microdrive';
import { Rs232 } from './rs232';

export class Interface1 {
  readonly drives = Array.from({ length: 8 }, () => new Drive());
  readonly rs232: Rs232;
  private clk = false;
  /** COMMS DATA: 1 selects RS232 for the TX line. */
  private commsData = false;

  /** `rom` is 8K. `rs232` carries bytes to and from the modem. */
  constructor(readonly rom: Uint8Array, rs232: Rs232) {
    if (rom.length !== 0x2000) throw new Error('the Interface 1 ROM is 8K');
    this.rs232 = rs232;
  }

  reset(): void {
    for (const d of this.drives) d.reset();
    this.clk = this.commsData = false;
    this.rs232.reset();
  }

  /** Whether `port` is one of the Interface 1's. */
  static owns(port: number): boolean {
    return (port & 1) === 1 && (port & 0x18) !== 0x18;
  }

  private restart(): void {
    for (const d of this.drives) d.restart();
  }

  /** `t` is the absolute T-state, for the serial line. */
  read(port: number, t: number): number {
    let v = 0xff;
    switch (port & 0x18) {
      case 0x00:
        for (const d of this.drives) v &= d.readData();
        return v;
      case 0x08:
        for (const d of this.drives) v &= d.status();
        if (!this.rs232.dtr(t)) v &= 0xf7;
        v &= 0xef; // never BUSY
        this.restart();
        return v;
      default: // 10h: F7h
        return this.rs232.rxLevel(t) ? 0xff : 0x7f;
    }
  }

  write(port: number, v: number, t: number): void {
    switch (port & 0x18) {
      case 0x00:
        for (const d of this.drives) d.writeData(v);
        return;
      case 0x08: {
        const clk = (v & 2) !== 0;
        if (this.clk && !clk) {
          for (let m = 7; m > 0; m--) this.drives[m].motor = this.drives[m - 1].motor;
          this.drives[0].motor = !(v & 1);
        }
        this.clk = clk;
        this.commsData = (v & 1) !== 0;
        // Without COMMS DATA the RS232 driver is off: the line rests.
        if (!this.commsData) this.rs232.setTx(false, t);
        this.rs232.setCts((v & 0x10) !== 0, t);
        this.restart();
        return;
      }
      default:
        if (this.commsData) this.rs232.setTx((v & 1) !== 0, t);
        this.restart();
    }
  }

  /** Whether any drive's motor runs (for the drive lamp). */
  get busy(): boolean {
    return this.drives.some((d) => d.motor && d.cartridge);
  }
}
