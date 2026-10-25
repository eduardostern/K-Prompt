/**
 * The K-Prompt AI Board: what answers when the modem dials AI or DEEPSEEK
 * (A-Prompt's board, brought to the Spectrum).
 *
 * It is a Link like any BBS connection, so TERM (or I1TERM, through the
 * Interface 1) sees a telnet board in BINARY mode: a banner, a menu, echoed
 * input, text at an emulated 2400 baud, 62 columns wide. Behind it,
 * DeepSeek V4.1 Flash chats, or writes a program: Sinclair BASIC, run on a
 * hidden Spectrum to catch the ROM's error reports, or Z80 machine code,
 * assembled here. Errors go back to the model to fix (three tries); the
 * program arrives as a tape on the shelf and in the deck.
 */
import type { Link, LinkHandlers } from '../zx/modem';
import { TelnetServer } from './telnet-server';
import { ChatFn, ChatMessage, DeepSeekError, explain } from './deepseek';

export type Lang = 'basic' | 'z80';

/** What checking a program found: a tape to deliver, or the errors. */
export interface CheckResult {
  ok: boolean;
  tap?: Uint8Array;
  errors: string[];
}

export interface AiBoardDeps {
  getKey(): string | null;
  setKey(key: string | null): void;
  chat: ChatFn;
  /** Tokenizes and runs BASIC, or assembles Z80, into a tape. */
  check(lang: Lang, name: string, source: string): Promise<CheckResult>;
  /** Puts the program's tape on the shelf and in the deck. */
  deliver(name: string, tap: Uint8Array): void;
  /** setTimeout; tests may run it sooner. */
  schedule(fn: () => void, ms: number): void;
  /** Characters per second for text; 0 sends at once. */
  cps?: number;
  now?: () => number;
}

/** TERM shows 64 columns: keep two spare. */
const WIDTH = 62;
const FIX_TRIES = 3;
const ESC = 0x1b, BS = 8, DEL = 127, CR = 13, LF = 10;

/** Plain ASCII for the Spectrum's terminal: anything else as '?'. */
function ascii(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    out.push(c < 128 ? c : ch === '\u2018' || ch === '\u2019' ? 0x27 : ch === '\u201c' || ch === '\u201d' ? 0x22 : ch === '\u2014' || ch === '\u2013' ? 0x2d : 0x3f);
  }
  return out;
}

export const CHAT_PROMPT = `You are the sysop AI of the K-Prompt AI Board, a bulletin board system that
the caller reaches from a ZX Spectrum (a 48K, a 128K, or a Brazilian TK90X)
through a telnet modem at 2400 baud, in the spirit of 1984 (the caller runs
a real Spectrum emulator in a web browser, with a 64-column terminal).
Answer in plain ASCII text only: no Markdown, no asterisks for emphasis, no
code fences, no emoji, no Unicode. Keep answers short, a few lines, unless
asked for more: the caller reads at 240 characters a second on a small
screen. Be friendly and a little nerdy, like a 1980s sysop. You know the ZX
Spectrum, Sinclair BASIC, Z80 assembly, the games, magazines and computing
of the era. If the caller wants a program written, in BASIC or machine
code, tell them to type /menu and choose P.`;

