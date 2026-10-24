# K-Prompt — notes for Claude

ZX Spectrum emulator for the browser in TypeScript: 48K, 128K and +2, and
Microdigital's Brazilian clones (TK90X, TK95). Static site (Vite). Sibling of A-Prompt
(`~/cpm`, CP/M) and Ok-Prompt (`~/Ok-Prompt`, MSX); the Z80 core started
as Ok-Prompt's copy of A-Prompt's and is now timed access by access (only
here). Named after the flashing K cursor.

## Commands

```bash
npm run dev                      # http://localhost:5173
npm test                         # vitest (zex tests skipped)
npx tsc --noEmit                 # typecheck (npm run build also runs it)
npm run build                    # static site in dist/
npm run deploy                   # build + wrangler deploy (only when the user says so)
ZEX=1 npx vitest run tests/zex.test.ts   # zexdoc + zexall, ~4 min
```

Run `npx tsc --noEmit` and `npm test` before every commit. Rerun the zex
exerciser after any change to `src/z80.ts`; `tests/fuse.test.ts` (FUSE's
core tests, every bus event with its T-state) runs in `npm test`.

## Workflow

- Commit straight to `main` (single-developer repo); push only when the user
  says so. Commit style: `feat:`, `fix:`, `docs:` with a body that says why.
- Every bug fix gets a regression test that fails on the old code.

## Layout

| Path | Role |
| --- | --- |
| `src/z80.ts` | Z80 core: every M-cycle advances `cycles` when it happens (`mc`, `ioPre`/`ioPost`); memory through `read`/`write`, ports get the full 16-bit address; MEMPTR and Q |
| `src/zx/machine.ts` | `Spectrum`: memory, ports, `runFrame()`, models, tape traps, typing queue, `screenText()` |
| `src/zx/ula.ts` | Picture drawn cell by cell (8 pixels, 4 T) as the beam passes; border changes kept with their T-state; `contentionTable`, `floatingBus` |
| `src/zx/beeper.ts` | EAR/MIC (and the tape while it plays) averaged per output sample |
| `src/zx/ay.ts` | AY-3-8912 (Ok-Prompt's PSG): 128K ports FFFDh/BFFDh, or a 48K add-on (`ay48`); mixed in `takeAudio()` |
| `src/zx/keyboard.ts` | 8×5 matrix, PC keys by character (`"` = SYMBOL SHIFT + P), `KeyInput` |
| `src/zx/legend.ts` | What is printed on each key, for the on-screen keyboard |
| `src/zx/tape.ts` | `.tap`/`.tzx` blocks: bytes for the LD-BYTES trap, pulses for real-time play |
| `src/zx/basic.ts` | Listing → tokens (+ 0Eh and the 5-byte number after each number) → a .tap with autostart |
| `src/zx/snapshot.ts` | `.sna` and `.z80` (v1–v3), 48K and 128K, load and save; `snapshotKind` |
| `src/main.ts` | Page wiring, frame loop, deck, shelf, keyboard, joystick, gamepad |
| `src/ui/` | Audio, power switch, sound output, confirm dialog, IndexedDB store (from Ok-Prompt); call sound (from A-Prompt) |
| `src/zx/modem.ts` | Hayes modem with telnet (Ok-Prompt's copy of A-Prompt's), on ports 01BFh/02BFh |
| `src/phonebook.ts`, `worker/` | BBSes the relay may reach; the Worker's `/relay` WebSocket-to-telnet |
| `programs/TERM.asm`, `font4.asm` | The 64-column terminal (Z80); Tom Thumb font, BSD licence |
| `scripts/z80asm.ts`, `build-*.ts` | Assembler (from Ok-Prompt); `npm run tapes` builds `src/programs/*.tap` |
| `programs/ULA.asm`, `scripts/build-ula.ts` | The multicolour and colour clash demo; the T-state-counted part is generated |
| `src/roms/` | `48k.rom`, `tk90x.rom`, `tk95.rom`; `128k.rom`, `plus2.rom` are both ROMs, 32K (see `src/roms/README.md`) |

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
- Contention: `contentionTable(timing)` gives the wait states for every
  T-state (6,5,4,3,2,1,0,0 for 128 T of each display line, from 1 T before
  the line's first pixel); the core adds them before each cycle whose
  address is in a page flagged in `cpu.contendedPage` (4000h–7FFFh). I/O
  follows FUSE: ULA ports (A0 = 0) are contended once at +1, other ports in
  4000h–7FFFh at each of their T-states. HALT keeps PC on itself and is
  refetched every 4 T (the interrupt steps past it), as FUSE does.
- Floating bus: an unattached port (and 1Fh without a Kempston,
  `kempstonAttached`) returns `ula.floatingBus(t)`, sampled 2 T after the
  core calls `portIn` (`busReadT`): bitmap, attribute, bitmap+1, attribute+1,
  then FFh ×4 in each 8 T of the display, from `busPhase` (48K 2, TK 3).
- 128K/+2: 3.5469 MHz, 228 T × 311 lines (70,908), paper at 14,362, INT
  36 T. `mem` stays the flat 64K the CPU sees: paging copies the C000h bank
  in and out (`page()`), banks 5 and 2 at C000h are aliased on write
  (`alias`), and `bank(n)` is the live view of any bank (snapshots, tests).
  The ULA reads `ula.screen` (bank 5 or 7). Port 7FFDh decodes A15 = A1 = 0;
  reading such a port also writes 7FFDh (FUSE's quirk). The 128 editor
  rewrites 7FFDh from BANKM (5B5Ch). Tape traps fire only with ROM 1 (48
  BASIC) paged; `typeLoad()` picks Tape Loader on the menu (ENTER).
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
  after editing `programs/TERM.asm`, run `npm run tapes`.
- The call sound plays the whole call (dial tone to handshake) before the
  connection opens and holds nothing after: Synchronet probes the terminal
  at once and, answered late, calls it DUMB at 80 columns. Answered in
  time it reports ANSI 64x24. Same code as A-Prompt and Ok-Prompt.
- Live checks: Vertrauen (ATDT 1) has its own WebSocket gateway, so it works
  from `vite preview`; the others need `npm run build && npx wrangler dev`.

## ULA.tap (multicolour)

- 48K timing only: IM 2 (table at BD00h, handler RET at BEBEh), a counted
  delay, then 64 blocks of exactly 224 T that PUSH 12 attributes per pixel
  line from 128 T into the previous line: the attribute writes must fall in
  T 127–222 of a line, where the ULA does not contend (they used to start at
  160 and ran into the next line's contended slots). Code and tables stay
  above 8000h.
- `tests/ula.test.ts` checks every band line's colours over 30 frames and
  that 600 frames each reach HALT before the next interrupt.

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
