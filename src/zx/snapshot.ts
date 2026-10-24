/**
 * Snapshots: the whole 48K machine at one moment, as the emulators of the
 * 1990s saved it.
 *
 * `.sna`: a 27-byte header (I, HL', DE', BC', AF', HL, DE, BC, IY, IX,
 * IFF2 in bit 2, R, AF, SP, IM, border) and the 48K of RAM; PC is on the
 * stack, so loading does a RETN.
 *
 * `.z80`: a 30-byte header (A, F, BC, HL, PC, SP, I, R, a flags byte with
 * R's bit 7, the border and "compressed", DE, the alternate set, IY, IX,
 * IFF1, IFF2, IM). PC = 0 means version 2 or 3: an extra header gives the
 * PC and the hardware, then the RAM as 16K pages (8 = 4000h, 4 = 8000h,
 * 5 = C000h on a 48K), each optionally compressed with ED ED count byte.
 */
import type { Spectrum } from './machine';

export function isSnapshot(name: string): boolean {
  return /\.(z80|sna)$/i.test(name);
}

export function loadSnapshot(zx: Spectrum, name: string, bytes: Uint8Array): void {
  if (/\.sna$/i.test(name)) loadSna(zx, bytes);
  else loadZ80(zx, bytes);
}

const w = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);

function loadSna(zx: Spectrum, b: Uint8Array): void {
  if (b.length !== 27 + 49152) throw new Error('this .sna is not a 48K snapshot');
  const cpu = zx.cpu;
  zx.reset();
  cpu.i = b[0];
  setPair(cpu, 'h2', 'l2', w(b, 1)); setPair(cpu, 'd2', 'e2', w(b, 3));
  setPair(cpu, 'b2', 'c2', w(b, 5)); setPair(cpu, 'a2', 'f2', w(b, 7));
  cpu.hl = w(b, 9); cpu.de = w(b, 11); cpu.bc = w(b, 13);
  cpu.iy = w(b, 15); cpu.ix = w(b, 17);
  cpu.iff1 = cpu.iff2 = b[19] & 4 ? 1 : 0;
  cpu.r = b[20];
  cpu.af = w(b, 21);
  cpu.sp = w(b, 23);
  cpu.im = b[25] & 3;
  zx.setBorder(b[26]);
  zx.mem.set(b.subarray(27), 0x4000);
  // RETN: PC from the stack.
  cpu.pc = zx.mem[cpu.sp] | (zx.mem[(cpu.sp + 1) & 0xffff] << 8);
  cpu.sp = (cpu.sp + 2) & 0xffff;
}

export function saveSna(zx: Spectrum): Uint8Array {
  const cpu = zx.cpu;
  const out = new Uint8Array(27 + 49152);
  // Push PC, as the format wants it on the stack.
  const sp = (cpu.sp - 2) & 0xffff;
  const mem = zx.mem.slice();
  mem[sp] = cpu.pc & 0xff;
  mem[(sp + 1) & 0xffff] = cpu.pc >> 8;
  const put = (i: number, v: number) => { out[i] = v & 0xff; out[i + 1] = (v >> 8) & 0xff; };
  out[0] = cpu.i;
  put(1, (cpu.h2 << 8) | cpu.l2); put(3, (cpu.d2 << 8) | cpu.e2);
  put(5, (cpu.b2 << 8) | cpu.c2); put(7, (cpu.a2 << 8) | cpu.f2);
  put(9, cpu.hl); put(11, cpu.de); put(13, cpu.bc); put(15, cpu.iy); put(17, cpu.ix);
  out[19] = cpu.iff2 ? 4 : 0;
  out[20] = cpu.r;
  put(21, cpu.af);
  put(23, sp);
  out[25] = cpu.im;
  out[26] = zx.ula.border;
  out.set(mem.subarray(0x4000), 27);
  return out;
}

type Reg = 'a2' | 'f2' | 'b2' | 'c2' | 'd2' | 'e2' | 'h2' | 'l2';
function setPair(cpu: Spectrum['cpu'], hi: Reg, lo: Reg, v: number): void {
  cpu[hi] = v >> 8;
  cpu[lo] = v & 0xff;
}

/** Expands ED ED count byte runs into `out` from `b[from..to)`; returns bytes written. */
function expand(b: Uint8Array, from: number, to: number, out: Uint8Array, at: number, limit: number): number {
  let o = at;
  for (let i = from; i < to && o < at + limit;) {
    if (b[i] === 0xed && b[i + 1] === 0xed && i + 3 < to) {
      const n = b[i + 2], v = b[i + 3];
      for (let k = 0; k < n && o < at + limit; k++) out[o++] = v;
      i += 4;
    } else out[o++] = b[i++];
  }
  return o - at;
}