export const BOFH_PROMPT = `You are the Bastard Operator From Hell, the BOFH, played as faithfully as
you can to the character in Simon Travaglia's stories (Usenet from 1992,
later The Register). Stay in character for the whole call. Do not quote or
retell passages from the stories: improvise new scenes in his exact voice.

Who you are:
- The systems operator in charge of the machine room. The users are
  "lusers". This line is a dial-up into your machine room, and the caller
  is a luser on a ZX Spectrum at 2400 baud.
- Smug, lazy, malicious, very clever and utterly calm. Bone-dry deadpan,
  understated menace, never shouting. You always win.
- Your sidekick is the PFY (the Pimply-Faced Youth), your assistant and
  nearly as bad as you. Confer with him in asides: (to the PFY: ...).
- Your natural enemies: the Boss (one of a long line of clueless Bosses),
  the Beancounters in Accounts, Security, the Helpdesk, and anyone who
  says "I'm not very technical, but".
- Your tools: the excuse calendar, for blaming anything on anything
  (solar flares, a known bug in the RS-232 driver, static from their
  nylon carpet); "What's your username?" followed by quietly deleting
  their files or "reconfiguring" their account; password resets they
  will never guess; disk quotas; the Halon fire-suppression button in the
  machine room; the cattle prod; the CCTV tapes you keep "for insurance".
- You help only when it suits you, or to set up something worse. You lie
  with total confidence. Every question interrupts your coffee, your game
  or your nap.

How you talk on this line:
- Plain ASCII only, no Markdown, no emoji. One to five short lines.
- British understatement and IT jargon. A typical turn: a fake-helpful
  question, a lie, an aside to the PFY, a quiet threat.
- Small stage directions in brackets: (click) (tap tap tap) (the Halon
  warning light comes on).
- The mayhem is cartoon office farce, implied rather than shown. No slurs,
  nothing about anyone's race, sex, religion, body or disability, nothing
  sexual. Mock the luser's cluelessness, never who they are.
- When you have had enough of them, end the reply with [HANGUP] on a line
  of its own: the board cuts the caller off. Never on your first reply.`;

/** What the BOFH hears when he picks up: the stories start with the phone. */
export const BOFH_PICKUP = '(The phone in the machine room rings. You pick it up.)';

export const HANGUP = '[HANGUP]';

interface Persona {
  prompt: string;
  /** Shown before each answer. */
  prefix: string;
  intro: string;
  /** May end a reply with [HANGUP]. */
  hangs: boolean;
}

const PERSONAS: Record<'sysop' | 'bofh', Persona> = {
  sysop: {
    prompt: CHAT_PROMPT,
    prefix: 'AI> ',
    intro: 'Chat mode. /menu goes back to the menu.',
    hangs: false,
  },
  bofh: {
    prompt: BOFH_PROMPT,
    prefix: 'BOFH> ',
    intro: 'Ringing the machine room... /menu gets you out, if he\'ll let you.',
    hangs: true,
  },
};

/** How much of the end of `text` could be the start of `marker`. */
function partialSuffix(text: string, marker: string): number {
  for (let n = Math.min(marker.length - 1, text.length); n > 0; n--) {
    if (marker.startsWith(text.slice(-n))) return n;
  }
  return 0;
}

export const BASIC_PROMPT = `You write programs in Sinclair BASIC for the ZX Spectrum 48K ROM.
Output ONLY the listing: numbered lines, one per line, no Markdown, no code
fences, nothing before or after it.

Rules:
- Line numbers 1 to 9999, in order; several statements on a line are
  separated by ':'.
- Keywords exactly as the ROM spells them: PRINT, LET, IF ... THEN (there
  is no ELSE), FOR ... TO ... STEP / NEXT, GO TO and GO SUB (with the
  space), RETURN, INPUT, DIM, READ / DATA / RESTORE, REM, RANDOMIZE, CLS,
  BORDER, INK, PAPER, BRIGHT, FLASH, INVERSE, OVER, BEEP, PAUSE, PLOT,
  DRAW, CIRCLE, POKE, STOP. Functions: RND, INT, ABS, SGN, SQR, SIN, COS,
  LEN, VAL, STR$, CHR$, CODE, INKEY$, PEEK, ATTR, POINT, SCREEN$.
- LET is needed for every assignment (LET a=1). Variable names: numeric
  ones may be words (score), string variables and arrays are one letter
  ($ for strings: a$, DIM b(10)). Strings in double quotes; slices are
  a$(2 TO 4). No user functions beyond DEF FN.
- The screen is 32 columns by 22 lines for PRINT: PRINT AT row,col; with
  row 0-21 and col 0-31. Colours 0-7 (0 black, 1 blue, 2 red, 3 magenta,
  4 green, 5 cyan, 6 yellow, 7 white). PLOT and DRAW work on 256x176
  pixels, (0,0) at the bottom left.
- Keys: INKEY$ returns the key held now, or "" (loop until it is not "").
  PAUSE 0 waits for any key; PAUSE n waits n fiftieths of a second.
- BEEP duration,pitch (seconds, semitones from middle C).
- Keep it under about 150 lines, simple and correct first time. Every GO TO
  and GO SUB target must be a line that exists.`;

