/**
 * The Spectrum keyboard: 40 keys in eight half-rows of five. Reading port
 * FEh with a 0 in address bit 8+r selects half-row r; a pressed key reads 0
 * in bits 0–4. Several half-rows selected at once are ANDed together.
 *
 *   row 0 (FEFEh)  CAPS SHIFT  Z  X  C  V
 *   row 1 (FDFEh)  A  S  D  F  G
 *   row 2 (FBFEh)  Q  W  E  R  T
 *   row 3 (F7FEh)  1  2  3  4  5
 *   row 4 (EFFEh)  0  9  8  7  6
 *   row 5 (DFFEh)  P  O  I  U  Y
 *   row 6 (BFFEh)  ENTER  L  K  J  H
 *   row 7 (7FFEh)  SPACE  SYMBOL SHIFT  M  N  B
 *
 * The PC keyboard is mapped by character, the way you would type on a
 * Spectrum: letters and digits are their own keys, PC Shift is CAPS SHIFT,
 * and each symbol is SYMBOL SHIFT plus the key it is printed on (`"` is
 * SYMBOL SHIFT + P). Backspace, the arrows and Esc are the CAPS SHIFT
 * combinations the Spectrum used for DELETE, the cursor keys and BREAK, and
 * Home is EDIT. `[ ] { } \ | ~` are typed as EXTEND, then SYMBOL SHIFT + key.
 */

/** A key: row × 5 + bit. */
export type Key = number;

const ROWS = [
  ['CS', 'Z', 'X', 'C', 'V'],
  ['A', 'S', 'D', 'F', 'G'],
  ['Q', 'W', 'E', 'R', 'T'],
  ['1', '2', '3', '4', '5'],
  ['0', '9', '8', '7', '6'],
  ['P', 'O', 'I', 'U', 'Y'],
  ['ENTER', 'L', 'K', 'J', 'H'],
  ['SPACE', 'SS', 'M', 'N', 'B'],
];

export const KEYS: Record<string, Key> = {};
ROWS.forEach((row, r) => row.forEach((name, b) => { KEYS[name] = r * 5 + b; }));

export const CS = KEYS.CS;
export const SS = KEYS.SS;

/** Symbols as SYMBOL SHIFT plus the key they are printed on. */
export const SYMBOLS: Record<string, string> = {
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '&': '6', "'": '7', '(': '8', ')': '9', '_': '0',
  '<': 'R', '>': 'T', ';': 'O', '"': 'P', '^': 'H', '-': 'J', '+': 'K', '=': 'L',
  ':': 'Z', '£': 'X', '?': 'C', '/': 'V', '*': 'B', ',': 'N', '.': 'M',
};

/**
 * Symbols only E mode gives: EXTEND (CAPS + SYMBOL SHIFT), then SYMBOL
 * SHIFT + the key they are printed under.
 */
export const EXTENDED: Record<string, string> = {
  '[': 'Y', ']': 'U', '{': 'F', '}': 'G', '\\': 'D', '|': 'S', '~': 'A', '©': 'P',
};

/** The keys that type `ch` in L (letter) mode; null for characters the keyboard has no key for. */
export function keysFor(ch: string): Key[] | null {
  if (ch === '\n' || ch === '\r') return [KEYS.ENTER];
  if (ch === ' ') return [KEYS.SPACE];
  if (/^[a-z0-9]$/.test(ch)) return [KEYS[ch.toUpperCase()]];
  if (/^[A-Z]$/.test(ch)) return [CS, KEYS[ch]];
  const s = SYMBOLS[ch];
  return s ? [SS, KEYS[s]] : null;
}

/** PC keys that are a Spectrum combination whatever character they type. */
const SPECIAL: Record<string, string[]> = {
  Backspace: ['CS', '0'], ArrowLeft: ['CS', '5'], ArrowDown: ['CS', '6'], ArrowUp: ['CS', '7'],
  ArrowRight: ['CS', '8'], Escape: ['CS', 'SPACE'], Home: ['CS', '1'], CapsLock: ['CS', '2'], Tab: ['CS', 'SS'],
  Enter: ['ENTER'], NumpadEnter: ['ENTER'], Space: ['SPACE'],
  ShiftLeft: ['CS'], ShiftRight: ['CS'], ControlLeft: ['SS'], ControlRight: ['SS'],
  AltLeft: ['SS'], AltRight: ['SS'],
};

