# K-Prompt

**A ZX Spectrum in your browser. Load a tape and play.**

K-Prompt is a ZX Spectrum 48K emulator in TypeScript: a Z80 at 3.5 MHz, the
ULA drawing the screen line by line (border stripes and all), the beeper,
the keyboard and the cassette. It also runs Microdigital's Brazilian clones
of the Spectrum, the TK90X (1985) and the TK95 (1986), on their own ROMs.

The name comes from the flashing **K** cursor the Spectrum waits at, as
[A-Prompt](https://a-prompt.stern.workers.dev), its CP/M sibling, is named
after `A>` and [Ok-Prompt](https://ok-prompt.stern.workers.dev), its MSX
sibling, after `Ok`. The Z80 core comes from A-Prompt, where zexdoc and
zexall pass; here it times every memory and I/O cycle on its own, so the
ULA's contention delays the CPU exactly as on a real 48K (FUSE's core
tests pass, every bus event at its T-state), and unattached ports read the
floating bus.

## What it does

- **Tapes**: `.tap` and `.tzx`. Standard blocks load at once (the ROM's
  LD-BYTES is trapped); turbo loaders, and every tape when you turn fast
  loading off, play in real time through the EAR input, with the stripes
  in the border, and fast-forward while they play. SAVE records onto the
  tape in the deck, which you can download as a `.tap`.
- **Listings**: paste a BASIC program as a magazine printed it; it is
  tokenized (numbers get their hidden 5-byte values), put on a tape with an
  autostart line, and loaded by the ROM's own LOAD.
- **Snapshots**: `.z80` (versions 1 to 3, 48K) and `.sna`; save the running
  machine as a `.z80`.
- **Keyboard**: the PC keyboard types by character (`"` is SYMBOL SHIFT + P),
  and an on-screen 48K keyboard shows every keyword and symbol; tap it on a
  phone. CAPS and SYMBOL SHIFT latch for one-finger typing.
- **Joysticks**: Kempston, Sinclair or cursor, from the arrow keys or a
  gamepad.
- **Modem**: a Hayes modem that dials telnet BBSes, on I/O ports BASIC can
  reach (`IN 447`, `IN 703`, `OUT 703,x`), with the dial tone, ringing and
  handshake on the speaker. `TERM.tap`, on the shelf, is a 64-column
  terminal written in Z80 for it (`programs/TERM.asm`). Boards with their
  own WebSocket gateway are dialed straight from the browser; the others go
  through the Worker's relay, which only reaches the boards in
  `src/phonebook.ts`.
- **ULA.tap**, on the shelf: colour clash and multicolour side by side. Two
  balls drag their colours over a pattern 8×8 cells at a time, and beside
  them a band whose every pixel line has its own colours, rewritten 64
  times a frame by code counted to the T-state (`programs/ULA.asm`).
- **Machines**: ZX Spectrum 48K, TK90X, TK95.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # vitest; ZEX=1 npx vitest run tests/zex.test.ts for the Z80 exercisers
npm run build      # static site in dist/
```

## Fonts

TERM's 4-pixel font is Tom Thumb (© 1999 Brian J. Swetland and Vassilii
Khachaturov, portions © Dan Marks, readability changes by Robey Pointer),
under the 3-clause BSD licence: see [`programs/FONT-LICENSE.txt`](programs/FONT-LICENSE.txt).

## ROMs

The Spectrum ROM is © Amstrad, who allow it to be distributed with
emulators. The TK90X and TK95 ROMs are © Microdigital. See
[`src/roms/README.md`](src/roms/README.md).

## Licence

MIT, © 2026 Eduardo Stern. Built with Claude Code (Opus 5.5).