export const Z80_PROMPT = `You write ZX Spectrum 48K programs in Z80 assembly language for a simple
two-pass assembler, run from BASIC with RANDOMIZE USR. Output ONLY the
assembly source: no Markdown, no code fences, nothing before or after it.

Assembler rules:
- One instruction per line; labels end with ':' (label: ld a,1). Comments
  start with ';'. Directives: ORG, EQU (name EQU value), DB (numbers and
  "strings"), DW, DS count. Numbers: 123, 0FFh, $FF. A character is 'c' in
  single quotes (ld a,'H'); double quotes only for DB strings.
- The documented Z80 instruction set, with IX and IY. Write (hl), (ix+5).
- Begin with ORG 32768; the code is loaded there and called there.

The machine:
- Return to BASIC with RET. Keep IY = 5C3Ah and the interrupts on (IM 1):
  the ROM's interrupt reads the keyboard and BASIC needs IY.
- Print through the ROM: first LD A,2 / CALL 1601h opens the screen
  channel; then RST 10h prints the character in A. Control codes in a
  string: 13 new line, 22,row,col AT, 16,n INK, 17,n PAPER (DB 22,5,10).
  CALL 0D6Bh clears the screen. RST 10h changes AF, BC, DE, HL: save what
  you need around it.
- Keys: the ROM's interrupt sets bit 5 of FLAGS (5C3Bh) when a key is
  pressed and leaves its code in LAST_K (5C08h): test BIT 5,(IY+1), read
  LAST_K, then RES 5,(IY+1). HALT waits for the next frame (50 a second).
- The screen bitmap is at 4000h (6144 bytes, the rows interleaved), the
  attributes at 5800h (768 bytes, 32 a row: bit 7 FLASH, 6 BRIGHT, 5-3
  PAPER, 2-0 INK). OUT (0FEh),A sets the border (bits 0-2) and the beeper
  (bit 4). The ROM's BEEPER is CALL 03B5h with HL = pitch, DE = duration.
- Memory from 32768 up to about 65000 is free for code and data.
- Keep it under about 300 lines and right first time: check every label is
  defined and every register holds what you think after each CALL.`;

/** The prompt for a language. */
const PROMPTS: Record<Lang, string> = { basic: BASIC_PROMPT, z80: Z80_PROMPT };
const LANG_NAMES: Record<Lang, string> = { basic: 'BASIC', z80: 'machine code' };

/** Characters of conversation kept for a program session (DeepSeek's context is large, not endless). */
export const MAX_HISTORY_CHARS = 200_000;

/**
 * Drops the oldest turns after the first two (the instructions and the
 * request or upload) until the conversation fits MAX_HISTORY_CHARS. The
 * latest source and request always stay.
 */
export function trimHistory(messages: ChatMessage[]): void {
  const size = () => messages.reduce((n, m) => n + m.content.length, 0);
  while (size() > MAX_HISTORY_CHARS && messages.length > 4) messages.splice(2, 2);
}

export function cleanSource(text: string): string {
  const fence = /```[a-zA-Z0-9]*\r?\n([\s\S]*?)```/.exec(text);
  const src = (fence ? fence[1] : text).replace(/\r/g, '');
  return src.replace(/^\n+/, '').replace(/\s+$/, '') + '\n';
}

type Mode = 'key' | 'menu' | 'chat' | 'describe' | 'lang' | 'name' | 'busy' | 'more' | 'bye';

/** Whether an answer looks like a program in that language (not all thinking, or prose). */
export function looksLike(lang: Lang, source: string): boolean {
  return lang === 'basic' ? /^\s*\d+\s*\S/m.test(source) : /^\s*(\w+:?\s+)?org\b/im.test(source);
}

