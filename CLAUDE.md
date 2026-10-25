# K-Prompt — notes for Claude

ZX Spectrum emulator for the browser in TypeScript: 48K, 128K and +2,
Microdigital's Brazilian clones (TK90X, TK95), and the Timex Sinclair 2068. Static site (Vite). Sibling of A-Prompt
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
| `src/zx/if1.ts` | Interface 1: ports E7h/EFh/F7h (decoded by A4, A3, odd only), the drive motor shift register |
| `src/zx/microdrive.ts` | `.mdr` cartridges (254 × 543 + WP byte) and drives, FUSE's access-driven head model |
| `src/zx/rs232.ts` | The IF1's RS232 bit by bit in T-states, wired to the modem |
| `src/zx/rewind.ts` | Rewind ring: a `.z80` every 50 frames (`zx.onFrame`), the last 30; main clears it on reset, model switch and snapshot loads |
| `src/zx/snapshot.ts` | `.sna` and `.z80` (v1–v3), 48K and 128K, load and save; `snapshotKind` |
| `src/main.ts` | Page wiring, frame loop, deck, shelf, keyboard, joystick, gamepad |
| `src/ui/` | Audio, power switch, sound output, confirm dialog, IndexedDB store (from Ok-Prompt; also the quick-save slot `quick`, named after its model); call sound (from A-Prompt) |
| `src/zx/modem.ts` | Hayes modem with telnet (Ok-Prompt's copy of A-Prompt's), on ports 01BFh/02BFh |
| `src/phonebook.ts`, `worker/` | BBSes the relay may reach; the Worker's `/relay` WebSocket-to-telnet |
| `programs/TERM.asm`, `font4.asm` | The 64-column terminal (Z80); Tom Thumb font, BSD licence |
| `programs/io-ports.asm`, `io-if1.asm` | TERM's modem I/O (`minit`, `mpoll`, `send`, banner): K-Prompt's ports, or the IF1's RS232 at 19200 (I1TERM) |
| `src/zx/z80asm.ts`, `src/zx/tape-file.ts`, `scripts/build-*.ts` | Assembler (from Ok-Prompt) and code tapes, used by the build scripts and the AI board; `npm run tapes` builds `src/programs/*.tap` |
| `programs/ULA.asm`, `scripts/build-ula.ts` | The multicolour and colour clash demo; the T-state-counted part is generated |
| `programs/ULA2.asm`, `scripts/build-ula2.ts`, `spectrum-image.ts` | A beach photo with the clash fixed down the middle (8×1 attributes, 16 columns × 192 lines); `beach.png` is CC0 |
| `src/zx81/machine.ts`, `keys.ts` | `Zx81` (on the Model menu with the Spectrums; main.ts runs it instead of `Spectrum` while `zx81` is set, and `body.zx81` hides the Spectrum-only controls): ZX81, TK82C, TK85, ZX80, TK80; display by M1 fetches (`cpu.fetchOp`), INT from R bit 6, NMI generator, VSYNC on IN/OUT, LOAD/SAVE traps |
| `src/roms/` | `zx80.rom`, `zx81.rom`, `tk85.rom` (10K: ZX81 8K + 2K at 2000h); `48k.rom`, `tk90x.rom`, `tk95.rom`; `128k.rom`, `plus2.rom` are both ROMs, 32K; `ts2068.rom` home + EXROM, 24K (see `src/roms/README.md`) |

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
- TS2068 (`timex`): 3.528 MHz, 224 T × 262 (58,688), paper at 9,169, no
  floating bus or Kempston. The ROM file is the 16K home ROM then the 8K
  EXROM; the tape routines are in the EXROM (SA-BYTES 0068h, SA/LD-RET
  00E5h, LD-BYTES 00FCh: `TAPE_ENTRIES`), trapped while it is at 0000h. Port
  F4h (HSR) puts the EXROM (DEC bit 7) or the empty dock over each 8K
  chunk: `mapChunks()` copies, saving home RAM in `homeChunks`, and
  `readOnly` blocks writes. Port FFh (DEC) is the screen mode (`ula.dec`,
  drawn at `scale` 2, 704 px wide), bit 6 masks the interrupt. Ports are
  fully decoded (FEh only for the ULA); AY at F5h/F6h, R14 reads the
  joystick (active low: up 1, down 2, left 4, right 8, fire 80h; stick 1
  when A8 is set). `.z80` hardware 128 keeps F4h/FFh in bytes 35/36.
