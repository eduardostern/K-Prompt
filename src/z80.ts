/*! K-Prompt — © 2026 Eduardo Stern <eduardostern@icloud.com> — MIT License. Z80 core from A-Prompt and Ok-Prompt. */
/*
 * Z80 CPU core, timed access by access.
 *
 * An interpreter for the documented instruction set plus the undocumented
 * parts real software relies on (SLL, IXH/IXL, DDCB register copies, ED
 * variants, the flags' bits 3 and 5, MEMPTR and Q). Every machine cycle
 * advances `cycles` when it happens: an opcode fetch takes 4 T-states, a
 * memory read or write 3, and internal cycles are counted one by one
 * against the address the CPU leaves on the bus, as on the real chip. That
 * is what a Spectrum's ULA needs to delay ("contend") the CPU: before each
 * of those cycles, `mc()` adds the wait states from `contention` when the
 * address is in a contended page. I/O is timed the same way (`ioPre`,
 * `ioPost`), with the ULA's ports contended by their own pattern.
 *
 * The timing of every access matches FUSE's core tests
 * (tests/fuse.test.ts), and the instruction set passes zexdoc and zexall.
 */

export const CF = 0x01; // carry
export const NF = 0x02; // add/subtract
export const PF = 0x04; // parity / overflow
export const XF = 0x08; // undocumented bit 3
export const HF = 0x10; // half carry
export const YF = 0x20; // undocumented bit 5
export const ZF = 0x40; // zero
export const SF = 0x80; // sign

export interface Z80State {
  a: number; f: number;
  b: number; c: number; d: number; e: number; h: number; l: number;
  a2: number; f2: number; b2: number; c2: number; d2: number; e2: number; h2: number; l2: number;
  ix: number; iy: number; sp: number; pc: number; i: number; r: number;
  iff1: number; iff2: number; im: number; halted: boolean;
}

const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let v = i, p = 0;
  while (v) { p ^= v & 1; v >>= 1; }
  PARITY[i] = p ? 0 : PF;
}

const SZ = new Uint8Array(256);
const SZP = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  SZ[i] = (i & (SF | XF | YF)) | (i === 0 ? ZF : 0);
  SZP[i] = SZ[i] | PARITY[i];
}

export class Z80 {
  mem = new Uint8Array(65536);

  a = 0; f = 0;
  b = 0; c = 0; d = 0; e = 0; h = 0; l = 0;
  a2 = 0; f2 = 0; b2 = 0; c2 = 0; d2 = 0; e2 = 0; h2 = 0; l2 = 0;
  ix = 0; iy = 0; sp = 0; pc = 0; i = 0; r = 0;
  iff1 = 0; iff2 = 0; im = 0;
  /** HALT is running: PC stays on it and it is fetched again every 4 T-states. */
  halted = false;
  /** MEMPTR (WZ), the internal address register; bits 3 and 5 of BIT n,(HL) come from it. */
  wz = 0;
  /** Q: F when the last instruction set the flags, else 0 (SCF and CCF read it). */
  q = 0;
  private lastQ = 0;
  private qset = false;

  /** T-state counter: the machine paces itself and its devices by it. */
  cycles = 0;

  /** EI ran in the last step: no interrupt until one more instruction. */
  private eiPending = false;

  /**
   * Memory: a flat 64K (`mem`) by default. A machine with banked memory
   * replaces read and write; every access the core makes goes through them.
   * They take no time: the core counts the T-states itself.
   */
  read: (addr: number) => number = (addr) => this.mem[addr];
  /**
   * Opcode fetches (M1), when a machine sees them differently from data
   * reads: the ZX80/ZX81 display circuit puts a NOP on the bus while the
   * CPU runs through the display file. Null: fetches use `read`.
   */
  fetchOp: ((addr: number) => number) | null = null;
  write: (addr: number, value: number) => void = (addr, value) => { this.mem[addr] = value; };

  /** I/O port handlers; the default is an empty bus (FFh) and a sink. */
  portIn: (port: number) => number = () => 0xff;
  portOut: (port: number, value: number) => void = () => {};

  /**
   * Contention: the wait states at each T-state of the frame (indexed by
   * `cycles`), or null for none. `contendedPage[addr >> 14]` is 1 for each
   * 16K page the ULA delays.
   */
  contention: Uint8Array | null = null;
  contendedPage = new Uint8Array(4);
  /** Whether a port is the ULA's (it is contended whatever its address). */
  ulaPort: (port: number) => boolean = (port) => !(port & 1);

  reset(): void {
    this.a = this.f = 0;
    this.b = this.c = this.d = this.e = this.h = this.l = 0;
    this.a2 = this.f2 = this.b2 = this.c2 = this.d2 = this.e2 = this.h2 = this.l2 = 0;
    this.ix = this.iy = 0;
    this.sp = 0xffff;
    this.pc = 0;
    this.i = 0;
    this.r = 0;
    this.iff1 = this.iff2 = 0;
    this.im = 0;
    this.halted = false;
    this.wz = 0;
    this.q = this.lastQ = 0;
    this.cycles = 0;
    this.eiPending = false;
  }

  get af(): number { return (this.a << 8) | this.f; }
  set af(v: number) { this.a = (v >> 8) & 0xff; this.f = v & 0xff; }
  get bc(): number { return (this.b << 8) | this.c; }
  set bc(v: number) { this.b = (v >> 8) & 0xff; this.c = v & 0xff; }
  get de(): number { return (this.d << 8) | this.e; }
  set de(v: number) { this.d = (v >> 8) & 0xff; this.e = v & 0xff; }
  get hl(): number { return (this.h << 8) | this.l; }
  set hl(v: number) { this.h = (v >> 8) & 0xff; this.l = v & 0xff; }
  private get ir(): number { return (this.i << 8) | this.r; }