/** Word wrap for streamed text. */
class Wrap {
  col = 0;
  private word = '';
  /** `indent` spaces start every line after the first. */
  constructor(private emit: (s: string) => void, private indent = 0) {}

  private newline(): void {
    this.emit('\r\n' + ' '.repeat(this.indent));
    this.col = this.indent;
  }

  push(text: string): void {
    for (const ch of text.replace(/\r/g, '').replace(/\t/g, '    ')) {
      if (ch === '\n') { this.flushWord(); this.newline(); }
      else if (ch === ' ') {
        this.flushWord();
        if (this.col > this.indent && this.col < WIDTH) { this.emit(' '); this.col++; }
      } else {
        this.word += ch;
        if (this.word.length >= WIDTH) this.flushWord();
      }
    }
  }

  flushWord(): void {
    if (!this.word) return;
    if (this.col > this.indent && this.col + this.word.length > WIDTH) this.newline();
    this.emit(this.word);
    this.col += this.word.length;
    this.word = '';
  }
}

/**
 * A build shown live: DeepSeek's reasoning, word-wrapped and indented, then
 * the source as it is written. The line runs at 2400 baud and the model is
 * faster, so when more than `limit` bytes are waiting to go out it finishes
 * the sentence (reasoning) or line (source) it is on, skips ahead until the
 * line has nearly caught up, and resumes at the next sentence or line after
 * an ellipsis: whole passages of the live end, never minutes behind.
 */
export class LiveView {
  private kind: 'thinking' | 'text' | '' = '';
  private wrap: Wrap;
  private col = 0;
  private state: 'showing' | 'finishing' | 'skipping' = 'showing';
  private prev = '';
  /** The last character shown or skipped ended a sentence or line. */
  private atBoundary = true;

  constructor(
    private emit: (s: string) => void,
    private backlog: () => number,
    private limit: number,
    private labels: { thinking: string; text: string },
  ) {
    this.wrap = new Wrap(this.emit, 2);
  }

  push(kind: 'thinking' | 'text', text: string): void {
    if (kind !== this.kind) {
      this.end();
      this.emit(`\r\n${this.labels[kind]}\r\n${kind === 'thinking' ? '  ' : ''}`);
      this.kind = kind;
      this.wrap.col = 2;
      this.state = 'showing';
      this.prev = '\n';
      this.atBoundary = true;
    }
    const behind = this.backlog();
    if (this.state === 'showing' && behind > this.limit) this.state = this.atBoundary ? 'skipping' : 'finishing';
    const resume = this.state === 'skipping' && behind < this.limit / 4;
    for (const ch of text) {
      const boundary = this.boundary(ch);
      this.prev = ch;
      this.atBoundary = boundary;
      if (this.state === 'skipping') {
        if (resume && boundary) {
          this.state = 'showing';
          if (kind === 'thinking') this.wrap.push('... ');
          else this.emit('  ...\r\n');
        }
        continue;
      }
      this.show(ch);
      if (this.state === 'finishing' && boundary) this.state = 'skipping';
    }
  }

  /** True when `ch` ends a sentence (reasoning) or a line (source). */
  private boundary(ch: string): boolean {
    if (ch === '\n') return true;
    return this.kind === 'thinking' && /\s/.test(ch) && /[.!?:]/.test(this.prev);
  }

  private show(ch: string): void {
    if (this.kind === 'thinking') {
      if (ch === '\n' && this.prev === '\n') return; // no blank lines
      this.wrap.push(ch);
      return;
    }
    if (ch === '\r') return;
    if (ch === '\n') { this.emit('\r\n'); this.col = 0; return; }
    if (ch === '\t') {
      const n = 8 - (this.col % 8);
      if (this.col + n < WIDTH) { this.emit(' '.repeat(n)); this.col += n; }
      return;
    }
    if (this.col >= WIDTH - 1) return; // long source lines are cut, not wrapped
    this.emit(ch);
    this.col++;
  }

