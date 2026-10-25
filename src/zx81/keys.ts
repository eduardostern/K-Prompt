/**
 * The ZX80/ZX81 keyboard: 40 keys in 8 half-rows of 5, read on port FEh
 * with one of A8–A15 low (bit clear = pressed). The same matrix as the
 * Spectrum, with "." where the Spectrum has SYMBOL SHIFT.
 *
 * Keywords are typed by key, not by letters: in K mode (start of a line)
 * P is PRINT, J is LOAD and so on. Symbols are SHIFT with a key; on a ZX81:
 */
export interface ZxKey { row: number; bit: number; shift?: boolean }

const ROWS = [
  ['SHIFT', 'Z', 'X', 'C', 'V'],
  ['A', 'S', 'D', 'F', 'G'],
  ['Q', 'W', 'E', 'R', 'T'],
  ['1', '2', '3', '4', '5'],
  ['0', '9', '8', '7', '6'],
  ['P', 'O', 'I', 'U', 'Y'],
  ['NEWLINE', 'L', 'K', 'J', 'H'],
  ['SPACE', '.', 'M', 'N', 'B'],
];

/** The matrix position of a key by its name (A–Z, 0–9, SHIFT, NEWLINE, SPACE, "."). */
export function keyAt(name: string): ZxKey | undefined {
  for (let row = 0; row < 8; row++) {
    const bit = ROWS[row].indexOf(name);
    if (bit >= 0) return { row, bit };
  }
  return undefined;
}

/** ZX81 symbols on SHIFT. */
const ZX81_SHIFTED: Record<string, string> = {
  '"': 'P', '$': 'U', '(': 'I', ')': 'O', '-': 'J', '+': 'K', '=': 'L', ':': 'Z', ';': 'X',
  '?': 'C', '/': 'V', '*': 'B', '<': 'N', '>': 'M', ',': '.', '£': 'SPACE',
};

/** ZX80 symbols on SHIFT (its keyboard differs). */
const ZX80_SHIFTED: Record<string, string> = {
  '"': 'Y', '$': 'U', '(': 'I', ')': 'O', '-': 'J', '+': 'K', '=': 'L', ':': 'Z', ';': 'X',
  '?': 'C', '/': 'V', '*': 'P', '<': 'N', '>': 'M', ',': '.', '£': 'SPACE',
};

/** The keys that type a character (letters and digits as themselves; \n is NEWLINE). */
export function keysFor(ch: string, zx80 = false): ZxKey | undefined {
  if (ch === '\n' || ch === '\r') return keyAt('NEWLINE');
  if (ch === ' ') return keyAt('SPACE');
  if (ch === '.') return keyAt('.');
  const up = ch.toUpperCase();
  if (/^[A-Z0-9]$/.test(up)) return keyAt(up);
  const base = (zx80 ? ZX80_SHIFTED : ZX81_SHIFTED)[ch];
  const k = base ? keyAt(base) : undefined;
  return k ? { ...k, shift: true } : undefined;
}

/** A PC key (KeyboardEvent.code) at its ZX81 place. */
export function keyForCode(code: string): ZxKey | undefined {
  if (/^Key[A-Z]$/.test(code)) return keyAt(code.slice(3));
  if (/^Digit[0-9]$/.test(code)) return keyAt(code.slice(5));
  switch (code) {
    case 'ShiftLeft': case 'ShiftRight': return keyAt('SHIFT');
    case 'Enter': case 'NumpadEnter': return keyAt('NEWLINE');
    case 'Space': return keyAt('SPACE');
    case 'Period': return keyAt('.');
  }
  return undefined;
}

/** The PC keys for the ZX81's editing keys (each is SHIFT + a key). */
export const SPECIAL: Record<string, ZxKey> = {
  Backspace: { ...keyAt('0')!, shift: true }, // RUBOUT
  ArrowLeft: { ...keyAt('5')!, shift: true },
  ArrowDown: { ...keyAt('6')!, shift: true },
  ArrowUp: { ...keyAt('7')!, shift: true },
  ArrowRight: { ...keyAt('8')!, shift: true },
  Escape: { ...keyAt('SPACE')! }, // BREAK
};
