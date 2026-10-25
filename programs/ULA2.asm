; ULA2: colour clash, fixed in software, on a 48K Spectrum.
;
; A photograph of a beach (programs/beach.png, CC0) on the Spectrum's
; screen. The ULA gives each 8x8 cell two colours, so a picture with palm
; fronds against the sky and the sea comes out in coloured squares: the
; sides of the screen show it that way. Down the middle, columns 8-23 and
; all 192 lines, every pixel line of every cell has its own two colours:
; the program rewrites those 16 attributes for each line while the beam
; is in the border, 192 times a frame. That is the sea in smooth turquoise
; bands and the fronds sharp against the sky.
;
; M swaps the middle between the two (the ULA's way and the fixed way);
; SPACE goes back to BASIC.
;
; How: interrupts in IM 2 with an empty handler, so each frame starts at a
; known T-state; a counted delay, then 192 blocks of exactly 224 T-states,
; one per pixel line, generated with the pictures and their timing by
; scripts/build-ula2.ts (the reasons are written there). The code and data
; sit above 8000h, where the ULA never delays the CPU. A TK90X at 60 Hz has
; 228 T-state lines and a different frame: the band tears, as on one.
;
; K-Prompt, MIT licence. Build: npm run tapes

BORDCR  equ 5C48h
CLS     equ 0D6Bh
STACK   equ 0FD00h      ; our stack, below the IM 2 table
IMTAB   equ 0FE00h      ; 257 bytes of 0FDh: the vector, whatever the bus says
ISR     equ 0FDFDh

        org 8000h

start:  ld (basicsp), sp
        exx             ; BASIC wants its H'L' back
        ld (basichl), hl
        exx
        di
        ld sp, STACK
        xor a
        out (0FEh), a
        ld (BORDCR), a
        ld (clash), a
        ld (mheld), a
        ld hl, scrbmp   ; the picture: the pixels, then the 8x8 attributes
        ld de, 4000h
        ld bc, 6912
        ldir
        ; IM 2: a table of 0FDh and a handler that only returns.
        ld hl, IMTAB
        ld de, IMTAB+1
        ld bc, 256
        ld (hl), 0FDh
        ldir
        ld a, 0C9h      ; RET
        ld (ISR), a
        ld a, IMTAB/256
        ld i, a
        im 2

mloop:  ei
        halt
        ld a, (clash)
        or a
        jp z, sync      ; generated: delay, the 192 lines, then back to after

after:  ld sp, STACK
        ld a, 7Fh       ; the bottom-right half row: SPACE (bit 0), M (bit 2)
        in a, (0FEh)
        rra
        jr nc, leave
        and 2           ; M (now bit 1)
        jr nz, mup
        ld a, (mheld)
        or a
        jr nz, mloop    ; still held from last time
        inc a
        ld (mheld), a
        call swap
        jr mloop
mup:    xor a
        ld (mheld), a
        jr mloop

leave:  di
        ld a, 3Fh
        ld i, a
        im 1
        ld iy, 5C3Ah
        exx
        ld hl, (basichl)
        exx
        ld sp, (basicsp)
        ei
        call CLS
        ret

; Swaps the middle between the fixed picture and the ULA's: its pixels
; differ (they were dithered for other colours), so XOR them in; going to
; the ULA's way also puts back its 8x8 attributes (the band rewrites them
; every frame when fixed).
swap:   ld a, (clash)
        xor 1
        ld (clash), a
        ld ix, lines
        ld de, swapxor
        ld b, 192
sw1:    push bc
        ld l, (ix+0)
        ld h, (ix+1)
        inc ix
        inc ix
        ld b, 16
sw2:    ld a, (de)
        xor (hl)
        ld (hl), a
        inc hl
        inc de
        djnz sw2
        pop bc
        djnz sw1
        ld a, (clash)
        or a
        ret z
        ld hl, scratt+8
        ld de, 5808h
        ld b, 24
sw3:    push bc
        ld bc, 16
        ldir
        ld bc, 16
        add hl, bc
        ex de, hl
        add hl, bc
        ex de, hl
        pop bc
        djnz sw3
        ret

basicsp: dw 0
basichl: dw 0
clash:  db 0            ; 1: the middle shown the ULA's way
mheld:  db 0