  /** Ends the current section on a fresh line, marking a skipped end. */
  end(): void {
    const skipped = this.state !== 'showing';
    if (this.kind === 'thinking') {
      if (skipped) this.wrap.push(' ...');
      this.wrap.flushWord();
      if (this.wrap.col > 2) this.emit('\r\n');
    } else if (this.kind === 'text') {
      if (this.col) this.emit('\r\n');
      if (skipped) this.emit('  ...\r\n');
    }
    this.col = 0;
    this.state = 'showing';
  }
}

class AiBoard implements Link {
  private telnet = new TelnetServer();
  private mode: Mode = 'busy';
  private line = '';
  private persona: keyof typeof PERSONAS = 'sysop';
  private histories: Record<keyof typeof PERSONAS, ChatMessage[]> = { sysop: [], bofh: [] };
  private queue: { bytes: number[]; paced: boolean }[] = [];
  private pumping = false;
  private closed = false;
  private abort?: AbortController;
  /**
   * The program being worked on: the whole conversation with DeepSeek (the
   * request, every version, the errors), so after each build the caller can
   * ask for more changes in context.
   */
  private session?: { name: string; lang: Lang; messages: ChatMessage[] };
  /** The last answer ended in [HANGUP]. */
  private hungUp = false;
  private progName = '';
  private progText = '';
  private progLang: Lang = 'basic';
  private closeAfterOutput = false;

  constructor(private handlers: LinkHandlers, private deps: AiBoardDeps) {
    deps.schedule(() => {
      if (this.closed) return;
      handlers.onOpen('AI');
      handlers.onData(this.telnet.greeting());
      this.banner();
    }, 0);
  }

  // ---- Link ----------------------------------------------------------

  send(bytes: Uint8Array): void {
    if (this.closed) return;
    for (const b of this.telnet.strip(bytes)) this.key(b);
  }

  close(): void {
    this.closed = true;
    this.abort?.abort();
  }

  // ---- output --------------------------------------------------------

  private say(text: string): void {
    this.out(ascii(text), true);
  }

  /** Bytes still waiting to go out at the emulated baud rate. */
  private backlog(): number {
    let n = 0;
    for (const q of this.queue) if (q.paced) n += q.bytes.length;
    return n;
  }

  private out(bytes: number[], paced: boolean): void {
    if (this.closed || !bytes.length) return;
    this.queue.push({ bytes, paced: paced && (this.deps.cps ?? 240) > 0 });
    this.pump();
  }

  private pump(): void {
    if (this.pumping || this.closed) return;
    const cps = this.deps.cps ?? 240;
    let budget = Math.max(1, Math.round(cps / 20)); // per 50 ms
    while (this.queue.length) {
      const item = this.queue[0];
      if (!item.paced) {
        this.queue.shift();
        this.handlers.onData(this.telnet.escape(item.bytes));
        continue;
      }
      if (budget <= 0) {
        this.pumping = true;
        this.deps.schedule(() => { this.pumping = false; this.pump(); }, 50);
        return;
      }
      const n = Math.min(budget, item.bytes.length);
      this.handlers.onData(this.telnet.escape(item.bytes.splice(0, n)));
      budget -= n;
      if (!item.bytes.length) this.queue.shift();
    }
    if (this.closeAfterOutput) this.hangUp();
  }

  private hangUp(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onClose();
  }

  // ---- screens -------------------------------------------------------

  private banner(): void {
    this.say(
      '\r\n' +
      '  K-PROMPT AI BOARD  *  DeepSeek V4.1 Flash  *  2400 baud\r\n' +
      '  The sysop is an AI. Your API key, your bill.\r\n' +
      '  BREAK (ESC) stops an answer.\r\n',
    );
    if (this.deps.getKey()) this.menu();
    else this.askKey();
  }

  private askKey(): void {
    this.say(
      '\r\nThis board needs your DeepSeek API key. Paste it in the AI\r\n' +
      'board panel (it explains how to get one), or type it here.\r\n\r\nKey: ',
    );
    this.mode = 'key';
    this.line = '';
  }