- Interface 1 (`zx.setInterface1(rom)`, not on the TS2068): its 8K ROM is
  copied over 0000h and 2000h when an opcode is fetched from 0008h or
  1708h, and the Spectrum ROM is put back after the fetch at 0700h
  (`runFrame`). Tape traps are off while it is paged. `.z80` byte 36 = FFh
  when paged; hardware 1 (48K) or 5 (128K) with it.
- Microdrives: each E7h byte moves the head one byte; a status read (EFh)
  counts GAP/SYNC down and, like any EFh access, puts the head back at the
  start of its header (15 bytes) or record (528). Loaded cartridges are
  formatted everywhere; `Cartridge.blank()` nowhere until FORMAT writes the
  preambles (`preamble[]`, FFh = formatted).
- IF1 RS232: one bit = 26 × (BAUD + 2) T-states (BAUD at 5CC3h, 12 for
  9600 until set). Lines are inverted: 1 on F7h bit 0 (out) or bit 7 (in) is
  a start bit or a 0. A byte goes to the Spectrum only while it holds CTS
  (EFh bit 4); the ROM waits for DTR (EFh in bit 3, the modem can take a
  byte) before sending. TX is decoded at mid-bit; a start bit gone before
  its middle is the ROM's last OUT, ignored. The modem is the same object
  as on 01BFh/02BFh.
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

## ZX80 and ZX81 facts that are easy to get wrong

- No video chip worth the name: D_FILE is executed at its address + 8000h;
  an M1 fetch with A15 set and bit 6 clear is a character: the ULA latches
  it, puts NOP on the bus, and shifts out the ROM pattern at I·256 +
  code·8 + line counter (8 pixels in 4 T). Only opcode fetches see RAM
  above 7FFFh; data reads there get FFh (the TK85's ROM tests RAM up to
  FEFFh and would otherwise find a mirror).
- /INT is A6 during refresh: asserted when R's bit 6 goes low. Taking it
  restarts the 207-T line. The ZX81's NMI generator (OUT FEh on, OUT FDh
  off) fires every 207 T; the ZX80 has none. IN with A0 = 0 starts VSYNC
  (ZX81: only with NMIs off), any OUT ends it; a long one ends the frame.
- 60 Hz machines (port FE bit 6 = 0, the TKs) leave BASIC less time
  (~0.55 MHz against ~0.9): they take about 400 frames to reach the K
  cursor. Typed keys need about 6 frames released between them.
- Traps: ZX81 LOAD 0347h and SAVE 02FCh return through 0207h; ZX80 LOAD
  0206h and SAVE 01B6h pop 2 and go to 0283h. `.p` loads at 4009h, `.o` at
  4000h. The TK82C is a ZX81 clone; the ZX80 clones are the TK80 and TK82.

## The modem and TERM

- Ports are fully decoded 16-bit: status 01BFh (447), data 02BFh (703). Odd
  with A5 high, so neither the ULA nor Kempston sees them.
- TERM loads at 8000h behind `10 CLEAR 32767: LOAD "" CODE` and
  `20 RANDOMIZE USR 32768`; EDIT returns to BASIC with the call up, RUN 20
  goes back. Keys come from the ROM's interrupt (LAST_K, FLAGS bit 5) with
  FLAGS bit 3 set each loop so letters are not keywords. After EXTEND the
  ROM decodes in E mode: a letter arrives as its E-mode token (`etab`).
- `tests/term.test.ts` runs TERM and I1TERM through the same steps and
  checks the committed tapes match their source; after editing
  `programs/TERM.asm` or an `io-*.asm`, run `npm run tapes`.
- I1TERM uses its own serial routines, not the ROM's hook codes 1Dh/1Eh:
  those wait over a frame with interrupts off when nothing comes. Its
  `mpoll` listens ~1,400 T with CTS up, then does EI: HALT, because the 48K
  offers its interrupt for only 32 T and the keyboard scan would starve.
  Its loader runs `FORMAT "b";19200` (BAUD 5: 182 T a bit). Playwright
  must type into it with a delay between keys (`type(s, { delay: 150 })`).
- The call sound plays the whole call (dial tone to handshake) before the
  connection opens and holds nothing after: Synchronet probes the terminal
  at once and, answered late, calls it DUMB at 80 columns. Answered in
  time it reports ANSI 64x24. Same code as A-Prompt and Ok-Prompt.
- Live checks: Vertrauen (ATDT 1) has its own WebSocket gateway, so it works
  from `vite preview`; the others need `npm run build && npx wrangler dev`.

