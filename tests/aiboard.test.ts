// The AI board end to end with a fake DeepSeek: key prompt, chat, and
// programs in BASIC and Z80 whose first versions fail, get fixed, arrive as
// tapes and run on a Spectrum.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Spectrum } from '../src/zx/machine';
import { parseTap } from '../src/zx/tape';
import {
  BASIC_PROMPT, BOFH_PICKUP, LiveView, MAX_HISTORY_CHARS, Z80_PROMPT, createAiBoard, trimHistory,
} from '../src/ai/aiboard';
import { checkBasic, checkZ80 } from '../src/ai/check';
import type { ChatOptions, ChatChunk } from '../src/ai/deepseek';

const rom48 = new Uint8Array(readFileSync(new URL('../src/roms/48k.rom', import.meta.url)));

const BAD_BASIC = '```basic\n10 PRINT "HELLO"\n20 PRINT x\n```';
const GOOD_BASIC = '10 PRINT "HELLO FROM THE AI BOARD"\n20 STOP';
const BAD_Z80 = 'ORG 32768\n lod a,2\n ret';
const GOOD_Z80 = [
  'ORG 32768',
  'start: ld a,2',
  ' call 1601h',
  ' ld hl,msg',
  'loop: ld a,(hl)',
  ' or a',
  ' ret z',
  ' rst 10h',
  ' inc hl',
  ' jr loop',
  'msg: db "Z80 SAYS HI",0',
].join('\n');