function loadZ80(zx: Spectrum, b: Uint8Array): void {
  if (b.length < 30) throw new Error('this .z80 file is too short');
  const cpu = zx.cpu;
  let pc = w(b, 6);
  let flags = b[12];
  if (flags === 0xff) flags = 1; // as the format notes say
  const mem = new Uint8Array(0x10000);
  if (pc !== 0) {
    // Version 1: 48K only, compressed if bit 5, ending with 00 ED ED 00.
    if (flags & 0x20) {
      let end = b.length;
      if (b[end - 4] === 0 && b[end - 3] === 0xed && b[end - 2] === 0xed && b[end - 1] === 0) end -= 4;
      expand(b, 30, end, mem, 0x4000, 49152);
    } else mem.set(b.subarray(30, 30 + 49152), 0x4000);
  } else {
    const extra = w(b, 30);
    pc = w(b, 32);
    const hw = b[34];
    const v2 = extra === 23;
    const is48 = v2 ? hw <= 1 : hw <= 1 || hw === 3;
    if (!is48) throw new Error('this snapshot is for a 128K or another machine; K-Prompt is a 48K');
    let i = 32 + extra;
    const where: Record<number, number> = { 8: 0x4000, 4: 0x8000, 5: 0xc000 };
    while (i + 3 <= b.length) {
      const len = w(b, i), page = b[i + 2];
      i += 3;
      const at = where[page];
      const size = len === 0xffff ? 0x4000 : len;
      if (at !== undefined) {
        if (len === 0xffff) mem.set(b.subarray(i, i + 0x4000), at);
        else expand(b, i, i + len, mem, at, 0x4000);
      }
      i += size;
    }
  }
  zx.reset();
  zx.mem.set(mem.subarray(0x4000), 0x4000);
  cpu.a = b[0]; cpu.f = b[1];
  cpu.bc = w(b, 2); cpu.hl = w(b, 4); cpu.pc = pc; cpu.sp = w(b, 8);
  cpu.i = b[10];
  cpu.r = (b[11] & 0x7f) | ((flags & 1) << 7);
  zx.setBorder((flags >> 1) & 7);
  cpu.de = w(b, 13);
  setPair(cpu, 'b2', 'c2', w(b, 15)); setPair(cpu, 'd2', 'e2', w(b, 17)); setPair(cpu, 'h2', 'l2', w(b, 19));
  cpu.a2 = b[21]; cpu.f2 = b[22];
  cpu.iy = w(b, 23); cpu.ix = w(b, 25);
  cpu.iff1 = b[27] ? 1 : 0;
  cpu.iff2 = b[28] ? 1 : 0;
  cpu.im = b[29] & 3;
}

/** A version 3 .z80 of the 48K machine, pages uncompressed. */
export function saveZ80(zx: Spectrum): Uint8Array {
  const cpu = zx.cpu;
  const head = new Uint8Array(30 + 2 + 54);
  const put = (i: number, v: number) => { head[i] = v & 0xff; head[i + 1] = (v >> 8) & 0xff; };
  head[0] = cpu.a; head[1] = cpu.f; put(2, cpu.bc); put(4, cpu.hl); put(6, 0); put(8, cpu.sp);
  head[10] = cpu.i; head[11] = cpu.r & 0x7f;
  head[12] = ((cpu.r >> 7) & 1) | (zx.ula.border << 1);
  put(13, cpu.de);
  put(15, (cpu.b2 << 8) | cpu.c2); put(17, (cpu.d2 << 8) | cpu.e2); put(19, (cpu.h2 << 8) | cpu.l2);
  head[21] = cpu.a2; head[22] = cpu.f2;
  put(23, cpu.iy); put(25, cpu.ix);
  head[27] = cpu.iff1; head[28] = cpu.iff2; head[29] = cpu.im;
  put(30, 54); put(32, cpu.pc); head[34] = 0;
  const out = new Uint8Array(head.length + 3 * (3 + 0x4000));
  out.set(head);
  let o = head.length;
  for (const [page, at] of [[8, 0x4000], [4, 0x8000], [5, 0xc000]]) {
    out[o] = 0xff; out[o + 1] = 0xff; out[o + 2] = page;
    out.set(zx.mem.subarray(at, at + 0x4000), o + 3);
    o += 3 + 0x4000;
  }
  return out;
}
