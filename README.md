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
zexall pass.

## What it does

- **Tapes**: `.tap` and `.tzx`. Standard blocks load at once (the ROM's
  LD-BYTES is trapped); turbo loaders, and every tape when you turn fast
  loading off, play in real time through the EAR input, with the stripes
  in the border, and fast-forward while they play. SAVE records onto the
  tape in the deck, which you can download as a `.tap`.
- **Snapshots**: `.z80` (versions 1 to 3, 48K) and `.sna`; save the running
  machine as a `.z80`.
- **Keyboard**: the PC keyboard types by character (`"` is SYMBOL SHIFT + P),
  and an on-screen 48K keyboard shows every keyword and symbol; tap it on a
  phone. CAPS and SYMBOL SHIFT latch for one-finger typing.
- **Joysticks**: Kempston, Sinclair or cursor, from the arrow keys or a
  gamepad.
- **Machines**: ZX Spectrum 48K, TK90X, TK95.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # vitest; ZEX=1 npx vitest run tests/zex.test.ts for the Z80 exercisers
npm run build      # static site in dist/
```

## ROMs

The Spectrum ROM is © Amstrad, who allow it to be distributed with
emulators. The TK90X and TK95 ROMs are © Microdigital. See
[`src/roms/README.md`](src/roms/README.md).

## Licence

MIT, © 2026 Eduardo Stern. Built with Claude Code (Opus 5.5).