  // ---- bus cycles -------------------------------------------------------

  /** A machine cycle of `t` T-states with `addr` on the bus, delayed first if contended. */
  protected mc(addr: number, t: number): void {
    const c = this.contention;
    if (c !== null && this.contendedPage[addr >> 14]) this.cycles += c[this.cycles] | 0;
    this.cycles += t;
  }

  /** `n` internal T-states with `addr` left on the bus, each one contended on its own. */
  private nm(addr: number, n: number): void {
    addr &= 0xffff;
    for (let k = 0; k < n; k++) this.mc(addr, 1);
  }

  /** The first T-state of an I/O cycle. */
  protected ioPre(port: number): void {
    const c = this.contention;
    if (c !== null && this.contendedPage[port >> 14]) this.cycles += c[this.cycles] | 0;
    this.cycles += 1;
  }

  /** The other three: the ULA's ports are contended once, others in a contended page each T-state. */
  protected ioPost(port: number): void {
    const c = this.contention;
    if (this.ulaPort(port)) {
      if (c !== null) this.cycles += c[this.cycles] | 0;
      this.cycles += 3;
    } else if (c !== null && this.contendedPage[port >> 14]) {
      for (let k = 0; k < 3; k++) { this.cycles += c[this.cycles] | 0; this.cycles += 1; }
    } else this.cycles += 3;
  }

  private inPort(port: number): number {
    this.ioPre(port);
    const v = this.portIn(port) & 0xff;
    this.ioPost(port);
    return v;
  }

  private outPort(port: number, v: number): void {
    this.ioPre(port);
    this.portOut(port, v & 0xff);
    this.ioPost(port);
  }