function setup(initialKey: string | null) {
  const zx = new Spectrum(rom48);
  let key = initialKey;
  const calls: ChatOptions[] = [];
  const answers: ChatChunk[][] = [];
  const tapes: { name: string; tap: Uint8Array }[] = [];
  zx.modem.speaker = 0;
  zx.modem.dialer = (_t, handlers) => createAiBoard(handlers, {
    getKey: () => key,
    setKey: (k) => { key = k; },
    chat: (opts) => {
      calls.push(opts);
      const reply = answers.shift() ?? [{ kind: 'text', text: '(no answer)' }];
      return (async function* () { for (const c of reply) yield c; })();
    },
    check: (lang, name, source) => (lang === 'basic' ? checkBasic(rom48, name, source) : checkZ80(rom48, name, source)),
    deliver: (name, tap) => { tapes.push({ name, tap }); },
    schedule: (fn) => { setTimeout(fn, 0); },
    cps: 0,
  });
  let screen = '';
  const drain = () => { while (zx.modem.available) screen += String.fromCharCode(zx.modem.read()); return screen; };
  const type = (s: string) => { for (const c of s) zx.modem.write(c.charCodeAt(0)); };
  const waitFor = async (text: string) => {
    for (let i = 0; i < 2000; i++) {
      if (drain().includes(text)) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timed out waiting for ${JSON.stringify(text)}; screen:\n${screen}`);
  };
  return { zx, type, waitFor, calls, answers, tapes, getKey: () => key, screen: () => drain() };
}

/** Loads a delivered tape on a fresh 48K and returns its screen after it ran. */
function runTape(tap: Uint8Array): string {
  const zx = new Spectrum(rom48);
  zx.tape = parseTap('t.tap', tap);
  zx.typeLoad();
  for (let i = 0; i < 5000 && zx.busyTyping; i++) zx.runFrame();
  for (let i = 0; i < 100; i++) zx.runFrame();
  return zx.screenText().join('\n');
}

describe('AI board', () => {
  it('asks for the key while the call is up, then chats, 62 columns wide', async () => {
    const b = setup(null);
    b.type('ATDT AI\r');
    await b.waitFor('CONNECT AI');
    await b.waitFor('Key: ');
    expect(b.screen()).toContain('K-PROMPT AI BOARD');
    b.type('sk-test-123456\r');
    await b.waitFor('Choice: ');
    expect(b.getKey()).toBe('sk-test-123456');
    expect(b.screen()).toContain('**************'); // the key is not echoed
    expect(b.screen()).toContain('sk-...3456');
    expect(b.screen()).not.toContain('[F]'); // no uploads: there is no ZMODEM on a Spectrum

    b.answers.push([{ kind: 'text', text: 'word '.repeat(40) }]);
    b.type('C');
    await b.waitFor('You> ');
    b.type('hello\r');
    await b.waitFor('AI> word');
    await b.waitFor('You> ');
    expect(b.calls[0].messages[0].content).toContain('ZX Spectrum');
    for (const line of b.screen().split('\r\n')) expect(line.length).toBeLessThanOrEqual(62);
    b.type('/menu\r');
    await b.waitFor('[G] Goodbye');
    b.type('G');
    await b.waitFor('NO CARRIER');
  });

  it('hangs up when no key is given, and DEEPSEEK dials it too', async () => {
    const b = setup(null);
    b.type('ATDT DEEPSEEK\r');
    await b.waitFor('Key: ');
    b.type('\r');
    await b.waitFor('No key, no call.');
    await b.waitFor('NO CARRIER');
  });

  it('puts you through to the BOFH, who may hang up on you', async () => {
    const b = setup('sk-test');
    b.type('ATDT DEEPSEEK\r');
    await b.waitFor('Choice: ');
    expect(b.screen()).toContain('[B] Chat with the Bastard Operator From Hell');
    b.answers.push([{ kind: 'text', text: '(click) Machine room. What.' }]);
    b.answers.push([{ kind: 'text', text: 'Your password? Of course. Spell it slowly.' }]);
    b.answers.push([
      { kind: 'text', text: 'Solar flares on your RS-232 line. Goodbye.\n[HAN' },
      { kind: 'text', text: 'GUP]' },
    ]);
    b.type('B');
    // He picks up before the caller says anything.
    await b.waitFor('BOFH> (click) Machine room. What.');
    expect(b.calls[0].messages[0].content).toContain('Bastard Operator From Hell');
    expect(b.calls[0].messages[0].content).toContain('PFY');
    expect(b.calls[0].messages.at(-1)).toEqual({ role: 'user', content: BOFH_PICKUP });
    await b.waitFor('You> ');
    b.type('I forgot my password\r');
    await b.waitFor('BOFH> Your password? Of course. Spell it slowly.');
    b.type('it still does not work\r');
    await b.waitFor('NO CARRIER');
    const screen = b.screen();
    expect(screen).toContain('BOFH> Solar flares on your RS-232 line. Goodbye.');
    expect(screen).toContain('*click*');
    expect(screen).not.toContain('HANGUP');
    expect(screen).not.toContain('[HAN');
    expect(b.zx.modem.online).toBe(false);
  });

  it('the friendly sysop cannot hang up, and has a separate history', async () => {
    const b = setup('sk-test');
    b.type('ATDT DEEPSEEK\r');
    await b.waitFor('Choice: ');
    b.answers.push([{ kind: 'text', text: 'Grr.' }]);
    b.answers.push([{ kind: 'text', text: 'Hello! [HANGUP] is just text here.' }]);
    b.type('B');
    await b.waitFor('BOFH> Grr.');
    await b.waitFor('You> ');
    b.type('/menu\r');
    await b.waitFor('[G] Goodbye');
    b.type('C');
    await b.waitFor('Chat mode');
    b.type('hello\r');
    await b.waitFor('AI> Hello! [HANGUP] is just text here.');
    expect(b.zx.modem.online).toBe(true);
    expect(b.calls.length).toBe(2);
    expect(b.calls[1].messages).toEqual([
      expect.objectContaining({ role: 'system' }),
      { role: 'user', content: 'hello' },
    ]);
  });

  it('writes a BASIC program, sends the ROM\'s error report back, and delivers a tape that runs', async () => {
    const b = setup('sk-test');
    b.type('ATDT AI\r');
    await b.waitFor('Choice: ');
    b.answers.push([{ kind: 'thinking', text: 'plan' }, { kind: 'text', text: BAD_BASIC }]);
    b.answers.push([{ kind: 'text', text: GOOD_BASIC }]);
    b.type('P');
    await b.waitFor('Program: ');
    b.type('say hello\r');
    await b.waitFor('[B/M]');
    b.type('B');
    await b.waitFor('name for the tape');
    b.type('hello\r');
    await b.waitFor('Change: ');
    expect(b.screen()).toContain('2 Variable not found, 20:1');
    expect(b.screen()).toContain('Sending them back for a fix (try 2 of 3)');
    expect(b.screen()).toContain('[DeepSeek is thinking]\r\n  plan');
    expect(b.screen()).toContain('[DeepSeek is writing hello]');
    expect(b.screen()).toContain('The tape hello is in your deck');
    expect(b.calls[0].messages[0]).toEqual({ role: 'system', content: BASIC_PROMPT });
    expect(b.calls[1].messages.at(-1)!.content).toMatch(/^The Spectrum stopped with these reports:\n2 Variable not found/);
    expect(b.tapes.map((t) => t.name)).toEqual(['hello']);
    expect(runTape(b.tapes[0].tap)).toContain('HELLO FROM THE AI BOARD');
  }, 30_000);

  it('writes Z80, sends the assembler\'s error back, and delivers a tape that runs', async () => {
    const b = setup('sk-test');
    b.type('ATDT AI\r');
    await b.waitFor('Choice: ');
    b.answers.push([{ kind: 'text', text: BAD_Z80 }]);
    b.answers.push([{ kind: 'text', text: GOOD_Z80 }]);
    b.type('P');
    await b.waitFor('Program: ');
    b.type('say hi in machine code\r');
    await b.waitFor('[B/M]');
    b.type('m');
    await b.waitFor('name for the tape');
    b.type('hi\r');
    await b.waitFor('Change: ');
    expect(b.calls[0].messages[0]).toEqual({ role: 'system', content: Z80_PROMPT });
    expect(b.calls[1].messages.at(-1)!.content).toContain('line 2: unknown instruction LOD');
    expect(runTape(b.tapes[0].tap)).toContain('Z80 SAYS HI');
  }, 30_000);

  it('takes more changes after a delivery, with the whole conversation, until Enter', async () => {
    const b = setup('sk-test');
    b.type('ATDT AI\r');
    await b.waitFor('Choice: ');
    b.answers.push([{ kind: 'text', text: GOOD_BASIC }]);
    b.type('P');
    await b.waitFor('Program: ');
    b.type('say hello\r');
    await b.waitFor('[B/M]');
    b.type('B');
    await b.waitFor('name for the tape');
    b.type('hello\r');
    await b.waitFor('Change: ');
    expect(b.screen()).toContain('More changes to hello?');
    b.answers.push([{ kind: 'text', text: GOOD_BASIC.replace('HELLO FROM', 'GOODBYE FROM') }]);
    b.type('say goodbye\r');
    await b.waitFor('Writing');
    for (let i = 0; i < 400 && b.tapes.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    const second = b.calls[1].messages;
    expect(second[1].content).toContain('say hello');
    expect(second[2].role).toBe('assistant');
    expect(second[3].content).toContain('asks for more: say goodbye');
    expect(runTape(b.tapes[1].tap)).toContain('GOODBYE FROM THE AI BOARD');
    b.type('\r');
    await b.waitFor('Choice: ');
  }, 30_000);

  it('treats an answer with no program (all thinking) as a failed try', async () => {
    const b = setup('sk-test');
    b.type('ATDT AI\r');
    await b.waitFor('Choice: ');
    b.answers.push([{ kind: 'thinking', text: 'a very long think' }]);
    b.answers.push([{ kind: 'text', text: GOOD_BASIC }]);
    b.type('P');
    await b.waitFor('Program: ');
    b.type('say hello\r');
    await b.waitFor('[B/M]');
    b.type('B');
    await b.waitFor('name for the tape');
    b.type('hello\r');
    await b.waitFor('Change: ');
    expect(b.screen()).toContain('No listing came back');
    expect(b.tapes.length).toBe(1);
  }, 30_000);

  it('keeps a long session within the history limit, latest source last', () => {
    const big = 'x'.repeat(60_000);
    const msgs = [
      { role: 'system' as const, content: 'rules' },
      { role: 'user' as const, content: 'write it' },
      ...Array.from({ length: 6 }, (_, i) => [
        { role: 'assistant' as const, content: `${i}${big}` },
        { role: 'user' as const, content: `change ${i}` },
      ]).flat(),
    ];
    trimHistory(msgs);
    expect(msgs.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(MAX_HISTORY_CHARS);
    expect(msgs[0].content).toBe('rules');
    expect(msgs[1].content).toBe('write it');
    expect(msgs.at(-1)!.content).toBe('change 5');
    expect(msgs.at(-2)!.content.startsWith('5')).toBe(true);
  });

});

describe('live view of a build', () => {
  const view = (backlog: () => number) => {
    let out = '';
    const v = new LiveView((t) => { out += t; }, backlog, 100, { thinking: '[thinking]', text: '[writing X.ASM]' });
    return { v, out: () => out };
  };

  it('indents and word-wraps the reasoning, then shows the source with tabs expanded', () => {
    const { v, out } = view(() => 0);
    v.push('thinking', 'word '.repeat(30));
    v.push('text', '\tORG\t100H\nSTART:\tRET\n');
    v.end();
    const lines = out().split('\r\n');
    expect(lines[1]).toBe('[thinking]');
    expect(lines[2].startsWith('  word word')).toBe(true);
    expect(lines[3].startsWith('  word')).toBe(true);
    expect(lines.every((l) => l.length <= 62)).toBe(true);
    expect(out()).toContain('[writing X.ASM]\r\n        ORG     100H\r\nSTART:  RET\r\n');
  });

  it('skips ahead when the line falls behind, and resumes at a line of source', () => {
    let backlog = 0;
    const { v, out } = view(() => backlog);
    v.push('text', 'LINE1\n');
    backlog = 500; // the 2400 baud line is behind
    v.push('text', 'LINE2\nLINE3\n');
    backlog = 0;
    v.push('text', 'E4\nLINE5\n');
    expect(out()).toContain('LINE1\r\n');
    expect(out()).not.toContain('LINE2');
    expect(out()).not.toContain('E4');
    expect(out()).toContain('  ...\r\nLINE5\r\n');
  });

  it('finishes the sentence it is on before skipping, and marks a skipped end', () => {
    let backlog = 0;
    const { v, out } = view(() => backlog);
    v.push('thinking', 'First idea is ');
    backlog = 500;
    v.push('thinking', 'good. Second idea is hidden. ');
    v.end();
    expect(out()).toContain('First idea is good.');
    expect(out()).not.toContain('Second');
    expect(out()).toMatch(/good\. +\.\.\./);
  });
});
