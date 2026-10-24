import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Z80 } from '../src/z80';

/**
 * FUSE's Z80 core tests (tests/fixtures/fuse): every instruction, with
 * the exact T-state of every memory and port access. The harness logs the
 * same events as FUSE's coretest.c: an MC for every machine cycle's
 * contention point, MR/MW for the data, and for I/O the port contention
 * points (page 4000h-7FFFh contended, the ULA on even ports) around PR/PW.
 */

const fixture = (name: string) => readFileSync(new URL(`./fixtures/fuse/${name}`, import.meta.url), 'utf8');

class Traced extends Z80 {
  log: string[] = [];
  private ev(type: string, addr: number, data?: number) {
    const t = String(this.cycles).padStart(5);
    const a = addr.toString(16).padStart(4, '0');
    this.log.push(data === undefined ? `${t} ${type} ${a}` : `${t} ${type} ${a} ${data.toString(16).padStart(2, '0')}`);
  }
  protected override mc(addr: number, t: number): void {
    this.ev('MC', addr);
    this.cycles += t;
  }
  protected override ioPre(port: number): void {
    if ((port & 0xc000) === 0x4000) this.ev('PC', port);
    this.cycles += 1;
  }
  protected override ioPost(port: number): void {
    if (port & 1) {
      if ((port & 0xc000) === 0x4000) for (let k = 0; k < 3; k++) { this.ev('PC', port); this.cycles += 1; }
      else this.cycles += 3;
    } else { this.ev('PC', port); this.cycles += 3; }
  }
  constructor() {
    super();
    this.read = (a) => { const v = this.mem[a]; this.ev('MR', a, v); return v; };
    this.write = (a, v) => { this.ev('MW', a, v); this.mem[a] = v; };
    this.portIn = (p) => { const v = p >> 8; this.ev('PR', p, v); return v; };
    this.portOut = (p, v) => this.ev('PW', p, v);
  }
}

interface Case { name: string; regs: number[]; misc: number[]; mem: [number, number[]][] }

function parseIn(text: string): Case[] {
  const lines = text.split('\n');
  const cases: Case[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const name = lines[i++].trim();
    const regs = lines[i++].trim().split(/\s+/).map((x) => parseInt(x, 16));
    const m = lines[i++].trim().split(/\s+/);
    const misc = [parseInt(m[0], 16), parseInt(m[1], 16), ...m.slice(2).map(Number)];
    const mem: [number, number[]][] = [];
    for (;;) {
      const parts = lines[i++].trim().split(/\s+/);
      if (parts[0] === '-1') break;
      const bytes: number[] = [];
      for (const p of parts.slice(1)) { if (p === '-1') break; bytes.push(parseInt(p, 16)); }
      mem.push([parseInt(parts[0], 16), bytes]);
    }
    cases.push({ name, regs, misc, mem });
  }
  return cases;
}

/** The expected output of each test, as text, keyed by name. */
function parseExpected(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((l) => l.length);
    if (lines.length) out.set(lines[0].trim(), lines.slice(1));
  }
  return out;
}

const hex = (v: number, n: number) => v.toString(16).padStart(n, '0');

function run(c: Case): string[] {
  const z = new Traced();
  for (let a = 0; a < 0x10000; a += 4) z.mem.set([0xde, 0xad, 0xbe, 0xef], a);
  for (const [addr, bytes] of c.mem) z.mem.set(bytes, addr);
  const initial = z.mem.slice();
  const [af, bc, de, hl, af2, bc2, de2, hl2, ix, iy, sp, pc, wz] = c.regs;
  z.af = af; z.bc = bc; z.de = de; z.hl = hl;
  z.a2 = af2 >> 8; z.f2 = af2 & 0xff; z.b2 = bc2 >> 8; z.c2 = bc2 & 0xff;
  z.d2 = de2 >> 8; z.e2 = de2 & 0xff; z.h2 = hl2 >> 8; z.l2 = hl2 & 0xff;
  z.ix = ix; z.iy = iy; z.sp = sp; z.pc = pc; z.wz = wz;
  const [i, r, iff1, iff2, im, halted, tstates] = c.misc;
  z.i = i; z.r = r; z.iff1 = iff1; z.iff2 = iff2; z.im = im; z.halted = halted !== 0;
  z.cycles = 0;
  while (z.cycles < tstates) z.step();
  const out = [...z.log];
  out.push([z.af, z.bc, z.de, z.hl, (z.a2 << 8) | z.f2, (z.b2 << 8) | z.c2, (z.d2 << 8) | z.e2,
    (z.h2 << 8) | z.l2, z.ix, z.iy, z.sp, z.pc, z.wz].map((v) => hex(v, 4)).join(' '));
  out.push(`${hex(z.i, 2)} ${hex(z.r, 2)} ${z.iff1} ${z.iff2} ${z.im} ${z.halted ? 1 : 0} ${z.cycles}`);
  // Changed memory, in runs, as FUSE prints it.
  for (let a = 0; a < 0x10000;) {
    if (z.mem[a] === initial[a]) { a++; continue; }
    let line = `${hex(a, 4)} `;
    while (a < 0x10000 && z.mem[a] !== initial[a]) line += `${hex(z.mem[a++], 2)} `;
    out.push(line + '-1');
  }
  return out;
}

describe('FUSE Z80 core tests', () => {
  const cases = parseIn(fixture('tests.in'));
  const expected = parseExpected(fixture('tests.expected'));

  it('has all the tests', () => {
    expect(cases.length).toBeGreaterThan(1300);
    expect(cases.every((c) => expected.has(c.name))).toBe(true);
  });

  it('matches every register, memory change and timed bus event', () => {
    const failures: string[] = [];
    for (const c of cases) {
      const got = run(c);
      const want = expected.get(c.name)!.map((l) => l.trimEnd());
      if (got.join('\n') !== want.join('\n')) failures.push(c.name);
    }
    if (failures.length) {
      // Each failure, from its first differing line.
      const report = failures.slice(0, 20).map((n) => {
        const got = run(cases.find((c) => c.name === n)!);
        const want = expected.get(n)!.map((l) => l.trimEnd());
        const k = got.findIndex((l, j) => l !== want[j]);
        return `${n}:\n  want ${want.slice(k, k + 3).join(' / ')}\n  got  ${got.slice(k, k + 3).join(' / ')}`;
      });
      throw new Error(`${failures.length} failing\n${report.join('\n')}`);
    }
  });
});