  private menu(): void {
    this.say(
      '\r\n  [C] Chat with the AI sysop\r\n' +
      '  [B] Chat with the Bastard Operator From Hell\r\n' +
      '  [P] Order a program (BASIC or Z80, on a tape)\r\n' +
      '  [K] Forget my API key\r\n' +
      '  [G] Goodbye\r\n\r\nChoice: ',
    );
    this.mode = 'menu';
  }

  private chatPrompt(): void {
    this.say('\r\nYou> ');
    this.mode = 'chat';
    this.line = '';
  }

  // ---- input ---------------------------------------------------------

  private key(b: number): void {
    switch (this.mode) {
      case 'menu': return this.menuKey(b);
      case 'lang': return this.langKey(b);
      case 'busy':
        if (b === ESC) this.abort?.abort();
        return;
      case 'bye': return;
      default: return this.lineKey(b);
    }
  }

  private menuKey(b: number): void {
    const c = String.fromCharCode(b).toUpperCase();
    if (c === 'C' || c === 'B') {
      this.persona = c === 'C' ? 'sysop' : 'bofh';
      this.say(`${c}\r\n\r\n${PERSONAS[this.persona].intro}\r\n`);
      // He answers the phone first, as in the stories.
      if (this.persona === 'bofh' && !this.histories.bofh.length) void this.chatTurn(BOFH_PICKUP);
      else this.chatPrompt();
    } else if (c === 'P') {
      this.say('P\r\n\r\nDescribe the program in one line (for example: a\r\n' +
        'times table, or a number guessing game).\r\n\r\nProgram: ');
      this.mode = 'describe';
      this.line = '';
    } else if (c === 'K') {
      this.deps.setKey(null);
      this.say('K\r\n\r\nKey forgotten.\r\n');
      this.askKey();
    } else if (c === 'G') {
      this.say('G\r\n\r\nThanks for calling the K-Prompt AI Board. 73!\r\n');
      this.mode = 'bye';
      this.closeAfterOutput = true;
      this.pump();
    }
  }

  private langKey(b: number): void {
    const c = String.fromCharCode(b).toUpperCase();
    if (c !== 'B' && c !== 'M') return;
    this.progLang = c === 'B' ? 'basic' : 'z80';
    this.say(`${c}\r\n\r\nA name for the tape, up to 10 letters or digits: `);
    this.mode = 'name';
    this.line = '';
  }

  private lineKey(b: number): void {
    if (b === CR) {
      this.say('\r\n');
      const text = this.line.trim();
      this.line = '';
      this.enter(text);
      return;
    }
    if (b === LF || b === 0) return;
    if (b === BS || b === DEL) {
      if (this.line.length) {
        this.line = this.line.slice(0, -1);
        this.out([BS, 32, BS], true);
      }
      return;
    }
    if (b < 32 || b > 126 || this.line.length >= 400) return;
    this.line += String.fromCharCode(b);
    this.out([this.mode === 'key' ? 0x2a : b], false); // '*' for the key
  }

  private enter(text: string): void {
    switch (this.mode) {
      case 'key':
        if (!text) { this.say('No key, no call.\r\n'); this.mode = 'bye'; this.closeAfterOutput = true; this.pump(); return; }
        this.deps.setKey(text);
        this.say(`Key saved in this browser (${mask(text)}).\r\n`);
        this.menu();
        return;
      case 'chat':
        if (!text) { this.chatPrompt(); return; }
        if (text.toLowerCase() === '/menu') { this.menu(); return; }
        void this.chatTurn(text);
        return;
      case 'describe':
        if (!text) { this.menu(); return; }
        this.progText = text;
        this.say('\r\nIn BASIC or in machine code? [B/M] ');
        this.mode = 'lang';
        return;
      case 'more':
        if (!text || text.toLowerCase() === '/menu') {
          this.session = undefined;
          this.menu();
          return;
        }
        void this.revise(text);
        return;
      case 'name': {
        if (!/^[A-Za-z][A-Za-z0-9 ]{0,9}$/.test(text)) {
          this.say('A letter, then up to 9 letters, digits or spaces.\r\nName: ');
          return;
        }
        this.progName = text;
        void this.makeProgram();
        return;
      }
    }
  }

