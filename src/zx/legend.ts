/**
 * What is printed on and around each key of the 48K keyboard: the key, its
 * keyword in K mode, its SYMBOL SHIFT symbol (red, on the key), and the
 * extended-mode words above (green: E mode) and below (red: E mode with
 * SYMBOL SHIFT). The on-screen keyboard is drawn from this.
 */
export interface KeyLegend {
  /** Name in KEYS (keyboard.ts). */
  key: string;
  label: string;
  keyword?: string;
  symbol?: string;
  above?: string;
  below?: string;
}

export const LAYOUT: KeyLegend[][] = [
  [
    { key: '1', label: '1', symbol: '!', above: 'EDIT', below: 'DEF FN' },
    { key: '2', label: '2', symbol: '@', above: 'CAPS LOCK', below: 'FN' },
    { key: '3', label: '3', symbol: '#', above: 'TRUE VIDEO', below: 'LINE' },
    { key: '4', label: '4', symbol: '$', above: 'INV. VIDEO', below: 'OPEN #' },
    { key: '5', label: '5', symbol: '%', above: '←', below: 'CLOSE #' },
    { key: '6', label: '6', symbol: '&', above: '↓', below: 'MOVE' },
    { key: '7', label: '7', symbol: "'", above: '↑', below: 'ERASE' },
    { key: '8', label: '8', symbol: '(', above: '→', below: 'POINT' },
    { key: '9', label: '9', symbol: ')', above: 'GRAPHICS', below: 'CAT' },
    { key: '0', label: '0', symbol: '_', above: 'DELETE', below: 'FORMAT' },
  ],
  [
    { key: 'Q', label: 'Q', keyword: 'PLOT', symbol: '<=', above: 'SIN', below: 'ASN' },
    { key: 'W', label: 'W', keyword: 'DRAW', symbol: '<>', above: 'COS', below: 'ACS' },
    { key: 'E', label: 'E', keyword: 'REM', symbol: '>=', above: 'TAN', below: 'ATN' },
    { key: 'R', label: 'R', keyword: 'RUN', symbol: '<', above: 'INT', below: 'VERIFY' },
    { key: 'T', label: 'T', keyword: 'RAND', symbol: '>', above: 'RND', below: 'MERGE' },
    { key: 'Y', label: 'Y', keyword: 'RETURN', symbol: 'AND', above: 'STR$', below: '[' },
    { key: 'U', label: 'U', keyword: 'IF', symbol: 'OR', above: 'CHR$', below: ']' },
    { key: 'I', label: 'I', keyword: 'INPUT', symbol: 'AT', above: 'CODE', below: 'IN' },
    { key: 'O', label: 'O', keyword: 'POKE', symbol: ';', above: 'PEEK', below: 'OUT' },
    { key: 'P', label: 'P', keyword: 'PRINT', symbol: '"', above: 'TAB', below: '©' },
  ],
  [
    { key: 'A', label: 'A', keyword: 'NEW', symbol: 'STOP', above: 'READ', below: '~' },
    { key: 'S', label: 'S', keyword: 'SAVE', symbol: 'NOT', above: 'RESTORE', below: '|' },
    { key: 'D', label: 'D', keyword: 'DIM', symbol: 'STEP', above: 'DATA', below: '\\' },
    { key: 'F', label: 'F', keyword: 'FOR', symbol: 'TO', above: 'SGN', below: '{' },
    { key: 'G', label: 'G', keyword: 'GO TO', symbol: 'THEN', above: 'ABS', below: '}' },
    { key: 'H', label: 'H', keyword: 'GO SUB', symbol: '↑', above: 'SQR', below: 'CIRCLE' },
    { key: 'J', label: 'J', keyword: 'LOAD', symbol: '-', above: 'VAL', below: 'VAL$' },
    { key: 'K', label: 'K', keyword: 'LIST', symbol: '+', above: 'LEN', below: 'SCREEN$' },
    { key: 'L', label: 'L', keyword: 'LET', symbol: '=', above: 'USR', below: 'ATTR' },
    { key: 'ENTER', label: 'ENTER' },
  ],
  [
    { key: 'CS', label: 'CAPS SHIFT' },
    { key: 'Z', label: 'Z', keyword: 'COPY', symbol: ':', above: 'LN', below: 'BEEP' },
    { key: 'X', label: 'X', keyword: 'CLEAR', symbol: '£', above: 'EXP', below: 'INK' },
    { key: 'C', label: 'C', keyword: 'CONT', symbol: '?', above: 'LPRINT', below: 'PAPER' },
    { key: 'V', label: 'V', keyword: 'CLS', symbol: '/', above: 'LLIST', below: 'FLASH' },
    { key: 'B', label: 'B', keyword: 'BORDER', symbol: '*', above: 'BIN', below: 'BRIGHT' },
    { key: 'N', label: 'N', keyword: 'NEXT', symbol: ',', above: 'INKEY$', below: 'OVER' },
    { key: 'M', label: 'M', keyword: 'PAUSE', symbol: '.', above: 'PI', below: 'INVERSE' },
    { key: 'SS', label: 'SYMBOL SHIFT' },
    { key: 'SPACE', label: 'BREAK SPACE' },
  ],
];
