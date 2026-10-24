; TERM: a 64-column terminal for K-Prompt's telnet modem.
;
; The modem is a Hayes modem on two I/O ports, as A-Prompt's on CP/M and
; Ok-Prompt's on the MSX:
;   01BFh  in: status (bit 0 a byte waits, bit 1 ready to send, bit 7 carrier)
;          out: bit 0 is DTR; 0 hangs up
;   02BFh  data, both ways: AT commands in command mode, the line when online.
; BASIC can use it directly: IN 447, IN 703, OUT 703,x.
;
; TERM shows the line 64 columns by 24 rows in a 4-pixel font (Tom Thumb,
; at the end), follows the ANSI codes BBSes send (cursor moves, erasing,
; reverse video, ESC[6n), turns the PC's CP437 box lines into ASCII, and
; sends the cursor keys as ANSI. Keys:
;   EDIT (CAPS SHIFT + 1)    back to BASIC, the call stays up (RUN 20 returns)
;   BREAK (CAPS SHIFT + SPACE) sends ESC
;   EXTEND (CAPS + SYMBOL SHIFT), then a letter: CTRL + that letter;
;   then SYMBOL SHIFT + a key: the E-mode symbols [ ] { } \ | ~
;   DELETE (CAPS SHIFT + 0)  backspace
;
; Loads at 8000h (CLEAR 32767). Keys come from the ROM's interrupt
; (LAST_K and FLAGS bit 5), so interrupts stay on in IM 1 and IY stays
; 5C3Ah. K-Prompt, MIT licence. Build with: npm run term

MSTAT   equ 01BFh
MDATA   equ 02BFh
LAST_K  equ 5C08h
MODE    equ 5C41h
FLAGS2  equ 5C6Ah
CLS     equ 0D6Bh
ESC     equ 1Bh
COLS    equ 64
ROWS    equ 24
ATTR    equ 47h         ; BRIGHT white ink on black paper

        org 8000h

; ---- start ----------------------------------------------------------------

start:  ld a, 0
        out (0FEh), a   ; black border
        ld hl, 5800h    ; colours: one for the whole screen
        ld de, 5801h
        ld bc, 767
        ld (hl), ATTR
        ldir
        call clrall
        xor a
        ld (curon), a
        ld (quit), a
        ld (pstate), a
        ld (revmask), a
        ld (emode), a
        ld (MODE), a
        ld hl, banner
        call puts
        ld bc, MSTAT
        ld a, 1
        out (c), a      ; DTR on
        ei

loop:   ld a, (quit)
        or a
        jr nz, leave
        set 3, (iy+1)   ; L mode: letters come as letters, not keywords
        bit 5, (iy+1)   ; a key from the ROM's keyboard scan?
        call nz, key
        call showcur
        ld bc, MSTAT
        in a, (c)
        rra
        jr nc, loop
        call hidecur
        ld e, 0         ; at most 256 bytes before looking at the keys again
rxloop: ld bc, MDATA
        in a, (c)
        push de
        call emit
        pop de
        dec e
        jr z, loop
        ld bc, MSTAT
        in a, (c)
        rra
        jr c, rxloop
        jr loop

leave:  call hidecur
        call CLS
        ret

; ---- the keyboard ---------------------------------------------------------

key:    res 5, (iy+1)
        ld a, (LAST_K)
        ld c, a
        ld a, (emode)
        or a
        jr nz, kext
        ld a, c
        cp 7            ; EDIT: leave
        jr z, kquit
        cp 0Eh          ; EXTEND: next key is CTRL or an E-mode symbol
        jr z, kemode
        cp 6            ; CAPS LOCK
        jr z, kcaps
        cp 0Ch          ; DELETE
        jr z, kdel
        cp 8            ; cursor keys, as ANSI
        jr z, kleft
        cp 9
        jr z, kright
        cp 0Ah
        jr z, kdown
        cp 0Bh
        jr z, kup
        cp ' '
        jr nz, kplain
        ld bc, 0FEFEh   ; SPACE with CAPS SHIFT held is BREAK: send ESC
        in a, (c)
        rra
        ld a, ' '
        jr c, kplain
        ld a, ESC
kplain: cp 80h          ; keyword tokens (SYMBOL SHIFT + Y is AND...) are not sent
        ret nc
        jp send

kquit:  ld a, 1
        ld (quit), a
        ret
kemode: ld a, 1
        ld (emode), a
        ld (MODE), a    ; the ROM decodes the next key in E mode
        ret
kcaps:  ld a, (FLAGS2)
        xor 8
        ld (FLAGS2), a
        ret
kdel:   ld a, 8
        jp send
kleft:  ld a, 'D'
        jr karrow
kright: ld a, 'C'
        jr karrow
kdown:  ld a, 'B'
        jr karrow
kup:    ld a, 'A'
karrow: push af
        ld a, ESC
        call send
        ld a, '['
        call send
        pop af
        jp send

; After EXTEND: a symbol (SYMBOL SHIFT + key) goes as it is; a letter comes
; as the word above it (SIN, COS...), found in etab to make CTRL + letter.
kext:   xor a
        ld (emode), a
        ld (MODE), a
        ld a, c
        cp 80h
        jr c, kplain
        ld hl, etab
        ld b, 26
kfind:  cp (hl)
        jr z, kfound
        inc hl
        djnz kfind
        ret
kfound: ld a, 27
        sub b           ; A = 1 for A ... 26 for Z: the CTRL code
        jp send

; The E-mode token on each letter key, A to Z.
etab:   db 0E3h, 0C4h, 0E0h, 0E4h, 0B4h, 0BCh, 0BDh, 0BBh, 0AFh, 0B0h, 0B1h, 0C0h, 0A7h
        db 0A6h, 0BEh, 0ADh, 0B2h, 0BAh, 0E5h, 0A5h, 0C2h, 0E1h, 0B3h, 0B9h, 0C1h, 0B8h

; Sends A to the modem, waiting until it can take it.
send:   push bc
        push af
        ld bc, MSTAT
swait:  in a, (c)
        and 2
        jr z, swait
        pop af
        ld bc, MDATA
        out (c), a
        pop bc
        ret

; ---- the screen: one character in, ANSI understood ------------------------

; Prints the zero-terminated string at HL through the terminal.
puts:   ld a, (hl)
        or a
        ret z
        push hl
        call emit
        pop hl
        inc hl
        jr puts

emit:   ld c, a
        ld a, (pstate)
        or a
        jr nz, inesc
        ld a, c
        cp ESC
        jr z, gotesc
        cp ' '
        jp c, control
        cp 7Fh
        jr c, printable
        jr z, ignore
        ; 80h-FFh: the PC's characters, through cptab
        sub 80h
        ld e, a
        ld d, 0
        ld hl, cptab
        add hl, de
        ld a, (hl)
printable:
        push af
        ld a, (col)
        cp COLS         ; a character after the last column wraps first
        call z, newline
        pop af
        call drawch
        ld hl, col
        inc (hl)
ignore: ret

gotesc: ld a, 1
        ld (pstate), a
        ret

; After ESC (state 1), in ESC [ (state 2), or skipping one byte (state 3).
inesc:  cp 1
        jr nz, incsi
        ld a, c
        cp '['
        jr z, csistart
        cp '('
        jr z, skip1
        cp ')'
        jr z, skip1
        cp '7'
        jp z, savecur
        cp '8'
        jp z, restcur
        cp 'c'
        jr z, escreset
        cp 'D'
        jr z, escind
        cp 'M'
        jr z, escrind
        jr escdone
skip1:  ld a, 3
        ld (pstate), a
        ret
escind: call lf
        jr escdone
escrind:
        ld a, (row)
        or a
        jr z, escdone
        dec a
        ld (row), a
        jr escdone
escreset:
        call clrall
        xor a
        ld (revmask), a
escdone:
        xor a
        ld (pstate), a
        ret

csistart:
        ld a, 2
        ld (pstate), a
        xor a
        ld (npar), a
        ld (priv), a
        ld hl, params
        ld (hl), a
        inc hl
        ld (hl), a
        inc hl
        ld (hl), a
        inc hl
        ld (hl), a
        ret

incsi:  cp 3
        jr z, escdone
        ld a, c
        cp '?'
        jr z, csipriv
        cp ';'
        jr z, csinext
        cp '0'
        jr c, csifinal
        cp '9'+1
        jr nc, csifinal
        ; a digit: params[npar] = params[npar] * 10 + digit, up to 255
        sub '0'
        ld b, a
        call parptr
        ld a, (hl)
        cp 26
        jr nc, csibig
        ld e, a
        add a, a
        add a, a
        add a, e        ; x5
        add a, a        ; x10
        add a, b
        jr nc, csiput
csibig: ld a, 255
csiput: ld (hl), a
        ret
csipriv:
        ld a, 1
        ld (priv), a
        ret
csinext:
        ld a, (npar)
        cp 3
        ret z
        inc a
        ld (npar), a
        ret

; HL = &params[npar]
parptr: ld a, (npar)
        ld e, a
        ld d, 0
        ld hl, params
        add hl, de
        ret

csifinal:
        xor a
        ld (pstate), a
        ld a, (priv)
        or a
        ret nz          ; ESC [ ? ... (modes we do not have)
        ld a, c
        cp 'A'
        jp z, cup
        cp 'B'
        jp z, cdown
        cp 'C'
        jp z, cright
        cp 'D'
        jp z, cleft
        cp 'H'
        jp z, cpos
        cp 'f'
        jp z, cpos
        cp 'J'
        jp z, erasedisp
        cp 'K'
        jp z, eraseline
        cp 'm'
        jp z, sgr
        cp 's'
        jr z, savecur
        cp 'u'
        jr z, restcur
        cp 'n'
        jp z, report
        ret

savecur:
        ld a, (row)
        ld (saverow), a
        ld a, (col)
        ld (savecol), a
        jp escdone
restcur:
        ld a, (saverow)
        ld (row), a
        ld a, (savecol)
        ld (col), a
        jp escdone

; The first parameter, 0 counted as 1.
par1:   ld a, (params)
        or a
        ret nz
        inc a
        ret

cup:    call par1
        ld b, a
        ld a, (row)
        sub b
        jr nc, cupok
        xor a
cupok:  ld (row), a
        ret
cdown:  call par1
        ld b, a
        ld a, (row)
        add a, b
        cp ROWS
        jr c, cdok
        ld a, ROWS-1
cdok:   ld (row), a
        ret
cright: call par1
        ld b, a
        ld a, (col)
        add a, b
        cp COLS
        jr c, crok
        ld a, COLS-1
crok:   ld (col), a
        ret
cleft:  call par1
        ld b, a
        ld a, (col)
        cp COLS
        jr c, clok0
        ld a, COLS-1
clok0:  sub b
        jr nc, clok
        xor a
clok:   ld (col), a
        ret

; ESC [ row ; col H, from 1.
cpos:   call par1
        dec a
        cp ROWS
        jr c, cpr
        ld a, ROWS-1
cpr:    ld (row), a
        ld a, (params+1)
        or a
        jr z, cpc0
        dec a
cpc0:   cp COLS
        jr c, cpc
        ld a, COLS-1
cpc:    ld (col), a
        ret

; ESC [ m: 7 reverse, 27 and 0 back to normal; colours are not shown.
sgr:    ld a, (npar)
        inc a
        ld b, a
        ld hl, params
sgr1:   ld a, (hl)
        or a
        jr z, sgroff
        cp 27
        jr z, sgroff
        cp 7
        jr nz, sgrnext
        ld a, 0F0h
        ld (revmask), a
        jr sgrnext
sgroff: xor a
        ld (revmask), a
sgrnext:
        inc hl
        djnz sgr1
        ret

; ESC [ 6 n: answer ESC [ row ; col R.
report: ld a, (params)
        cp 6
        ret nz
        ld a, ESC
        call send
        ld a, '['
        call send
        ld a, (row)
        inc a
        call sendnum
        ld a, ';'
        call send
        ld a, (col)
        cp COLS
        jr c, rpc
        ld a, COLS-1
rpc:    inc a
        call sendnum
        ld a, 'R'
        jp send

; Sends A (0-99) in decimal.
sendnum:
        ld b, '0'-1
sn10:   inc b
        sub 10
        jr nc, sn10
        add a, 10+'0'
        ld c, a
        ld a, b
        cp '0'
        call nz, send
        ld a, c
        jp send

; ESC [ J: 0 to the end, 1 from the start, 2 all.
erasedisp:
        ld a, (params)
        cp 2
        jp z, clrall
        cp 1
        jr z, ed1
        call el0
        ld a, (row)
ed0:    inc a
        cp ROWS
        ret nc
        ld d, a
        push af
        call clrrow
        pop af
        jr ed0
ed1:    call el1
        ld a, (row)
ed1b:   or a
        ret z
        dec a
        ld d, a
        push af
        call clrrow
        pop af
        jr ed1b

; ESC [ K: 0 to the end of the line, 1 from its start, 2 all of it.
eraseline:
        ld a, (params)
        cp 2
        jr z, el2
        cp 1
        jr z, el1
el0:    ld a, (col)
        ld b, a
        ld c, COLS
        jr elfill
el1:    ld b, 0
        ld a, (col)
        inc a
        ld c, a
        jr elfill
el2:    ld a, (row)
        ld d, a
        jp clrrow

; Spaces from column B up to (not including) C on this row; the cursor stays.
elfill: ld a, (col)
        push af
        ld a, (revmask)
        push af
        xor a
        ld (revmask), a
elf1:   ld a, b
        cp c
        jr nc, elf2
        cp COLS
        jr nc, elf2
        ld (col), a
        push bc
        ld a, ' '
        call drawch
        pop bc
        inc b
        jr elf1
elf2:   pop af
        ld (revmask), a
        pop af
        ld (col), a
        ret

control:
        cp 0Dh
        jr z, cr
        cp 0Ah
        jr z, lf
        cp 08h
        jr z, bs
        cp 09h
        jr z, tab
        cp 0Ch
        jp z, clrall
        cp 07h
        jr z, bell
        ret

cr:     xor a
        ld (col), a
        ret
newline:
        call cr
lf:     ld a, (row)
        inc a
        cp ROWS
        jr c, lfok
        call scroll
        ld a, ROWS-1
lfok:   ld (row), a
        ret
bs:     ld a, (col)
        or a
        ret z
        cp COLS
        jr c, bsok
        ld a, COLS-1
bsok:   dec a
        ld (col), a
        ret
tab:    ld a, (col)
        and 0F8h
        add a, 8
        cp COLS
        jr c, tabok
        ld a, COLS-1
tabok:  ld (col), a
        ret

; BEL: a short beep on the speaker, about 1 kHz for a tenth of a second.
bell:   ld e, 200
        xor a
bl1:    xor 10h
        out (0FEh), a
        ld b, 130
bl2:    djnz bl2
        dec e
        jr nz, bl1
        xor a
        out (0FEh), a
        ret

; ---- drawing --------------------------------------------------------------

; HL = screen address of the top line of the cell at row D, column E.
; The bitmap's third is row/8, the line within the third row%8; two
; columns share a byte.
celladdr:
        ld a, d
        and 18h
        or 40h
        ld h, a
        ld a, d
        and 7
        rrca
        rrca
        rrca
        ld l, a
        ld a, e
        srl a
        or l
        ld l, a
        ret

; Draws character A at the cursor (column 0-63).
drawch: sub 20h
        ld l, a
        ld h, 0
        add hl, hl
        add hl, hl
        add hl, hl
        ld de, font4
        add hl, de
        push hl
        ld a, (row)
        ld d, a
        ld a, (col)
        ld e, a
        call celladdr
        pop de          ; DE = glyph, HL = screen
        ld a, (revmask)
        ld c, a
        ld b, 8
        ld a, (col)
        rra
        jr c, dodd
deven:  ld a, (hl)
        and 0Fh
        ld (hl), a
        ld a, (de)
        xor c
        and 0F0h
        or (hl)
        ld (hl), a
        inc de
        inc h
        djnz deven
        ret
dodd:   ld a, (hl)
        and 0F0h
        ld (hl), a
        ld a, (de)
        xor c
        and 0F0h
        rrca
        rrca
        rrca
        rrca
        or (hl)
        ld (hl), a
        inc de
        inc h
        djnz dodd
        ret

; The cursor is the cell inverted.
showcur:
        ld a, (curon)
        or a
        ret nz
        jr togcur
hidecur:
        ld a, (curon)
        or a
        ret z
togcur: ld a, (curon)
        xor 1
        ld (curon), a
        ld a, (row)
        ld d, a
        ld a, (col)
        cp COLS
        jr c, tc1
        ld a, COLS-1
tc1:    ld e, a
        call celladdr
        ld c, 0F0h
        ld a, e
        rra
        jr nc, tc2
        ld c, 0Fh
tc2:    ld b, 8
tc3:    ld a, (hl)
        xor c
        ld (hl), a
        inc h
        djnz tc3
        ret

; Scrolls the screen up one row and clears the bottom row.
scroll: xor a
sc1:    ld (tmprow), a
        ld d, a
        ld e, 0
        call celladdr
        ex de, hl       ; DE = this row
        ld a, (tmprow)
        inc a
        push de
        ld d, a
        ld e, 0
        call celladdr   ; HL = the row below
        pop de
        ld b, 8
sc2:    push bc
        push hl
        push de
        ld bc, 32
        ldir
        pop de
        pop hl
        inc h
        inc d
        pop bc
        djnz sc2
        ld a, (tmprow)
        inc a
        cp ROWS-1
        jr c, sc1
        ld d, ROWS-1
        ; fall through

; Clears row D.
clrrow: ld e, 0
        call celladdr
        ld b, 8
cr1:    push bc
        push hl
        ld d, h
        ld e, l
        inc de
        ld (hl), 0
        ld bc, 31
        ldir
        pop hl
        inc h
        pop bc
        djnz cr1
        ret

; Clears the whole screen and homes the cursor.
clrall: ld hl, 4000h
        ld de, 4001h
        ld bc, 6143
        ld (hl), 0
        ldir
        xor a
        ld (row), a
        ld (col), a
        ld (curon), a
        ret

banner: db "K-Prompt TERM: 64 columns on the telnet modem.", 13, 10
        db "Type AT commands: ATI lists the boards, ATDT 1 dials the first.", 13, 10
        db "EDIT (CAPS SHIFT+1) goes back to BASIC with the call up; RUN 20", 13, 10
        db "comes back. BREAK sends ESC, EXTEND+letter is CTRL+letter.", 13, 10, 10, 0

; ---- variables ------------------------------------------------------------

row:    db 0
col:    db 0
saverow: db 0
savecol: db 0
curon:  db 0
quit:   db 0
pstate: db 0
npar:   db 0
priv:   db 0
params: ds 4
revmask: db 0
emode:  db 0
tmprow: db 0