  /** An opcode fetch (M1): 4 T-states, and R counts it. */
  private fetch(): number {
    const pc = this.pc;
    this.mc(pc, 4);
    const op = this.fetchOp ? this.fetchOp(pc) : this.read(pc);
    this.pc = (pc + 1) & 0xffff;
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7f);
    return op;
  }

  private rd(addr: number): number {
    addr &= 0xffff;
    this.mc(addr, 3);
    return this.read(addr);
  }
  private wr(addr: number, value: number): void {
    addr &= 0xffff;
    this.mc(addr, 3);
    this.write(addr, value & 0xff);
  }

  private imm8(): number {
    const v = this.rd(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }
  private imm16(): number {
    const lo = this.imm8();
    return lo | (this.imm8() << 8);
  }
  private rd16(addr: number): number {
    const lo = this.rd(addr);
    return lo | (this.rd(addr + 1) << 8);
  }
  private wr16(addr: number, v: number): void {
    this.wr(addr, v & 0xff);
    this.wr(addr + 1, (v >> 8) & 0xff);
  }
  private push16(v: number): void {
    this.sp = (this.sp - 1) & 0xffff;
    this.wr(this.sp, (v >> 8) & 0xff);
    this.sp = (this.sp - 1) & 0xffff;
    this.wr(this.sp, v & 0xff);
  }
  private pop16(): number {
    const lo = this.rd(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    const hi = this.rd(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    return lo | (hi << 8);
  }

  private getR(i: number, idx = 0): number {
    switch (i) {
      case 0: return this.b;
      case 1: return this.c;
      case 2: return this.d;
      case 3: return this.e;
      case 4: return idx === 1 ? (this.ix >> 8) & 0xff : idx === 2 ? (this.iy >> 8) & 0xff : this.h;
      case 5: return idx === 1 ? this.ix & 0xff : idx === 2 ? this.iy & 0xff : this.l;
      case 7: return this.a;
      default: return 0;
    }
  }

  private setR(i: number, v: number, idx = 0): void {
    v &= 0xff;
    switch (i) {
      case 0: this.b = v; break;
      case 1: this.c = v; break;
      case 2: this.d = v; break;
      case 3: this.e = v; break;
      case 4:
        if (idx === 1) this.ix = (this.ix & 0x00ff) | (v << 8);
        else if (idx === 2) this.iy = (this.iy & 0x00ff) | (v << 8);
        else this.h = v;
        break;
      case 5:
        if (idx === 1) this.ix = (this.ix & 0xff00) | v;
        else if (idx === 2) this.iy = (this.iy & 0xff00) | v;
        else this.l = v;
        break;
      case 7: this.a = v; break;
    }
  }

  private getHL(idx: number): number {
    return idx === 1 ? this.ix : idx === 2 ? this.iy : this.hl;
  }
  private setHL(idx: number, v: number): void {
    v &= 0xffff;
    if (idx === 1) this.ix = v;
    else if (idx === 2) this.iy = v;
    else this.hl = v;
  }

  /**
   * (IX+d): reads d, then 5 internal T-states on its address while the
   * CPU adds it. MEMPTR takes the result.
   */
  private idxAddr(idx: number): number {
    const at = this.pc;
    const d = (this.imm8() << 24) >> 24;
    this.nm(at, 5);
    return (this.wz = (this.getHL(idx) + d) & 0xffff);
  }

  // ---- flag helpers -----------------------------------------------------

  /** The instruction sets the flags (Q takes F when it ends). */
  private flags(f: number): void {
    this.f = f;
    this.qset = true;
  }

  private add8(v: number, withCarry: boolean): number {
    const a = this.a;
    const carry = withCarry && (this.f & CF) ? 1 : 0;
    const sum = a + v + carry;
    const r = sum & 0xff;
    let f = SZ[r];
    f |= (sum & 0x100) ? CF : 0;
    f |= ((a ^ v ^ r) & HF);
    f |= ((a ^ r) & (v ^ r) & 0x80) >> 5;
    this.flags(f);
    return r;
  }

  private sub8(v: number, withCarry: boolean, store = true): number {
    const a = this.a;
    const carry = withCarry && (this.f & CF) ? 1 : 0;
    const diff = a - v - carry;
    const r = diff & 0xff;
    let f = SZ[r] | NF;
    f |= (diff & 0x100) ? CF : 0;
    f |= ((a ^ v ^ r) & HF);
    f |= ((a ^ v) & (a ^ r) & 0x80) >> 5;
    // CP puts the undocumented bits 3/5 of the operand in F, not the result.
    if (!store) f = (f & ~(XF | YF)) | (v & (XF | YF));
    this.flags(f);
    if (store) this.a = r;
    return r;
  }

  private and8(v: number): void { this.a &= v; this.flags(SZP[this.a] | HF); }
  private xor8(v: number): void { this.a = (this.a ^ v) & 0xff; this.flags(SZP[this.a]); }
  private or8(v: number): void { this.a |= v; this.flags(SZP[this.a]); }

  private inc8(v: number): number {
    const r = (v + 1) & 0xff;
    this.flags((this.f & CF) | (r & (SF | XF | YF)) | (r === 0 ? ZF : 0) |
      (r === 0x80 ? PF : 0) | ((v & 0x0f) === 0x0f ? HF : 0));
    return r;
  }

  private dec8(v: number): number {
    const r = (v - 1) & 0xff;
    this.flags((this.f & CF) | NF | (r & (SF | XF | YF)) | (r === 0 ? ZF : 0) |
      (r === 0x7f ? PF : 0) | ((v & 0x0f) === 0 ? HF : 0));
    return r;
  }

  /** ADD HL,rr (or IX/IY): 7 internal T-states on IR. */
  private addHL(v: number, idx = 0): void {
    this.nm(this.ir, 7);
    const a = this.getHL(idx);
    this.wz = (a + 1) & 0xffff;
    const sum = a + v;
    const r = sum & 0xffff;
    this.flags((this.f & (SF | ZF | PF)) |
      (((a ^ v ^ r) >> 8) & HF) |
      ((r >> 8) & (XF | YF)) |
      (sum > 0xffff ? CF : 0));
    this.setHL(idx, r);
  }

  private adcHL(v: number): void {
    this.nm(this.ir, 7);
    const a = this.hl;
    this.wz = (a + 1) & 0xffff;
    const carry = (this.f & CF) ? 1 : 0;
    const sum = a + v + carry;
    const r = sum & 0xffff;
    let f = ((r >> 8) & (SF | XF | YF)) | (r === 0 ? ZF : 0) |
      (((a ^ v ^ r) >> 8) & HF) | (sum > 0xffff ? CF : 0);
    f |= ((a ^ r) & (v ^ r) & 0x8000) >> 13;
    this.flags(f);
    this.hl = r;
  }

  private sbcHL(v: number): void {
    this.nm(this.ir, 7);
    const a = this.hl;
    this.wz = (a + 1) & 0xffff;
    const carry = (this.f & CF) ? 1 : 0;
    const diff = a - v - carry;
    const r = diff & 0xffff;
    let f = NF | ((r >> 8) & (SF | XF | YF)) | (r === 0 ? ZF : 0) |
      (((a ^ v ^ r) >> 8) & HF) | (diff < 0 ? CF : 0);
    f |= ((a ^ v) & (a ^ r) & 0x8000) >> 13;
    this.flags(f);
    this.hl = r;
  }

  private alu(op: number, v: number): void {
    switch (op) {
      case 0: this.a = this.add8(v, false); break;
      case 1: this.a = this.add8(v, true); break;
      case 2: this.sub8(v, false); break;
      case 3: this.sub8(v, true); break;
      case 4: this.and8(v); break;
      case 5: this.xor8(v); break;
      case 6: this.or8(v); break;
      case 7: this.sub8(v, false, false); break;
    }
  }

  private daa(): void {
    const old = this.a;
    let correction = 0;
    let carry = 0;
    if (old > 0x99 || (this.f & CF)) {
      carry = CF;
      correction = 0x60;
    }
    if ((old & 0x0f) > 9 || (this.f & HF)) correction += 0x06;
    this.a = (old + ((this.f & NF) ? -correction : correction)) & 0xff;
    this.flags(SZP[this.a] | ((this.a ^ old) & HF) | (this.f & NF) | carry);
  }

  private rot(kind: number, v: number): number {
    let r: number, c: number;
    switch (kind) {
      case 0: c = v >> 7; r = (v << 1) | c; break; // RLC
      case 1: c = v & 1; r = (v >> 1) | (c << 7); break; // RRC
      case 2: c = v >> 7; r = (v << 1) | (this.f & CF); break; // RL
      case 3: c = v & 1; r = (v >> 1) | ((this.f & CF) << 7); break; // RR
      case 4: c = v >> 7; r = v << 1; break; // SLA
      case 5: c = v & 1; r = (v >> 1) | (v & 0x80); break; // SRA
      case 6: c = v >> 7; r = (v << 1) | 1; break; // SLL
      default: c = v & 1; r = v >> 1; break; // SRL
    }
    r &= 0xff;
    this.flags(SZP[r] | (c ? CF : 0));
    return r;
  }

  /** BIT: bits 3 and 5 come from `f53` (the register, or MEMPTR's high byte for memory). */
  private bitTest(v: number, bit: number, f53: number): void {
    const set = v & (1 << bit);
    this.flags((this.f & CF) | HF | (set ? 0 : ZF | PF) |
      (bit === 7 && set ? SF : 0) | (f53 & (XF | YF)));
  }

  /** RLCA, RRCA, RLA, RRA: S, Z and P are kept. */
  private rotA(kind: number): void {
    const a = this.a;
    let r: number, c: number;
    switch (kind) {
      case 0: c = a >> 7; r = (a << 1) | c; break;
      case 1: c = a & 1; r = (a >> 1) | (c << 7); break;
      case 2: c = a >> 7; r = (a << 1) | (this.f & CF); break;
      default: c = a & 1; r = (a >> 1) | ((this.f & CF) << 7); break;
    }
    this.a = r & 0xff;
    this.flags((this.f & (SF | ZF | PF)) | (this.a & (XF | YF)) | c);
  }

  // ---- main loop --------------------------------------------------------

  step(): void {
    // Interrupts are taken again only after the instruction that follows EI.
    this.eiPending = false;
    this.lastQ = this.q;
    this.qset = false;
    if (this.halted) {
      // HALT is fetched again and again (as NOPs) until an interrupt.
      this.mc(this.pc, 4);
      if (this.fetchOp) this.fetchOp(this.pc);
      else this.read(this.pc);
      this.r = (this.r & 0x80) | ((this.r + 1) & 0x7f);
      this.q = 0;
      return;
    }
    this.execBase(this.fetch());
    this.q = this.qset ? this.f : 0;
  }

  /** JR e, taken or not: the offset is read; a taken jump adds 5 T-states on its address. */
  private jr(take: boolean): void {
    const at = this.pc;
    if (!take) {
      // The offset's cycle runs, but nothing needs its value.
      this.mc(at, 3);
      this.pc = (at + 1) & 0xffff;
      return;
    }
    const d = (this.imm8() << 24) >> 24;
    this.nm(at, 5);
    this.pc = this.wz = (this.pc + d) & 0xffff;
  }

  private jp(take: boolean): void {
    const a = this.wz = this.imm16();
    if (take) this.pc = a;
  }

  private call(take: boolean): void {
    const a = this.wz = this.imm16();
    if (!take) return;
    this.nm(this.pc - 1, 1);
    this.push16(this.pc);
    this.pc = a;
  }

  private ret(take: boolean): void {
    this.nm(this.ir, 1);
    if (take) this.pc = this.wz = this.pop16();
  }

  private rst(addr: number): void {
    this.nm(this.ir, 1);
    this.push16(this.pc);
    this.pc = this.wz = addr;
  }

  private push(v: number): void {
    this.nm(this.ir, 1);
    this.push16(v);
  }

  /** EX (SP),HL/IX/IY: read 2, an internal T-state, write 2, then 2 more. */
  private exSp(v: number): number {
    const sp = this.sp;
    const lo = this.rd(sp);
    const hi = this.rd(sp + 1);
    this.nm(sp + 1, 1);
    this.wr(sp + 1, v >> 8);
    this.wr(sp, v & 0xff);
    this.nm(sp, 2);
    return (this.wz = lo | (hi << 8));
  }

  private execBase(op: number): void {
    if (op >= 0x40 && op <= 0x7f) {
      if (op === 0x76) { this.halted = true; this.pc = (this.pc - 1) & 0xffff; return; }
      const dst = (op >> 3) & 7;
      const src = op & 7;
      if (src === 6) this.setR(dst, this.rd(this.hl));
      else if (dst === 6) this.wr(this.hl, this.getR(src));
      else this.setR(dst, this.getR(src));
      return;
    }
    if (op >= 0x80 && op <= 0xbf) {
      const src = op & 7;
      this.alu((op >> 3) & 7, src === 6 ? this.rd(this.hl) : this.getR(src));
      return;
    }

    switch (op) {
      case 0x00: break; // NOP
      case 0x01: this.bc = this.imm16(); break;
      case 0x02: this.wr(this.bc, this.a); this.wz = ((this.bc + 1) & 0xff) | (this.a << 8); break;
      case 0x03: this.nm(this.ir, 2); this.bc = (this.bc + 1) & 0xffff; break;
      case 0x04: this.b = this.inc8(this.b); break;
      case 0x05: this.b = this.dec8(this.b); break;
      case 0x06: this.b = this.imm8(); break;
      case 0x07: this.rotA(0); break;
      case 0x08: { const a = this.a, f = this.f; this.a = this.a2; this.f = this.f2; this.a2 = a; this.f2 = f; break; }
      case 0x09: this.addHL(this.bc); break;
      case 0x0a: this.wz = (this.bc + 1) & 0xffff; this.a = this.rd(this.bc); break;
      case 0x0b: this.nm(this.ir, 2); this.bc = (this.bc - 1) & 0xffff; break;
      case 0x0c: this.c = this.inc8(this.c); break;
      case 0x0d: this.c = this.dec8(this.c); break;
      case 0x0e: this.c = this.imm8(); break;
      case 0x0f: this.rotA(1); break;
      case 0x10: this.nm(this.ir, 1); this.b = (this.b - 1) & 0xff; this.jr(this.b !== 0); break;
      case 0x11: this.de = this.imm16(); break;
      case 0x12: this.wr(this.de, this.a); this.wz = ((this.de + 1) & 0xff) | (this.a << 8); break;
      case 0x13: this.nm(this.ir, 2); this.de = (this.de + 1) & 0xffff; break;
      case 0x14: this.d = this.inc8(this.d); break;
      case 0x15: this.d = this.dec8(this.d); break;
      case 0x16: this.d = this.imm8(); break;
      case 0x17: this.rotA(2); break;
      case 0x18: this.jr(true); break;
      case 0x19: this.addHL(this.de); break;
      case 0x1a: this.wz = (this.de + 1) & 0xffff; this.a = this.rd(this.de); break;
      case 0x1b: this.nm(this.ir, 2); this.de = (this.de - 1) & 0xffff; break;
      case 0x1c: this.e = this.inc8(this.e); break;
      case 0x1d: this.e = this.dec8(this.e); break;
      case 0x1e: this.e = this.imm8(); break;
      case 0x1f: this.rotA(3); break;
      case 0x20: this.jr(!(this.f & ZF)); break;
      case 0x21: this.hl = this.imm16(); break;
      case 0x22: { const a = this.imm16(); this.wr16(a, this.hl); this.wz = (a + 1) & 0xffff; break; }
      case 0x23: this.nm(this.ir, 2); this.hl = (this.hl + 1) & 0xffff; break;
      case 0x24: this.h = this.inc8(this.h); break;
      case 0x25: this.h = this.dec8(this.h); break;
      case 0x26: this.h = this.imm8(); break;
      case 0x27: this.daa(); break;
      case 0x28: this.jr((this.f & ZF) !== 0); break;
      case 0x29: this.addHL(this.hl); break;
      case 0x2a: { const a = this.imm16(); this.hl = this.rd16(a); this.wz = (a + 1) & 0xffff; break; }
      case 0x2b: this.nm(this.ir, 2); this.hl = (this.hl - 1) & 0xffff; break;
      case 0x2c: this.l = this.inc8(this.l); break;
      case 0x2d: this.l = this.dec8(this.l); break;
      case 0x2e: this.l = this.imm8(); break;
      case 0x2f: this.a = (~this.a) & 0xff; this.flags((this.f & (SF | ZF | PF | CF)) | NF | HF | (this.a & (XF | YF))); break;
      case 0x30: this.jr(!(this.f & CF)); break;
      case 0x31: this.sp = this.imm16(); break;
      case 0x32: { const a = this.imm16(); this.wr(a, this.a); this.wz = ((a + 1) & 0xff) | (this.a << 8); break; }
      case 0x33: this.nm(this.ir, 2); this.sp = (this.sp + 1) & 0xffff; break;
      case 0x34: { const hl = this.hl; const v = this.inc8(this.rd(hl)); this.nm(hl, 1); this.wr(hl, v); break; }
      case 0x35: { const hl = this.hl; const v = this.dec8(this.rd(hl)); this.nm(hl, 1); this.wr(hl, v); break; }
      case 0x36: this.wr(this.hl, this.imm8()); break;
      case 0x37: // SCF: bits 3 and 5 from A, or kept from F if the last instruction set it
        this.flags((this.f & (SF | ZF | PF)) | (((this.lastQ ^ this.f) | this.a) & (XF | YF)) | CF);
        break;
      case 0x38: this.jr((this.f & CF) !== 0); break;
      case 0x39: this.addHL(this.sp); break;
      case 0x3a: { const a = this.imm16(); this.a = this.rd(a); this.wz = (a + 1) & 0xffff; break; }
      case 0x3b: this.nm(this.ir, 2); this.sp = (this.sp - 1) & 0xffff; break;
      case 0x3c: this.a = this.inc8(this.a); break;
      case 0x3d: this.a = this.dec8(this.a); break;
      case 0x3e: this.a = this.imm8(); break;
      case 0x3f: // CCF
        this.flags((this.f & (SF | ZF | PF)) | ((this.f & CF) ? HF : CF) | (((this.lastQ ^ this.f) | this.a) & (XF | YF)));
        break;

      case 0xc0: this.ret(!(this.f & ZF)); break;
      case 0xc1: this.bc = this.pop16(); break;
      case 0xc2: this.jp(!(this.f & ZF)); break;
      case 0xc3: this.jp(true); break;
      case 0xc4: this.call(!(this.f & ZF)); break;
      case 0xc5: this.push(this.bc); break;
      case 0xc6: this.a = this.add8(this.imm8(), false); break;
      case 0xc7: this.rst(0x00); break;
      case 0xc8: this.ret((this.f & ZF) !== 0); break;
      case 0xc9: this.pc = this.wz = this.pop16(); break;
      case 0xca: this.jp((this.f & ZF) !== 0); break;
      case 0xcb: this.execCb(); break;
      case 0xcc: this.call((this.f & ZF) !== 0); break;
      case 0xcd: this.call(true); break;
      case 0xce: this.a = this.add8(this.imm8(), true); break;
      case 0xcf: this.rst(0x08); break;

      case 0xd0: this.ret(!(this.f & CF)); break;
      case 0xd1: this.de = this.pop16(); break;
      case 0xd2: this.jp(!(this.f & CF)); break;
      case 0xd3: { // OUT (n),A
        const n = this.imm8();
        this.outPort((this.a << 8) | n, this.a);
        this.wz = ((n + 1) & 0xff) | (this.a << 8);
        break;
      }
      case 0xd4: this.call(!(this.f & CF)); break;
      case 0xd5: this.push(this.de); break;
      case 0xd6: this.sub8(this.imm8(), false); break;
      case 0xd7: this.rst(0x10); break;
      case 0xd8: this.ret((this.f & CF) !== 0); break;
      case 0xd9: { const b = this.b, c = this.c, d = this.d, e = this.e, h = this.h, l = this.l; this.b = this.b2; this.c = this.c2; this.d = this.d2; this.e = this.e2; this.h = this.h2; this.l = this.l2; this.b2 = b; this.c2 = c; this.d2 = d; this.e2 = e; this.h2 = h; this.l2 = l; break; }
      case 0xda: this.jp((this.f & CF) !== 0); break;
      case 0xdb: { // IN A,(n)
        const port = (this.a << 8) | this.imm8();
        this.wz = (port + 1) & 0xffff;
        this.a = this.inPort(port);
        break;
      }
      case 0xdc: this.call((this.f & CF) !== 0); break;
      case 0xdd: this.execIndexed(1); break;
      case 0xde: this.sub8(this.imm8(), true); break;
      case 0xdf: this.rst(0x18); break;

      case 0xe0: this.ret(!(this.f & PF)); break;
      case 0xe1: this.hl = this.pop16(); break;
      case 0xe2: this.jp(!(this.f & PF)); break;
      case 0xe3: this.hl = this.exSp(this.hl); break;
      case 0xe4: this.call(!(this.f & PF)); break;
      case 0xe5: this.push(this.hl); break;
      case 0xe6: this.and8(this.imm8()); break;
      case 0xe7: this.rst(0x20); break;
      case 0xe8: this.ret((this.f & PF) !== 0); break;
      case 0xe9: this.pc = this.hl; break;
      case 0xea: this.jp((this.f & PF) !== 0); break;
      case 0xeb: { const d = this.d, e = this.e; this.d = this.h; this.e = this.l; this.h = d; this.l = e; break; }
      case 0xec: this.call((this.f & PF) !== 0); break;
      case 0xed: this.execEd(); break;
      case 0xee: this.xor8(this.imm8()); break;
      case 0xef: this.rst(0x28); break;

      case 0xf0: this.ret(!(this.f & SF)); break;
      case 0xf1: this.af = this.pop16(); break;
      case 0xf2: this.jp(!(this.f & SF)); break;
      case 0xf3: this.iff1 = this.iff2 = 0; break;
      case 0xf4: this.call(!(this.f & SF)); break;
      case 0xf5: this.push(this.af); break;
      case 0xf6: this.or8(this.imm8()); break;
      case 0xf7: this.rst(0x30); break;
      case 0xf8: this.ret((this.f & SF) !== 0); break;
      case 0xf9: this.nm(this.ir, 2); this.sp = this.hl; break;
      case 0xfa: this.jp((this.f & SF) !== 0); break;
      case 0xfb: this.iff1 = this.iff2 = 1; this.eiPending = true; break;
      case 0xfc: this.call((this.f & SF) !== 0); break;
      case 0xfd: this.execIndexed(2); break;
      case 0xfe: this.sub8(this.imm8(), false, false); break;
      case 0xff: this.rst(0x38); break;
    }
  }

  private execCb(): void {
    const op = this.fetch();
    const reg = op & 7;
    const group = op >> 6;
    const bit = (op >> 3) & 7;
    if (reg !== 6) {
      const v = this.getR(reg);
      if (group === 0) this.setR(reg, this.rot(bit, v));
      else if (group === 1) this.bitTest(v, bit, v);
      else if (group === 2) this.setR(reg, v & ~(1 << bit));
      else this.setR(reg, v | (1 << bit));
      return;
    }
    // (HL): read, an internal T-state, and write back (BIT only reads).
    const hl = this.hl;
    const v = this.rd(hl);
    this.nm(hl, 1);
    if (group === 1) { this.bitTest(v, bit, this.wz >> 8); return; }
    const r = group === 0 ? this.rot(bit, v) : group === 2 ? v & ~(1 << bit) : v | (1 << bit);
    this.wr(hl, r);
  }

  private execIndexed(idx: 1 | 2): void {
    const op = this.fetch();
    if (op === 0xdd || op === 0xfd) { this.execIndexed(op === 0xdd ? 1 : 2); return; }
    if (op === 0xcb) {
      // DD CB d op: d is read, then op (not an M1 fetch), then 2 internal T-states.
      const d = (this.imm8() << 24) >> 24;
      const at = this.pc;
      const cb = this.rd(at);
      this.pc = (at + 1) & 0xffff;
      this.nm(at, 2);
      const addr = this.wz = (this.getHL(idx) + d) & 0xffff;
      const reg = cb & 7;
      const group = cb >> 6;
      const bit = (cb >> 3) & 7;
      const v = this.rd(addr);
      this.nm(addr, 1);
      if (group === 1) { this.bitTest(v, bit, addr >> 8); return; }
      const r = group === 0 ? this.rot(bit, v) : group === 2 ? v & ~(1 << bit) : v | (1 << bit);
      this.wr(addr, r);
      if (reg !== 6) this.setR(reg, r);
      return;
    }
    if (op === 0x76) { this.halted = true; this.pc = (this.pc - 1) & 0xffff; return; }
    if (op >= 0x40 && op <= 0x7f) {
      const dst = (op >> 3) & 7;
      const src = op & 7;
      if (dst === 6) {
        const addr = this.idxAddr(idx);
        this.wr(addr, this.getR(src));
      } else if (src === 6) {
        this.setR(dst, this.rd(this.idxAddr(idx)));
      } else {
        this.setR(dst, this.getR(src, idx), idx);
      }
      return;
    }
    if (op >= 0x80 && op <= 0xbf) {
      const src = op & 7;
      const v = src === 6 ? this.rd(this.idxAddr(idx)) : this.getR(src, idx);
      this.alu((op >> 3) & 7, v);
      return;
    }
    switch (op) {
      case 0x09: this.addHL(this.bc, idx); break;
      case 0x19: this.addHL(this.de, idx); break;
      case 0x29: this.addHL(this.getHL(idx), idx); break;
      case 0x39: this.addHL(this.sp, idx); break;
      case 0x21: this.setHL(idx, this.imm16()); break;
      case 0x22: { const a = this.imm16(); this.wr16(a, this.getHL(idx)); this.wz = (a + 1) & 0xffff; break; }
      case 0x2a: { const a = this.imm16(); this.setHL(idx, this.rd16(a)); this.wz = (a + 1) & 0xffff; break; }
      case 0x23: this.nm(this.ir, 2); this.setHL(idx, this.getHL(idx) + 1); break;
      case 0x2b: this.nm(this.ir, 2); this.setHL(idx, this.getHL(idx) - 1); break;
      case 0x24: this.setR(4, this.inc8(this.getR(4, idx)), idx); break;
      case 0x25: this.setR(4, this.dec8(this.getR(4, idx)), idx); break;
      case 0x26: this.setR(4, this.imm8(), idx); break;
      case 0x2c: this.setR(5, this.inc8(this.getR(5, idx)), idx); break;
      case 0x2d: this.setR(5, this.dec8(this.getR(5, idx)), idx); break;
      case 0x2e: this.setR(5, this.imm8(), idx); break;
      case 0x34: case 0x35: {
        const a = this.idxAddr(idx);
        const v = this.rd(a);
        const r = op === 0x34 ? this.inc8(v) : this.dec8(v);
        this.nm(a, 1);
        this.wr(a, r);
        break;
      }
      case 0x36: {
        // LD (IX+d),n: d and n are read, then 2 internal T-states on n's address.
        const d = (this.imm8() << 24) >> 24;
        const at = this.pc;
        const n = this.imm8();
        this.nm(at, 2);
        this.wr(this.wz = (this.getHL(idx) + d) & 0xffff, n);
        break;
      }
      case 0xe1: this.setHL(idx, this.pop16()); break;
      case 0xe5: this.push(this.getHL(idx)); break;
      case 0xe3: this.setHL(idx, this.exSp(this.getHL(idx))); break;
      case 0xe9: this.pc = this.getHL(idx); break;
      case 0xf9: this.nm(this.ir, 2); this.sp = this.getHL(idx); break;
      default: this.execBase(op); break;
    }
  }

  /** The flags after INI/IND/OUTI/OUTD and their repeats. */
  private ioBlockFlags(v: number, k: number): void {
    this.flags((v & 0x80 ? NF : 0) | (k > 0xff ? HF | CF : 0) | PARITY[(k & 7) ^ this.b] | SZ[this.b]);
  }

  private execEd(): void {
    const op = this.fetch();
    switch (op) {
      case 0x40: case 0x48: case 0x50: case 0x58: case 0x60: case 0x68: case 0x70: case 0x78: {
        const bc = this.bc;
        this.wz = (bc + 1) & 0xffff;
        const v = this.inPort(bc);
        this.flags((this.f & CF) | SZP[v]);
        if (op !== 0x70) this.setR((op >> 3) & 7, v);
        break;
      }
      case 0x41: case 0x49: case 0x51: case 0x59: case 0x61: case 0x69: case 0x71: case 0x79: {
        const bc = this.bc;
        this.outPort(bc, op === 0x71 ? 0 : this.getR((op >> 3) & 7)); // OUT (C),r
        this.wz = (bc + 1) & 0xffff;
        break;
      }
      case 0x42: this.sbcHL(this.bc); break;
      case 0x4a: this.adcHL(this.bc); break;
      case 0x52: this.sbcHL(this.de); break;
      case 0x5a: this.adcHL(this.de); break;
      case 0x62: this.sbcHL(this.hl); break;
      case 0x6a: this.adcHL(this.hl); break;
      case 0x72: this.sbcHL(this.sp); break;
      case 0x7a: this.adcHL(this.sp); break;
      case 0x43: case 0x53: case 0x63: case 0x73: {
        const a = this.imm16();
        const v = op === 0x43 ? this.bc : op === 0x53 ? this.de : op === 0x63 ? this.hl : this.sp;
        this.wr16(a, v);
        this.wz = (a + 1) & 0xffff;
        break;
      }
      case 0x4b: case 0x5b: case 0x6b: case 0x7b: {
        const a = this.imm16();
        const v = this.rd16(a);
        this.wz = (a + 1) & 0xffff;
        if (op === 0x4b) this.bc = v; else if (op === 0x5b) this.de = v; else if (op === 0x6b) this.hl = v; else this.sp = v;
        break;
      }
      case 0x44: case 0x4c: case 0x54: case 0x5c: case 0x64: case 0x6c: case 0x74: case 0x7c: {
        const old = this.a;
        this.a = 0;
        this.sub8(old, false);
        break;
      }
      case 0x45: case 0x55: case 0x65: case 0x75: case 0x4d: case 0x5d: case 0x6d: case 0x7d:
        this.iff1 = this.iff2; // RETN / RETI
        this.pc = this.wz = this.pop16();
        break;
      case 0x46: case 0x4e: case 0x66: case 0x6e: this.im = 0; break;
      case 0x56: case 0x76: this.im = 1; break;
      case 0x5e: case 0x7e: this.im = 2; break;
      case 0x47: this.nm(this.ir, 1); this.i = this.a; break;
      case 0x4f: this.nm(this.ir, 1); this.r = this.a; break;
      case 0x57: case 0x5f: {
        this.nm(this.ir, 1);
        const v = op === 0x57 ? this.i : this.r;
        this.a = v;
        this.flags((this.f & CF) | SZ[v] | (this.iff2 ? PF : 0));
        break;
      }
      case 0x67: case 0x6f: { // RRD / RLD
        const hl = this.hl;
        const v = this.rd(hl);
        this.nm(hl, 4);
        const m = op === 0x67 ? ((this.a << 4) & 0xf0) | (v >> 4) : ((v << 4) & 0xf0) | (this.a & 0x0f);
        this.a = (this.a & 0xf0) | (op === 0x67 ? v & 0x0f : v >> 4);
        this.wr(hl, m);
        this.wz = (hl + 1) & 0xffff;
        this.flags((this.f & CF) | SZP[this.a]);
        break;
      }
      case 0xa0: case 0xa8: case 0xb0: case 0xb8: { // LDI / LDD / LDIR / LDDR
        const v = this.rd(this.hl);
        const de = this.de;
        this.wr(de, v);
        this.nm(de, 2);
        const step = op & 8 ? -1 : 1;
        this.hl = (this.hl + step) & 0xffff;
        this.de = (de + step) & 0xffff;
        this.bc = (this.bc - 1) & 0xffff;
        const n = this.a + v;
        this.flags((this.f & (SF | ZF | CF)) | (this.bc ? PF : 0) | (n & XF) | ((n & 0x02) ? YF : 0));
        if (op & 0x10 && this.bc !== 0) {
          this.nm(de, 5);
          this.pc = (this.pc - 2) & 0xffff;
          this.wz = (this.pc + 1) & 0xffff;
        }
        break;
      }
      case 0xa1: case 0xa9: case 0xb1: case 0xb9: { // CPI / CPD / CPIR / CPDR
        const hl = this.hl;
        const v = this.rd(hl);
        this.nm(hl, 5);
        const r = (this.a - v) & 0xff;
        const half = (this.a ^ v ^ r) & HF;
        const n = r - (half ? 1 : 0);
        const step = op & 8 ? -1 : 1;
        this.hl = (hl + step) & 0xffff;
        this.bc = (this.bc - 1) & 0xffff;
        this.flags((this.f & CF) | NF | half | (r & SF) | (r === 0 ? ZF : 0) | (this.bc ? PF : 0) |
          (n & XF) | ((n & 0x02) ? YF : 0));
        if (op & 0x10 && this.bc !== 0 && r !== 0) {
          this.nm(hl, 5);
          this.pc = (this.pc - 2) & 0xffff;
          this.wz = (this.pc + 1) & 0xffff;
        } else this.wz = (this.wz + step) & 0xffff;
        break;
      }
      case 0xa2: case 0xaa: case 0xb2: case 0xba: { // INI / IND / INIR / INDR
        this.nm(this.ir, 1);
        const bc = this.bc;
        const v = this.inPort(bc);
        const hl = this.hl;
        this.wr(hl, v);
        const step = op & 8 ? -1 : 1;
        this.wz = (bc + step) & 0xffff;
        this.b = (this.b - 1) & 0xff;
        this.ioBlockFlags(v, v + ((this.c + step) & 0xff));
        if (op & 0x10 && this.b !== 0) {
          this.nm(hl, 5);
          this.pc = (this.pc - 2) & 0xffff;
        }
        this.hl = (hl + step) & 0xffff;
        break;
      }
      case 0xa3: case 0xab: case 0xb3: case 0xbb: { // OUTI / OUTD / OTIR / OTDR
        this.nm(this.ir, 1);
        const v = this.rd(this.hl);
        this.b = (this.b - 1) & 0xff; // before the port is written
        const step = op & 8 ? -1 : 1;
        this.wz = (this.bc + step) & 0xffff;
        this.outPort(this.bc, v);
        this.hl = (this.hl + step) & 0xffff;
        this.ioBlockFlags(v, v + this.l);
        if (op & 0x10 && this.b !== 0) {
          this.nm(this.bc, 5);
          this.pc = (this.pc - 2) & 0xffff;
        }
        break;
      }
      default:
        break; // undefined ED opcodes behave as NOP
    }
  }

  /** Non-maskable interrupt. */
  nmi(): void {
    if (this.halted) { this.pc = (this.pc + 1) & 0xffff; this.halted = false; }
    this.iff1 = 0;
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7f);
    this.cycles += 5;
    this.push16(this.pc);
    this.pc = this.wz = 0x0066;
    this.q = 0;
  }

  /**
   * Maskable interrupt (mode 0/1/2). Returns false when it is not taken
   * (interrupts disabled, or the instruction after EI has not run yet).
   * The acknowledge cycle takes 7 T-states, then PC is pushed; IM 2 reads
   * the vector at I·256 + data. In IM 0 the data byte is executed: the
   * Spectrum's FFh is RST 38h.
   */
  interrupt(data = 0xff): boolean {
    if (!this.iff1 || this.eiPending) return false;
    if (this.halted) { this.pc = (this.pc + 1) & 0xffff; this.halted = false; }
    this.iff1 = this.iff2 = 0;
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7f);
    this.cycles += 7;
    this.push16(this.pc);
    if (this.im === 2) {
      const addr = (this.i << 8) | (data & 0xff);
      this.pc = this.rd16(addr);
    } else if (this.im === 1 || data === 0xff) {
      this.pc = 0x0038;
    } else {
      this.pc = data & 0x38; // RST n
    }
    this.wz = this.pc;
    this.q = 0;
    return true;
  }

  getState(): Z80State {
    return {
      a: this.a, f: this.f, b: this.b, c: this.c, d: this.d, e: this.e, h: this.h, l: this.l,
      a2: this.a2, f2: this.f2, b2: this.b2, c2: this.c2, d2: this.d2, e2: this.e2, h2: this.h2, l2: this.l2,
      ix: this.ix, iy: this.iy, sp: this.sp, pc: this.pc, i: this.i, r: this.r,
      iff1: this.iff1, iff2: this.iff2, im: this.im, halted: this.halted,
    };
  }
}