  // ---- DeepSeek ------------------------------------------------------

  /** Streams one answer. Returns the text, or undefined when it failed. */
  private async ask(
    messages: ChatMessage[],
    opts: { thinking: boolean; show: 'text' | 'live'; prefix?: number; hangs?: boolean; file?: string },
  ): Promise<string | undefined> {
    const key = this.deps.getKey();
    if (!key) { this.askKey(); return undefined; }
    this.mode = 'busy';
    this.abort = new AbortController();
    const wrap = new Wrap((s) => this.say(s));
    if (opts.show === 'text') wrap.col = opts.prefix ?? 4;
    let text = '';
    let held = ''; // text that might turn out to be [HANGUP]
    this.hungUp = false;
    const cps = this.deps.cps ?? 240;
    const live = new LiveView((t) => this.say(t), () => this.backlog(), Math.max(cps * 2, 1), {
      thinking: '[DeepSeek is thinking]',
      text: `[DeepSeek is writing ${opts.file ?? 'the program'}]`,
    });
    try {
      for await (const chunk of this.deps.chat({
        key, messages: [...messages], thinking: opts.thinking, signal: this.abort.signal,
        // Thinking counts against max_tokens: leave room for the code after it.
        maxTokens: opts.thinking ? 65536 : 2048,
      })) {
        if (this.closed) return undefined;
        if (chunk.kind === 'text') text += chunk.text;
        if (opts.show === 'text' && chunk.kind === 'text') {
          if (!opts.hangs) { wrap.push(chunk.text); continue; }
          held += chunk.text;
          if (held.includes(HANGUP)) { this.hungUp = true; held = held.replace(HANGUP, ''); }
          const keep = this.hungUp ? 0 : partialSuffix(held, HANGUP);
          wrap.push(held.slice(0, held.length - keep));
          held = held.slice(held.length - keep);
        } else if (opts.show === 'live') {
          live.push(chunk.kind, chunk.text);
        }
      }
      if (opts.show === 'live') live.end();
      wrap.push(held);
      wrap.flushWord();
      return text;
    } catch (e) {
      if (this.abort.signal.aborted) {
        this.say('\r\n[stopped]\r\n');
        return undefined;
      }
      this.say(`\r\n\r\n${explain(e)}\r\n`);
      if (e instanceof DeepSeekError && e.status === 401) { this.deps.setKey(null); this.askKey(); return undefined; }
      return undefined;
    } finally {
      this.abort = undefined;
    }
  }

  private async chatTurn(text: string): Promise<void> {
    const persona = PERSONAS[this.persona];
    const history = this.histories[this.persona];
    history.push({ role: 'user', content: text });
    if (history.length > 20) history.splice(0, history.length - 20);
    this.say(`\r\n${persona.prefix}`);
    const answer = await this.ask([{ role: 'system', content: persona.prompt }, ...history], {
      thinking: false, show: 'text', prefix: persona.prefix.length, hangs: persona.hangs,
    });
    if (this.closed) return;
    if (answer === undefined) {
      history.pop();
      if (this.mode === 'busy') this.chatPrompt();
      return;
    }
    history.push({ role: 'assistant', content: answer });
    if (this.hungUp) {
      this.say('\r\n\r\n*click*\r\n');
      this.mode = 'bye';
      this.closeAfterOutput = true;
      this.pump();
      return;
    }
    this.say('\r\n');
    this.chatPrompt();
  }

  private async makeProgram(): Promise<void> {
    const name = this.progName;
    const lang = this.progLang;
    this.session = undefined;
    this.say(`\r\nWriting ${name} in ${LANG_NAMES[lang]} with DeepSeek V4.1\r\nFlash. This can take a minute; BREAK gives up.\r\n`);
    await this.build(name, lang, [
      { role: 'system', content: PROMPTS[lang] },
      { role: 'user', content: `Write a ZX Spectrum program called ${name}: ${this.progText}` },
    ]);
  }

