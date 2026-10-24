# FUSE Z80 core tests

`tests.in` and `tests.expected` are FUSE's Z80 core tests (from `z80/tests/`
in the Free Unix Spectrum Emulator, git 02fbb2a, https://fuse-emulator.sourceforge.net/).
They are data, kept unchanged, and remain under FUSE's licence, the GNU GPL
version 2 or later; they are not part of K-Prompt's MIT-licensed code.
`tests/fuse.test.ts` reads them.

Each test sets the registers and memory, runs at least the given number of
T-states, and lists every bus event with its T-state (MC memory contention
point, MR/MW memory read/write, PC port contention, PR/PW port read/write),
then the final registers (including MEMPTR) and the memory that changed.