## AI board

- `ATDT AI` / `ATDT DEEPSEEK`: the dialer returns `createAiBoard`
  (`src/ai/aiboard.ts`, A-Prompt's board brought over), a Link acting as a
  telnet server in BINARY mode at 2400 baud, 62 columns for TERM/I1TERM.
  The call sound plays first, as for any board.
- DeepSeek is called from the browser (`src/ai/deepseek.ts`, CORS allows any
  origin) with the visitor's own key, in localStorage `k-prompt.deepseek-key`,
  set from the AI board panel or typed when the board asks. Never route it
  through the Worker.
- Programs: `[P]`, then BASIC or machine code. `src/ai/check.ts` tokenizes
  BASIC onto a tape and runs it on a hidden 48K (~10 s): an error report
  (ERR_NR not FFh/STOP/BREAK) goes back to the model; Z80 is assembled
  (`src/zx/z80asm.ts`), put on a `codeTape` and run the same way (a reset to
  the © screen is a crash). Three tries; the tape goes down the line by
  ZMODEM as a `.tap` (`src/ai/zmodem.ts`, A-Prompt's), or into the deck
  (`deliver`) when the terminal has no ZMODEM; then "more changes" revises
  it in the same conversation (`trimHistory`). `[F]` takes a BASIC `.tap`
  uploaded by ZMODEM, `detokenize`s it (`src/zx/basic.ts`), runs it, and
  fixes it with `FIX_PROMPT` through the same build loop.
- Tests use a fake `chat` and `cps: 0` (`tests/aiboard.test.ts`); no test
  calls DeepSeek.

## ZMODEM in TERM and I1TERM

- `programs/zmodem.asm` (A-Prompt's ZMODEM.COM for the Z80, one file a
  transfer, CRC-16, positions in 16 bits, timeouts in FRAMES) is assembled
  into both terminals after their `io-*.asm`; it uses their `mpoll`/`send`
  and TERM's `puts`/`emit`. Every transfer is a `.tap` image.
- Download: `zwatch` sees `**` ZDLE `B00` (ZRQINIT) in the incoming bytes
  and calls `zrecv`; the file goes to the buffer at A000h–FEFFh, then each
  block is SAVEd through SA-BYTES (the emulator puts a blank tape in an
  empty deck first). Upload: EXTEND then U (`kfound`) calls `zupload`:
  LD-BYTES loads a header and its data into the buffer as a `.tap`, then
  `zsend`. BREAK cancels. TERM must end below A000h (`build-term.ts` checks).
- Header positions are 4 bytes: `zrxpos`/`ztxpos` are `dw 0, 0`. `zcrcup`
  keeps A (the header senders print the byte after adding it to the CRC).
- `tests/zmodem-term.test.ts` runs TERM and I1TERM against the real board
  (fake model): a download onto the tape, and an upload that comes back
  fixed. The board ignores input for 1.5 s after a transfer; tests wait.

## ULA.tap (multicolour)

- 48K timing only: IM 2 (table at BD00h, handler RET at BEBEh), a counted
  delay, then 64 blocks of exactly 224 T that PUSH 12 attributes per pixel
  line from 128 T into the previous line: the attribute writes must fall in
  T 127–222 of a line, where the ULA does not contend (they used to start at
  160 and ran into the next line's contended slots). Code and tables stay
  above 8000h.
- `tests/ula.test.ts` checks every band line's colours over 30 frames and
  that 600 frames each reach HALT before the next interrupt.

## ULA2.tap (a photo, colour clash fixed)

- `programs/beach.png` (CC0, credit in `beach.txt`) converted by
  `scripts/spectrum-image.ts`: best colour pair per cell, Bayer dither.
  The middle (columns 8-23, all 192 lines) gets 8×1 attributes, the sides
  the ULA's 8×8; M swaps the middle (XORs its pixels, puts back 8×8).
- 192 generated blocks of 224 T: POP 16 bytes into AF BC DE HL and the
  alternate set, LD SP to the row's end, PUSH them. Blocks start 16 T into
  the line before; the PUSH writes fall at +129…+217, after the ULA's
  fetches (from −1 for 128 T) and before the next line's (+223). ENTRY_T
  counts mloop's code after HALT (LD A,(clash); OR A; JP Z): 17 T too few
  and every line showed the one before. Stack and IM 2 table at FD00h/FE00h.
- `tests/ula2.test.ts` checks every pixel against the converted picture,
  both ways, and SPACE back to BASIC (H'L' and IY restored).

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
