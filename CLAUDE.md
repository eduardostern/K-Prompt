# K-Prompt — notes for Claude

ZX Spectrum 48K emulator for the browser in TypeScript, with Microdigital's
Brazilian clones (TK90X, TK95). Static site (Vite). Sibling of A-Prompt
(`~/cpm`, CP/M) and Ok-Prompt (`~/Ok-Prompt`, MSX); the Z80 core is
Ok-Prompt's copy of A-Prompt's. Named after the flashing K cursor.

## Commands

```bash
npm run dev                      # http://localhost:5173
npm test                         # vitest (zex tests skipped)
npx tsc --noEmit                 # typecheck (npm run build also runs it)
npm run build                    # static site in dist/
npm run deploy                   # build + wrangler deploy (only when the user says so)
ZEX=1 npx vitest run tests/zex.test.ts   # zexdoc + zexall, ~2.5 min
```

Run `npx tsc --noEmit` and `npm test` before every commit. Rerun the zex
exerciser after any change to `src/z80.ts`.

## Workflow

- Commit straight to `main` (single-developer repo); push only when the user
  says so. Commit style: `feat:`, `fix:`, `docs:` with a body that says why.
- Every bug fix gets a regression test that fails on the old code.

## Layout

| Path | Role |
| --- | --- |
| `src/z80.ts` | Z80 core; memory through `read`/`write`, ports get the full 16-bit address |
| `src/zx/machine.ts` | `Spectrum`: memory, ports, `runFrame()`, models, tape traps, typing queue, `screenText()` |
| `src/zx/ula.ts` | Picture drawn line by line as T-states pass; border changes kept with their T-state |
| `src/zx/beeper.ts` | EAR/MIC (and the tape while it plays) averaged per output sample |
| `src/zx/keyboard.ts` | 8×5 matrix, PC keys by character (`"` = SYMBOL SHIFT + P), `KeyInput` |
| `src/zx/legend.ts` | What is printed on each key, for the on-screen keyboard |
| `src/zx/tape.ts` | `.tap`/`.tzx` blocks: bytes for the LD-BYTES trap, pulses for real-time play |
| `src/zx/basic.ts` | Listing → tokens (+ 0Eh and the 5-byte number after each number) → a .tap with autostart |
| `src/zx/snapshot.ts` | `.sna` and `.z80` (v1–v3, 48K) load and save |
| `src/main.ts` | Page wiring, frame loop, deck, shelf, keyboard, joystick, gamepad |
| `src/ui/` | Audio, power switch, sound output, confirm dialog, IndexedDB store (from Ok-Prompt); call sound (from A-Prompt) |
| `src/zx/modem.ts` | Hayes modem with telnet (Ok-Prompt's copy of A-Prompt's), on ports 01BFh/02BFh |
| `src/phonebook.ts`, `worker/` | BBSes the relay may reach; the Worker's `/relay` WebSocket-to-telnet |
| `programs/TERM.asm`, `font4.asm` | The 64-column terminal (Z80); Tom Thumb font, BSD licence |
| `scripts/z80asm.ts`, `build-term.ts` | Assembler (from Ok-Prompt); builds `src/programs/TERM.tap` (`npm run term`) |
| `src/roms/` | `48k.rom`, `tk90x.rom`, `tk95.rom` (see `src/roms/README.md`) |

## Spectrum facts that are easy to get wrong

- Frame: 69,888 T (224 × 312), first display pixel at T 14,336. INT is held
  for the first 32 T only; `runFrame()` offers it before each instruction
  in that window. The data bus reads FFh (IM 2 vector at I·256+FFh).
- TK90X/TK95 (Microdigital's own ULA): 3.575611 MHz, 228 T per line; 60 Hz
  PAL-M (262 lines, 59,736 T, paper at 8,760) by default, 50 Hz (312 lines,
  71,136 T, paper at 14,688) with ULA pin 1 switched, or a Ferranti ULA
  (48K timing) as on some export boards. `timingOf(model, tkVideo)`. Tape
  pulses are 3.5 MHz T-states, stretched by `Tape.scale` on the TK clock.
  Sources: Cantinho do TK90X's measurements, ESPectrum, the CPLD clone.
- The ULA answers every even port; keyboard half-row r is selected by a 0
  in address bit 8+r, and several rows AND together. Port 1Fh (A5 low) is
  Kempston. The core passes `A<<8|n` for `IN A,(n)` and BC for `IN r,(C)`.
- The ROM ignores a key pressed again within ~5 interrupts of its release:
  `pressKeys` leaves a longer gap between two chords sharing a key, and
  `KeyInput` holds every PC key at least 60 ms.
- In K mode letters are keywords (P = PRINT, J = LOAD, B = BORDER); in E
  mode (CAPS + SYMBOL SHIFT) SYMBOL SHIFT + Z is BEEP. Tests type keywords
  with `pressKeys([KEYS.P])` and the rest with `typeText`.
- LD-BYTES (0556h), SA-BYTES (04C2h) and SA/LD-RET (053Fh) are at the same
  addresses in all three ROMs. Traps leave through SA/LD-RET, which restores
  the border and does EI as the ROM does. A block whose flag or length is
  not what LD-BYTES asked for fails (carry clear), like the real loader.
- SAVE pauses about a second between header and data (tests settle 120
  frames). The 48K ROM's RAM test takes about 1.5 s before the © message.
- `screenText()` matches screen cells against the font at CHARS+256; CHARS
  is 0 until the ROM sets it, then 3C00h.

## The modem and TERM

- Ports are fully decoded 16-bit: status 01BFh (447), data 02BFh (703). Odd
  with A5 high, so neither the ULA nor Kempston sees them.
- TERM loads at 8000h behind `10 CLEAR 32767: LOAD "" CODE` and
  `20 RANDOMIZE USR 32768`; EDIT returns to BASIC with the call up, RUN 20
  goes back. Keys come from the ROM's interrupt (LAST_K, FLAGS bit 5) with
  FLAGS bit 3 set each loop so letters are not keywords. After EXTEND the
  ROM decodes in E mode: a letter arrives as its E-mode token (`etab`).
- `tests/term.test.ts` checks the committed TERM.tap matches its source;
  after editing `programs/TERM.asm`, run `npm run term`.
- With the speaker on, the call sound holds the line ~11 s before CONNECT
  (as in A-Prompt), and Synchronet's terminal detection gives up meanwhile
  (DUMB, 80 columns). ATM0 connects at once and is detected as ANSI 64x24.
- Live checks: Vertrauen (ATDT 1) has its own WebSocket gateway, so it works
  from `vite preview`; the others need `npm run build && npx wrangler dev`.

## Testing tips

- `tests/zx.test.ts`: `boot(model)`, `settle(zx)`, keywords by key; tape and
  snapshot round trips build their own files by SAVEing from BASIC.
- Browser checks: `npm run build`, `npx vite preview --port 4181`, then
  `playwright-cli -s=kprompt` (a named session: other Claude sessions use
  the default one) from the scratchpad. A fresh page waits at the power
  switch: set localStorage `k-prompt.settings` to `{"autoPower":true}`.
  `page.keyboard.press` works because keys are held at least 60 ms.
- Check the page at 320, 375 and 430 px widths after UI changes.
- Test software goes to the scratchpad, never into the repo.
