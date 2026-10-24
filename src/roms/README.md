# ROMs

| File | Machine | CRC32 | SHA-1 | Source |
| --- | --- | --- | --- | --- |
| `48k.rom` | ZX Spectrum 48K (Sinclair, 1982) | ddee531f | 5ea7c2b824672e914525d1d5c419d71b84a426a2 | Fuse's `roms/48.rom` |
| `tk90x.rom` | Microdigital TK90X (1985) | 3e785f6f | 9a943a008be13194fb006bddffa7d22d2277813f | ZEsarUX `src/tk90x.rom` |
| `tk95.rom` | Microdigital TK95 (1986) | 17368e07 | 94edc401d43b0e9a9cdc1d35de4b6462dc414ab3 | ZEsarUX `src/tk95.rom` |
| `128k.rom` | ZX Spectrum 128 (1985): ROM 0 (editor) then ROM 1 (48 BASIC) | e76799d2, b96a36be | 4f4b11ec22326280bdb96e3baf9db4b4cb1d02c5, 80080644289ed93d71a1103992a154cc9802b2fa | Fuse's `roms/128-0.rom`, `128-1.rom` |
| `ts2068.rom` | Timex Sinclair 2068 (1983): 16K home ROM then the 8K EXROM | bf44ec3f, ae16233a | 1446cb2780a9dedf640404a639fa3ae518b2d8aa, 7e265a2c1f621ed365ea23bdcafdedbc79c1299c | Fuse's `roms/tc2068-0.rom`, `tc2068-1.rom` (Fuse uses them for its TS2068) |
| `plus2.rom` | ZX Spectrum +2 (1986): ROM 0 then ROM 1 | 5d2e8c66, 98b1320b | 72703f9a3e734f3c23ec34c0727aae4ccbef9a91, de8b0d2d0379cfe7c39322a086ca6da68c7f23cb | Fuse's `roms/plus2-0.rom`, `plus2-1.rom` |

The CRCs match MAME's entries for these machines.

The Spectrum, 128 and +2 ROMs are © Amstrad, which allows their
distribution with emulators. The 2068 ROMs are derived from Amstrad's code
under the same terms; Timex's changes are in the public domain (Fuse's
`roms/README.copyright`). The CRCs and SHA-1s of the 128K and +2 files
are of each 16K half. The TK90X and TK95 ROMs are © Microdigital Eletrônica; there is
no such statement for them, and they are included as other emulators
(ZEsarUX, MAME) include them.