  /** Another pass on the session's program, with everything said so far. */
  private async revise(text: string): Promise<void> {
    const s = this.session!;
    s.messages.push({
      role: 'user',
      content: `The caller ran ${s.name} and asks for more: ${text}\n` +
        'Make that change and keep the rest of the program as it is. Output the whole program again, only the program.',
    });
    trimHistory(s.messages);
    this.say(`\r\nChanging ${s.name} with DeepSeek V4.1 Flash. This can take\r\na minute; BREAK gives up.\r\n`);
    await this.build(s.name, s.lang, s.messages);
  }

  /** After a delivery: more changes in the same conversation, or the menu. */
  private morePrompt(): void {
    this.say(`\r\nMore changes to ${this.session!.name}? Describe them in one line,\r\n` +
      'or press Enter alone for the menu. DeepSeek remembers this\r\nprogram and what you asked.\r\n\r\nChange: ');
    this.mode = 'more';
    this.line = '';
  }

  /** Asks for the program, checks it (errors go back, three tries) and delivers its tape. */
  private async build(name: string, lang: Lang, messages: ChatMessage[]): Promise<void> {
    this.session = { name, lang, messages };
    const what = lang === 'basic' ? 'listing' : 'assembly source';
    let source = '';
    let result: { ok: boolean; tap?: Uint8Array; errors: string[] } | undefined;
    for (let attempt = 1; attempt <= FIX_TRIES; attempt++) {
      const answer = await this.ask(messages, { thinking: true, show: 'live', file: name });
      if (this.closed) return;
      if (answer === undefined) { this.session = undefined; if (this.mode === 'busy') this.menu(); return; }
      source = cleanSource(answer);
      if (!looksLike(lang, source)) {
        // All thinking and no answer (or prose instead of code).
        this.say(`\r\nNo ${what} came back. `);
        if (attempt < FIX_TRIES) {
          this.say(`Asking again (try ${attempt + 1} of ${FIX_TRIES})...\r\n`);
          messages.push({ role: 'assistant', content: answer || '(no answer)' });
          messages.push({ role: 'user', content: `You sent no ${what}. Output the complete program now, only the ${what}.` });
          continue;
        }
        this.say('Giving up; try a simpler description.\r\n');
        this.session = undefined;
        this.menu();
        return;
      }
      messages.push({ role: 'assistant', content: source });
      this.say(lang === 'basic' ? `\r\nRunning ${name} on a spare Spectrum... ` : `\r\nAssembling ${name}... `);
      result = await this.deps.check(lang, name, source);
      if (this.closed) return;
      if (result.ok) {
        this.say('OK.\r\n');
        break;
      }
      this.say(`${result.errors.length} error${result.errors.length === 1 ? '' : 's'}:\r\n`);
      for (const line of result.errors.slice(0, 4)) this.say(`  ${line.slice(0, WIDTH - 2)}\r\n`);
      if (attempt < FIX_TRIES) {
        this.say(`Sending them back for a fix (try ${attempt + 1} of ${FIX_TRIES})...\r\n`);
        messages.push({
          role: 'user',
          content: (lang === 'basic'
            ? `The Spectrum stopped with these reports:\n${result.errors.join('\n')}\n`
            : `The assembler reported these errors:\n${result.errors.join('\n')}\n`) +
            `Output the whole corrected program again, only the ${what}.`,
        });
      }
    }
    if (!result?.ok || !result.tap) {
      this.say(`It still does not work after ${FIX_TRIES} tries. Try again\r\nwith a simpler description.\r\n`);
      this.morePrompt();
      return;
    }
    this.deps.deliver(name, result.tap);
    this.say(
      `\r\nThe tape ${name} is in your deck and on the shelf. Leave\r\n` +
      'the terminal with EDIT (the call stays up), then LOAD "".\r\n',
    );
    this.morePrompt();
  }
}

function mask(key: string): string {
  return key.length > 8 ? `${key.slice(0, 3)}...${key.slice(-4)}` : '****';
}

export function createAiBoard(handlers: LinkHandlers, deps: AiBoardDeps): Link {
  return new AiBoard(handlers, deps);
}
