; ULA: cheating the ULA, on a 48K Spectrum.
;
; The top of the screen shows colour clash: two balls cross a green
; pattern, and every 8x8 cell they touch takes the ball's colour, pattern
; and all; where they meet, one ball takes the other's colour. Below it,
; MULTICOLOUR: a band 12 cells wide and 8 tall whose every pixel line has
; its own colours. The ULA reads the attributes again for each of a cell's
; 8 lines, so a program can rewrite them between lines. Beside the band,
; the same rainbow with one colour per cell, as the ULA normally allows.
;
; How: interrupts in IM 2 with an empty handler, so each frame starts at a
; known T-state. A counted delay reaches the band, then 64 blocks of code,
; one per pixel line, each exactly 224 T-states (one line): point SP at
; the band's attribute row and PUSH the 12 colours for the next pixel line
; while the beam is in the border, then POP the following line's colours
; from a table. The blocks, the delay and the table pointers are generated
; by scripts/build-ula.ts, which counts the T-states; this file is the rest.
;
; The code and its tables sit above 8000h, where the ULA never delays the
; CPU, and the colours are written while the beam is away from the band's
; columns, so the timing holds on a real 48K. A TK90X at 60 Hz has 228
; T-state lines and a different frame: the band tears, as it did on one.
;
; SPACE goes back to BASIC. K-Prompt, MIT licence. Build: npm run tapes

CLS     equ 0D6Bh
CHANOPN equ 1601h
ATTR_P  equ 5C8Dh
BORDCR  equ 5C48h
STACK   equ 0BD00h      ; our stack, below the IM 2 table
IMTAB   equ 0BD00h      ; 257 bytes of 0BEh: the vector, whatever the bus says
ISR     equ 0BEBEh
BG      equ 04h         ; green ink, black paper: the clash area
YELLOW  equ 46h
RED     equ 42h

        org 8000h

start:  ld (basicsp), sp
        ld sp, STACK
        xor a
        out (0FEh), a
        ld (BORDCR), a
        ld a, 07h
        ld (ATTR_P), a
        call CLS
        ld a, 2
        call CHANOPN
        ld hl, text
        call print
        call drawbg
        ld ix, ball1    ; the balls go on once here; each frame XORs them
        call xorball    ; off at the old place and on at the new one
        ld ix, ball2
        call xorball
        ; IM 2: a table of 0BEh and a handler that only returns.
        di
        ld hl, IMTAB
        ld de, IMTAB+1
        ld bc, 256
        ld (hl), 0BEh
        ldir
        ld a, 0C9h      ; RET
        ld (ISR), a
        ld a, IMTAB/256
        ld i, a
        im 2
        call patch

mloop:  ei
        halt
        jp sync         ; generated: delay, then the band, then back to after

after:  ld sp, STACK
        xor a           ; the speaker back in after a bounce's click
        out (0FEh), a
        call patch
        call compare
        call balls
        ld a, 7Fh       ; SPACE?
        in a, (0FEh)
        rra
        jr c, mloop

leave:  di
        ld a, 3Fh
        ld i, a
        im 1
        ld iy, 5C3Ah
        ld sp, (basicsp)
        ei
        call CLS
        ret

basicsp: dw 0
phase:  db 0

; ---- the colours for the next frame ----------------------------------------

; The band's line k, column c shows gseq[phase + k + c]: the generated
; setptrs puts gseq + phase + k into the band code's LD SP instructions,
; so the rainbow runs diagonally and moves each frame.
patch:  ld a, (phase)
        inc a
        cp 12
        jr c, pa1
        xor a
pa1:    ld (phase), a
        ld e, a
        ld d, 0
        ld hl, gseq
        add hl, de
        jp setptrs      ; generated: 65 x (LD (nn),HL : INC HL), RET

; The 8x8 comparison beside the band: cell row r takes one colour, the one
; the band shows on that row's middle line, as the ULA alone would allow.
compare:
        ld a, (phase)
        add a, 4
        ld e, a
        ld d, 0
        ld hl, gseq
        add hl, de
        ex de, hl       ; DE = colours
        ld hl, 5800h + 8*32 + 1
        ld c, 8
co1:    ld a, (de)
        ld b, 8
co2:    ld (hl), a
        inc hl
        djnz co2
        push de
        ld de, 24
        add hl, de
        pop de
        ld a, e         ; next row's colour is 8 lines further on
        add a, 8
        ld e, a
        jr nc, co3
        inc d
co3:    dec c
        jr nz, co1
        ret

; ---- colour clash: two balls over a pattern --------------------------------

; The pattern: an X in every cell of rows 3-6, green on black.
drawbg: ld b, 24
bg1:    ld c, 0
        call pixaddr
        ld a, b
        and 7
        ld e, a
        ld a, 80h
        inc e
bg2:    dec e
        jr z, bg3
        rrca
        jr bg2
bg3:    ld e, a         ; one diagonal
        ld a, b
        and 7
        ld d, a
        ld a, 01h
        inc d
bg4:    dec d
        jr z, bg5
        rlca
        jr bg4
bg5:    or e            ; and the other
        ld d, 32
bg6:    ld (hl), a
        inc l
        dec d
        jr nz, bg6
        inc b
        ld a, b
        cp 56
        jr c, bg1
        ret

; HL = screen address of pixel column C, line B.
pixaddr:
        ld a, b
        and 7
        or 40h
        ld h, a
        ld a, b
        rra
        rra
        rra
        and 18h
        or h
        ld h, a
        ld a, b
        rla
        rla
        and 0E0h
        ld l, a
        ld a, c
        rra
        rra
        rra
        and 1Fh
        or l
        ld l, a
        ret