/** Shortest time a PC key stays down on the Spectrum, in ms (three frames). */
const MIN_HOLD = 60;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** The 40 keys' state, as the ULA reads it. */
export class Matrix {
  /** Bits 0–4 of each half-row: 1 = up, as the hardware reads. */
  readonly rows = new Uint8Array(8).fill(0x1f);

  set(keys: Iterable<Key>): void {
    this.rows.fill(0x1f);
    for (const k of keys) this.rows[(k / 5) | 0] &= ~(1 << k % 5);
  }

  /** Bits 0–4 read from port FEh with address high byte `high`. */
  read(high: number): number {
    let v = 0x1f;
    for (let r = 0; r < 8; r++) if (!(high & (1 << r))) v &= this.rows[r];
    return v;
  }
}

/**
 * PC keys to the matrix. Each PC key down holds the Spectrum keys it stands
 * for until it comes up. While a symbol is held, PC Shift's CAPS SHIFT is
 * dropped: Shift+' on a PC types `"`, which is SYMBOL SHIFT + P alone
 * (CAPS and SYMBOL SHIFT together would select extended mode).
 */
export class KeyInput {
  private down = new Map<string, { keys: Key[]; symbol: boolean; at: number }>();
  /** Keys pressed from elsewhere (the joystick as keys). */
  extra: Key[] = [];
  /** Types a sequence of chords (for the E-mode symbols); the machine's pressKeys. */
  onSequence?: (chords: Key[][]) => void;

  /** `sink` gets every key held, whenever that changes (the machine's hostKeys). */
  constructor(private readonly sink: (keys: Key[]) => void) {}

  /** Returns false for keys the Spectrum has no use for (they stay the browser's). */
  keyDown(code: string, key: string): boolean {
    if (this.down.has(code)) return true; // auto-repeat: the Spectrum repeats by itself
    if (key.length === 1 && EXTENDED[key] && this.onSequence) {
      this.onSequence([[CS, SS], [SS, KEYS[EXTENDED[key]]]]);
      return true;
    }
    let entry: { keys: Key[]; symbol: boolean; at: number } | undefined;
    const at = now();
    const special = SPECIAL[code];
    if (special) entry = { keys: special.map((n) => KEYS[n]), symbol: false, at };
    else if (key.length === 1) {
      const lower = key.toLowerCase();
      if (/^[a-z0-9]$/.test(lower)) entry = { keys: [KEYS[lower.toUpperCase()]], symbol: false, at };
      else if (SYMBOLS[key]) entry = { keys: [SS, KEYS[SYMBOLS[key]]], symbol: true, at };
    }
    if (!entry) return false;
    this.down.set(code, entry);
    this.update();
    return true;
  }

  /**
   * The ROM scans the keyboard once a frame, so a key let go within a
   * frame or two of its press could be missed: it is held at least
   * MIN_HOLD ms.
   */
  keyUp(code: string): void {
    const e = this.down.get(code);
    if (!e) return;
    const left = MIN_HOLD - (now() - e.at);
    if (left > 0) {
      setTimeout(() => { if (this.down.get(code) === e) { this.down.delete(code); this.update(); } }, left);
      return;
    }
    this.down.delete(code);
    this.update();
  }

  /** Lets go of everything (the window lost focus). */
  releaseAll(): void {
    this.down.clear();
    this.update();
  }

  update(): void {
    const symbol = [...this.down.values()].some((e) => e.symbol);
    const keys: Key[] = [...this.extra];
    for (const [code, e] of this.down) {
      if (symbol && (code === 'ShiftLeft' || code === 'ShiftRight')) continue;
      keys.push(...e.keys);
    }
    this.sink(keys);
  }
}