; XORs the ball at (IX+0, IX+1) into the bitmap, from ballsh: the ball
; already shifted to each of the 8 pixel positions in a byte (generated).
xorball:
        ld c, (ix+0)
        ld b, (ix+1)
        ld a, c
        and 7
        add a, a
        add a, a
        add a, a
        add a, a        ; shift x 16 bytes
        ld e, a
        ld d, 0
        ld hl, ballsh
        add hl, de
        ex de, hl
        ld a, 8
xb1:    push af
        push bc
        call pixaddr
        ld a, (de)
        xor (hl)
        ld (hl), a
        inc de
        inc l
        ld a, (de)
        xor (hl)
        ld (hl), a
        inc de
        pop bc
        inc b
        pop af
        dec a
        jr nz, xb1
        ret

; Colours the cells under the ball at IX with A: up to 2 x 2 cells.
paintball:
        ld e, a
        ld a, (ix+1)
        call pb1
        ld a, (ix+1)
        add a, 7
pb1:    rra             ; row = y / 8
        rra
        rra
        and 1Fh
        ld l, a
        ld h, 0
        add hl, hl
        add hl, hl
        add hl, hl
        add hl, hl
        add hl, hl
        ld bc, 5800h
        add hl, bc
        ld a, (ix+0)
        rra
        rra
        rra
        and 1Fh
        ld c, a
        ld b, 0
        add hl, bc
        ld (hl), e
        ld a, (ix+0)
        and 7
        ret z
        inc hl
        ld (hl), e
        ret

; Moves the ball at IX by its speed (IX+2, IX+3), bouncing off the edges
; of the pattern with a click on the beeper.
move:   ld a, (ix+0)
        add a, (ix+2)
        cp 241
        jr c, mv1
        call bounce
        ld a, (ix+2)
        neg
        ld (ix+2), a
        ld a, (ix+0)
mv1:    ld (ix+0), a
        ld a, (ix+1)
        add a, (ix+3)
        cp 24
        jr c, mv2
        cp 49
        jr c, mv3
mv2:    call bounce
        ld a, (ix+3)
        neg
        ld (ix+3), a
        ld a, (ix+1)
mv3:    ld (ix+1), a
        ret

; A bounce clicks the beeper: the speaker goes out here and back at the
; start of the next frame's work, one edge each way, nearly free.
bounce: ld a, 10h
        out (0FEh), a
        ret

balls:  ld ix, ball1
        call xorball
        call move
        call xorball
        ld ix, ball2
        call xorball
        call move
        call xorball
        ; The pattern's colours back, then each ball paints its cells:
        ; the second ball painted last wins where they share a cell.
        ld hl, 5800h + 3*32
        ld de, 5800h + 3*32 + 1
        ld bc, 4*32 - 1
        ld (hl), BG
        ldir
        ld ix, ball1
        ld a, YELLOW
        call paintball
        ld ix, ball2
        ld a, RED
        call paintball
        ret

; x, y, dx, dy
ball1:  db 20, 30, 2, 1
ball2:  db 200, 40, 254, 255

; ---- the text ----------------------------------------------------------------

; Prints the 0FFh-terminated text at HL through the ROM (control codes allowed).
print:  ld a, (hl)
        cp 0FFh
        ret z
        rst 10h
        inc hl
        jr print

AT      equ 22
INK     equ 16
PAPER   equ 17
BRIGHT  equ 19
INVERSE equ 20

text:   db AT, 0, 7, INK, 6, BRIGHT, 1, "CHEATING THE ULA", BRIGHT, 0
        db AT, 2, 0, INK, 5, "COLOUR CLASH: 2 COLOURS PER 8x8"
        db AT, 7, 1, INK, 7, "8x8", AT, 7, 10, "MULTICOLOUR 8x1"
        ; The band and its 8x8 twin: text, and solid rows (inverse spaces).
        db AT, 8, 1, "CHEATING", AT, 8, 10, "CHEATING THE"
        db AT, 9, 1, "  ULA   ", AT, 9, 10, "    ULA     "
        db AT, 10, 1, INVERSE, 1, "        ", AT, 10, 10, "            "
        db AT, 11, 1, "        ", AT, 11, 10, "            ", INVERSE, 0
        db AT, 12, 1, "  ONE   ", AT, 12, 10, " EVERY PIXEL"
        db AT, 13, 1, " COLOUR ", AT, 13, 10, " LINE HAS   "
        db AT, 14, 1, "PER CELL", AT, 14, 10, " ITS OWN INK"
        db AT, 15, 1, INVERSE, 1, "        ", AT, 15, 10, "            ", INVERSE, 0
        db AT, 9, 23, INK, 5, "THE ULA", AT, 10, 23, "READS THE", AT, 11, 23, "COLOURS"
        db AT, 12, 23, "AGAIN FOR", AT, 13, 23, "EACH LINE"
        db AT, 17, 0, INK, 7, "THIS PROGRAM REWRITES THEM 64"
        db AT, 18, 0, "TIMES A FRAME, EACH ONE TIMED"
        db AT, 19, 0, "TO THE T-STATE. 48K TIMING: ON A"
        db AT, 20, 0, "TK90X AT 60 HZ THE BAND TEARS."
        db AT, 21, 0, INK, 6, "SPACE: BACK TO BASIC", INK, 7
        db 0FFh

; ---- generated by scripts/build-ula.ts: sync and the 64 line blocks, setptrs,
; gseq (the colours) and ballsh (the shifted ball)
