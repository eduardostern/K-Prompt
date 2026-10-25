; ZMODEM for TERM and I1TERM: files to and from the tape, as .tap images.
;
; A Spectrum has no disk, so a transfer moves one tape file at a time, in
; the .tap form emulators use (blocks of: length, flag, data, checksum):
;   download  the other end starts sending (TERM sees its ZRQINIT go by and
;             calls zrecv): the file lands in the buffer, then each block
;             is SAVEd to the tape in the deck through the ROM's SA-BYTES.
;   upload    EXTEND then U calls zupload: the ROM's LD-BYTES loads the next
;             header and its data from the tape, they are put together as
;             a .tap image in the buffer, and zsend sends it.
; The protocol is A-Prompt's ZMODEM.COM (CRC-16, hex and binary headers,
; ZRPOS to resume after an error) for the Z80, with positions in 16 bits
; and timeouts counted in frames (FRAMES, 50 a second). BREAK cancels.
; The modem is reached through TERM's mpoll and send (io-*.asm); the
; screen through its puts and emit. K-Prompt, MIT licence.

FRAMES  equ 5C78h
BREAKK  equ 1F54h       ; the ROM's BREAK test: carry clear if pressed
SABYTES equ 04C2h
LDBYTES equ 0556h
ZBUF    equ 0A000h      ; the transfer buffer, below the UDGs
ZBUFMAX equ 0FF00h - ZBUF

ZDLE    equ 18h
ZCAN    equ 18h
XON     equ 11h
ZRQINI  equ 0
ZRINIT  equ 1
ZSINIT  equ 2
ZACK    equ 3
ZFILE   equ 4
ZSKIP   equ 5
ZNAK    equ 6
ZFIN    equ 8
ZRPOS   equ 9
ZDATA   equ 10
ZEOF    equ 11
ZCHALL  equ 14
ZCRCE   equ 68h
ZCRCG   equ 69h
ZCRCQ   equ 6Ah
ZCRCW   equ 6Bh
RXFLGS  equ 03h         ; ZRINIT: can full duplex, can overlap I/O

; ---- watching for a download -----------------------------------------------

; Called with each byte that comes in: carry set when it completes a
; ZRQINIT hex header's start (** ZDLE B 0 0). A is kept.
zwatch: push hl
        push bc
        ld c, a
        ld a, (zwst)
        ld hl, zpat
        add a, l
        ld l, a
        jp nc, zw1
        inc h
zw1:    ld a, c
        cp (hl)
        jp nz, zwmiss
        ld a, (zwst)
        inc a
        cp 6
        jp z, zwhit
        ld (zwst), a
        jp zwno
zwmiss: xor a           ; a '*' may start it again
        cp c
        ld a, c
        cp '*'
        ld a, 0
        jp nz, zw2
        inc a
zw2:    ld (zwst), a
zwno:   ld a, c
        pop bc
        pop hl
        and a
        ret
zwhit:  xor a
        ld (zwst), a
        ld a, c
        pop bc
        pop hl
        scf
        ret
zpat:   db '*', '*', ZDLE, 'B', '0', '0'
zwst:   db 0

; ---- receive: one file into the buffer, then onto the tape -----------------

zrecv:  ld (zsavsp), sp
        ld hl, szrcv
        call puts
        xor a
        ld (zerrs), a
        ld (zgot), a
zri:    call zclrtx
        ld a, RXFLGS
        ld (ztxh+3), a
        ld a, ZRINIT
        call zshhdr
zr1:    call zgeth
        jp c, zr1e
        cp ZRQINI
        jp z, zri
        cp ZSINIT
        jp z, zrsin
        cp ZFILE
        jp z, zrfile
        cp ZFIN
        jp z, zrfin
        jp zri
zr1e:   call zerrchk
        jp zri

zrsin:  call zrdata             ; an attention string: not needed
        jp c, zri
        call zclrtx
        ld a, ZACK
        call zshhdr
        jp zr1

zrfile: call zrdata             ; name, NUL, size
        jp nc, zrf1
        call zerrchk
        call zclrtx
        ld a, ZNAK
        call zshhdr
        jp zr1
zrf1:   xor a
        ld (zerrs), a
        call zgetname
        ld hl, szfile
        call puts
        ld hl, zname
        call puts
        call zgetsize           ; HL = size; carry set if too big
        jp nc, zrf2
        ld hl, sztoobig
        call puts
        call zclrtx
        ld a, ZSKIP
        call zshhdr
        jp zr1
zrf2:   ld hl, 0
        ld (zrxpos), hl
        ld hl, ZBUF
        ld (zbufp), hl

zrp:    ld hl, zrxpos           ; ZRPOS: send from here
        call zsettx
        ld a, ZRPOS
        call zshhdr
zrd:    call zgeth
        jp c, zrde
        cp ZDATA
        jp z, zrdf
        cp ZEOF
        jp z, zreof
        cp ZFILE                ; it missed our ZRPOS
        jp z, zrfag
        cp ZNAK
        jp z, zrp
        cp ZFIN
        jp z, zrfin
        jp zrd
zrde:   call zerrchk
        jp zrp
zrfag:  call zrdata
        jp zrp

zrdf:   call zsamepos           ; data for where we are?
        jp nz, zrp
zrsub:  call zrdata
        jp c, zrse
        xor a
        ld (zerrs), a
        call zappend
        ld a, (zend)
        cp ZCRCG
        jp z, zrsub
        cp ZCRCE
        jp z, zrd
        push af                 ; ZCRCQ and ZCRCW want a ZACK
        ld hl, zrxpos
        call zsettx
        ld a, ZACK
        call zshhdr
        pop af
        cp ZCRCQ
        jp z, zrsub
        jp zrd
zrse:   call zerrchk
        jp zrp

zreof:  call zsamepos           ; a stale ZEOF is ignored
        jp nz, zrd
        ld a, 1
        ld (zgot), a
        ld hl, szok
        call puts
        jp zri

zrfin:  call zclrtx
        ld a, ZFIN
        call zshhdr
        ld b, 2                 ; the sender's "OO"
        call zrecvb
        ld b, 2
        call zrecvb
        ld a, (zgot)
        or a
        jp z, zrdone
        call ztapesave
zrdone: ld sp, (zsavsp)
        ret

; The file name from SUBBUF (up to its NUL), at most 20 characters, in zname.
zgetname:
        ld hl, zsub
        ld de, zname
        ld b, 20
zgn1:   ld a, (hl)
        or a
        jp z, zgn2
        ld (de), a
        inc hl
        inc de
        djnz zgn1
zgn2:   xor a
        ld (de), a
        ret

; The size after the name's NUL, in decimal: HL, carry set if it is
; more than the buffer holds.
zgetsize:
        ld hl, zsub
zgs1:   ld a, (hl)
        inc hl
        or a
        jp nz, zgs1
        ex de, hl
        ld hl, 0
zgs2:   ld a, (de)
        sub '0'
        jp c, zgs3
        cp 10
        jp nc, zgs3
        push de
        ld b, h                 ; HL = HL x 10 + digit
        ld c, l
        add hl, hl
        jp c, zgsbig
        add hl, hl
        jp c, zgsbig
        add hl, bc
        jp c, zgsbig
        add hl, hl
        jp c, zgsbig
        ld c, a
        ld b, 0
        add hl, bc
        jp c, zgsbig
        pop de
        inc de
        jp zgs2
zgsbig: pop de
        scf
        ret
zgs3:   push hl
        ld de, ZBUFMAX + 1
        and a
        sbc hl, de
        pop hl
        ccf                     ; carry set when HL > ZBUFMAX
        ret

; ZSAMEPOS: Z when the received header holds the position we have.
zsamepos:
        ld hl, (zhdr)
        ld de, (zrxpos)
        and a
        sbc hl, de
        ret nz
        ld hl, (zhdr+2)
        ld a, h
        or l
        ret

; ZAPPEND: the subpacket into the buffer; too big fails.
zappend:
        ld bc, (zsublen)
        ld hl, (zrxpos)
        add hl, bc
        jp c, zapbig
        ld de, ZBUFMAX + 1
        push hl
        and a
        sbc hl, de
        pop hl
        jp nc, zapbig
        ld (zrxpos), hl
        ld a, b
        or c
        ret z
        ld de, (zbufp)
        ld hl, zsub
        ldir
        ld (zbufp), de
        call zdot
        ret
zapbig: ld hl, sztoobig
        jp zfail

; ---- send: the buffer (zlen bytes, named zname) ---------------------------

zsend:  ld (zsavsp), sp
        ld hl, szrz             ; "rz" starts a Unix receiver
        call zputs
        xor a
        ld (zerrs), a
zsq:    call zclrtx
        ld a, ZRQINI
        call zshhdr
zs1:    call zgeth
        jp c, zs1e
        cp ZRINIT
        jp z, zsfile
        cp ZCHALL               ; echo the challenge back
        jp nz, zs1
        ld hl, zhdr
        call zsettx
        ld a, ZACK
        call zshhdr
        jp zs1
zs1e:   call zerrchk
        jp zsq

zsfile: xor a
        ld (zerrs), a
zsf0:   call zmkinfo            ; name, NUL, size, NUL
        call zclrtx
        ld a, ZFILE
        call zsbhdr
        ld hl, zsub
        ld a, ZCRCW
        call zsdata
zs2:    call zgeth
        jp c, zs2e
        cp ZRPOS
        jp z, zspos
        cp ZSKIP
        jp z, zsfin
        jp zs2                  ; a repeated ZRINIT is stale: wait
zs2e:   call zerrchk
        jp zsf0

zspos:  ld hl, (zhdr)           ; (re)start where the receiver says
        ld (ztxpos), hl
        ld de, (zlen)
        and a
        sbc hl, de
        jp nc, zseof            ; at or past the end
        ld hl, ztxpos
        call zsettx
        ld a, ZDATA
        call zsbhdr

zsloop: ld hl, 0                ; one subpacket of up to 1K
        ld (zcrc), hl
        ld bc, 1024
zsl1:   ld hl, (ztxpos)
        ld de, (zlen)
        and a
        sbc hl, de
        jp nc, zsleof
        add hl, de
        ld de, ZBUF
        add hl, de
        ld a, (hl)
        call zputc
        ld hl, (ztxpos)
        inc hl
        ld (ztxpos), hl
        dec bc
        ld a, b
        or c
        jp nz, zsl1
        ld a, ZCRCG
        ld (zend), a
        call zsend1
        call zdot
        call zschk              ; the receiver may want a ZRPOS
        jp zsloop
zsleof: ld a, ZCRCE
        ld (zend), a
        call zsend1

zseof:  ld hl, ztxpos
        call zsettx
        ld a, ZEOF
        call zsbhdr
zs3:    call zgeth
        jp c, zs3e
        cp ZRINIT
        jp z, zsfin
        cp ZRPOS
        jp z, zspos
        jp zs3
zs3e:   call zerrchk
        jp zseof

zsfin:  xor a
        ld (zerrs), a
zsf1:   call zclrtx
        ld a, ZFIN
        call zshhdr
zs4:    call zgeth
        jp c, zs4e
        cp ZFIN
        jp nz, zs4
        ld a, 'O'
        call zputraw
        call zputraw
        ld hl, szsent
        call puts
        ld sp, (zsavsp)
        ret
zs4e:   call zerrchk
        jp zsf1

; ZSCHK: a '*' from the receiver while sending starts a header.
zschk:  call mpoll
        ret nc
        cp '*'
        ret nz
        call zgstar
        ret c
        cp ZRPOS
        ret nz
        pop hl                  ; drop the return address
        jp zspos

; ZMKINFO: name, NUL, decimal size, NUL in SUBBUF; zsublen = its length.
zmkinfo:
        ld hl, zname
        ld de, zsub
zmi1:   ld a, (hl)
        ld (de), a
        inc hl
        inc de
        or a
        jp nz, zmi1
        ld hl, (zlen)
        call zdec
        xor a
        ld (de), a
        inc de
        ex de, hl
        ld de, zsub
        and a
        sbc hl, de
        ld (zsublen), hl
        ret

; ZDEC: HL in decimal at DE; DE ends after the last digit.
zdec:   ld bc, 0                ; end marker
        push bc
zdc1:   call zdiv10             ; HL /= 10, A = remainder
        add a, '0'
        ld c, a
        push bc
        ld a, h
        or l
        jp nz, zdc1
zdc2:   pop bc
        ld a, c
        or a
        ret z
        ld (de), a
        inc de
        jp zdc2

zdiv10: push bc
        ld b, 16
        xor a
zdv1:   add hl, hl
        rla
        cp 10
        jp c, zdv2
        sub 10
        inc l
zdv2:   djnz zdv1
        pop bc
        ret

; ---- frames ----------------------------------------------------------------

; ZGETH: waits for a header. A = frame type with carry clear and the four
; header bytes in zhdr; carry set on error (A = 0) or cancel (A = 1).
zgeth:  xor a
        ld (zcans), a
zg0:    ld b, 10
        call zrecvb
        jp c, zgerr
        cp '*'
        jp z, zg1
        cp ZCAN
        jp nz, zgg
        ld a, (zcans)           ; five CANs cancel
        inc a
        ld (zcans), a
        cp 5
        jp c, zg0
        jp zgcan
zgg:    xor a                   ; noise: only silence is an error
        ld (zcans), a
        jp zg0
zgerr:  xor a
        scf
        ret
zgcan:  ld a, 1
        scf
        ret

; ZGSTAR: as ZGETH, after a '*' already read.
zgstar: xor a
        ld (zcans), a
zg1:    ld b, 10
        call zrecvb
        jp c, zgerr
        cp '*'
        jp z, zg1
        cp ZDLE
        jp nz, zgg
        call zrecvb
        jp c, zgerr
        cp 'A'
        jp z, zgbin
        cp 'B'
        jp z, zghex
        jp zgg

zgbin:  ld hl, 0                ; binary header, CRC-16
        ld (zcrc), hl
        ld hl, zhtype
        ld e, 5
zgb1:   call zdlrd
        jp c, zgbad
        ld (hl), a
        call zcrcup
        inc hl
        dec e
        jp nz, zgb1
        call zdlrd
        jp c, zgbad
        ld (zrcrc+1), a
        call zdlrd
        jp c, zgbad
        ld (zrcrc), a
        jp zgchk
zgbad:  cp 1
        jp z, zgcan
        jp zgerr

zghex:  ld hl, 0                ; hex header
        ld (zcrc), hl
        ld hl, zhtype
        ld e, 5
zgh1:   call zgethex
        jp c, zgerr
        ld (hl), a
        call zcrcup
        inc hl
        dec e
        jp nz, zgh1
        call zgethex
        jp c, zgerr
        ld (zrcrc+1), a
        call zgethex
        jp c, zgerr
        ld (zrcrc), a

zgchk:  ld hl, (zcrc)
        ld de, (zrcrc)
        and a
        sbc hl, de
        jp nz, zgerr
        ld a, (zhtype)
        and a
        ret

; ZGETHEX: two hex digits; A = byte, carry set on error.
zgethex:
        call zhexnib
        ret c
        rlca
        rlca
        rlca
        rlca
        ld c, a
        call zhexnib
        ret c
        or c
        ret
zhexnib:
        ld b, 10
        call zrecvb
        ret c
        sub '0'
        jp c, zhxbad
        cp 10
        jp c, zhxok
        sub 'a' - '0'
        jp c, zhxbad
        cp 6
        jp nc, zhxbad
        add a, 10
zhxok:  and a
        ret
zhxbad: xor a
        scf
        ret

; ZDLRD: one ZDLE-decoded byte. Carry clear: A = data. Carry set: A = 0
; error or timeout, 1 cancel, or the subpacket end (ZCRCE..ZCRCW).
zdlrd:  ld b, 10
zdl0:   call zrecvb
        jp c, zdlto
        cp ZDLE
        jp z, zdl1
        cp XON                  ; flow control is noise here
        jp z, zdl0
        cp 13h
        jp z, zdl0
        cp 91h
        jp z, zdl0
        cp 93h
        jp z, zdl0
        and a
        ret
zdl1:   call zrecvb
        jp c, zdlto
        cp ZCAN                 ; ZDLE CAN: a cancel
        jp z, zdlcan
        cp ZCRCE
        jp c, zdl2
        cp ZCRCW + 1
        jp c, zdlend
        cp 6Ch                  ; ZRUB0
        jp nz, zdl3
        ld a, 7Fh
        and a
        ret
zdl3:   cp 6Dh                  ; ZRUB1
        jp nz, zdl2
        ld a, 0FFh
        and a
        ret
zdl2:   cp XON
        jp z, zdl1
        cp 13h
        jp z, zdl1
        cp 91h
        jp z, zdl1
        cp 93h
        jp z, zdl1
        ld c, a
        and 60h
        cp 40h
        jp nz, zdlto
        ld a, c
        xor 40h
        and a
        ret
zdlend: scf
        ret
zdlto:  xor a
        scf
        ret
zdlcan: ld a, 1
        scf
        ret

; ZRDATA: a data subpacket into zsub, length in zsublen, its end in zend.
; Carry set on error (A = 0) or cancel (A = 1).
zrdata: ld hl, 0
        ld (zcrc), hl
        ld hl, zsub
        ld de, 0
zrd1:   call zdlrd
        jp c, zrdsp
        ld (hl), a
        call zcrcup
        inc hl
        inc de
        ld a, d                 ; at most 1K
        cp 4
        jp c, zrd1
        jp nz, zrdbad
        ld a, e
        or a
        jp z, zrd1
zrdbad: xor a
        scf
        ret
zrdsp:  cp ZCRCE
        jp c, zrderr
        ld (zend), a
        call zcrcup             ; the end byte is in the CRC
        ld (zsublen), de
        call zdlrd
        jp c, zrderr
        ld (zrcrc+1), a
        call zdlrd
        jp c, zrderr
        ld (zrcrc), a
        ld hl, (zcrc)
        ld de, (zrcrc)
        and a
        sbc hl, de
        jp nz, zrdbad
        ld a, (zend)
        and a
        ret
zrderr: cp 1
        jp nz, zrdbad
        scf
        ret

; ZSHHDR: hex header of type A with ztxh.
zshhdr: push af
        ld a, '*'
        call zputraw
        call zputraw
        ld a, ZDLE
        call zputraw
        ld a, 'B'
        call zputraw
        ld hl, 0
        ld (zcrc), hl
        pop af
        push af
        call zshhb
        ld hl, ztxh
        ld b, 4
zshh1:  ld a, (hl)
        call zshhb
        inc hl
        djnz zshh1
        ld a, (zcrc+1)
        call zphex
        ld a, (zcrc)
        call zphex
        ld a, 13
        call zputraw
        ld a, 8Ah
        call zputraw
        pop af
        cp ZFIN
        ret z
        cp ZACK
        ret z
        ld a, XON
        jp zputraw

zshhb:  call zcrcup
zphex:  push af                 ; two lower-case hex digits
        rrca
        rrca
        rrca
        rrca
        call zpnib
        pop af
zpnib:  and 0Fh
        add a, '0'
        cp '9' + 1
        jp c, zputraw
        add a, 'a' - '9' - 1
        jp zputraw

; ZSBHDR: binary header (CRC-16) of type A with ztxh.
zsbhdr: push af
        ld a, '*'
        call zputraw
        ld a, ZDLE
        call zputraw
        ld a, 'A'
        call zputraw
        ld hl, 0
        ld (zcrc), hl
        pop af
        call zputc
        ld hl, ztxh
        ld b, 4
zsbh1:  ld a, (hl)
        call zputc
        inc hl
        djnz zsbh1
        ld a, (zcrc+1)
        call zput
        ld a, (zcrc)
        jp zput

; ZSDATA: a subpacket of zsublen bytes at HL, ending with A.
zsdata: ld (zend), a
        push hl
        ld hl, 0
        ld (zcrc), hl
        ld bc, (zsublen)
        pop hl
zsd1:   ld a, b
        or c
        jp z, zsend1
        ld a, (hl)
        call zputc
        inc hl
        dec bc
        jp zsd1

; ZSEND1: ends a subpacket with zend and its CRC.
zsend1: ld a, ZDLE
        call zputraw
        ld a, (zend)
        call zputraw
        call zcrcup
        ld a, (zcrc+1)
        call zput
        ld a, (zcrc)
        call zput
        ld a, (zend)
        cp ZCRCW
        ret nz
        ld a, XON
        jp zputraw

zputc:  call zcrcup             ; zput with the CRC
; ZPUT: sends A, ZDLE-escaped where a line might eat it.
zput:   cp ZDLE
        jp z, zpesc
        cp 10h
        jp z, zpesc
        cp XON
        jp z, zpesc
        cp 13h
        jp z, zpesc
        cp 90h
        jp z, zpesc
        cp 91h
        jp z, zpesc
        cp 93h
        jp z, zpesc
        cp 0Dh
        jp z, zpesc
        cp 8Dh
        jp z, zpesc
        jp zputraw
zpesc:  push af
        ld a, ZDLE
        call zputraw
        pop af
        xor 40h
        ; fall through
; ZPUTRAW: one byte to the modem. Keeps every register.
zputraw:
        push af
        push bc
        push de
        push hl
        call send
        pop hl
        pop de
        pop bc
        pop af
        ret

; ZPUTS: the string at HL (0 ends it) to the modem.
zputs:  ld a, (hl)
        or a
        ret z
        call zputraw
        inc hl
        jp zputs

; ---- common ----------------------------------------------------------------

zclrtx: ld hl, 0
        ld (ztxh), hl
        ld (ztxh+2), hl
        ret

zsettx: ld de, ztxh             ; ztxh = the 4 bytes at HL
        ld bc, 4
        ldir
        ret

; ZERRCHK: after a failed header or subpacket (A = 1 for a cancel).
zerrchk:
        cp 1
        ld hl, szcancl
        jp z, zfail
        ld a, (zerrs)
        inc a
        ld (zerrs), a
        cp 10
        ret c
        ld hl, szerrs
        ; fall through
; ZFAIL: cancels the other end, says why (HL) and goes back to TERM.
zfail:  push hl
        ld hl, szcanit
        call zputs
        pop hl
        call puts
        ld sp, (zsavsp)
        ret

; ZRECVB: waits up to B seconds for a modem byte. A = byte with carry
; clear, or carry set on timeout. BREAK cancels. Keeps BC, DE and HL.
zrecvb: push bc
        push de
        push hl
        ld a, b                 ; frames to wait: B x 50
        ld hl, 0
        ld de, 50
zrv0:   add hl, de
        djnz zrv0
        ld (zwait), hl
        ld hl, (FRAMES)
        ld (zstart), hl
zrv1:   call mpoll
        jp c, zrvgot
        call BREAKK
        jp nc, zrvbrk
        ld hl, (FRAMES)
        ld de, (zstart)
        and a
        sbc hl, de
        ld de, (zwait)
        and a
        sbc hl, de
        jp c, zrv1
        pop hl
        pop de
        pop bc
        scf
        ret
zrvgot: pop hl
        pop de
        pop bc
        and a
        ret
zrvbrk: ld hl, szabort
        jp zfail

; ZCRCUP: adds A to the CRC-16/XMODEM in zcrc, bit by bit. Keeps every
; register: the senders print A after it.
zcrcup: push af
        push hl
        push bc
        ld hl, (zcrc)
        xor h
        ld h, a
        ld b, 8
zcu1:   add hl, hl
        jp nc, zcu2
        ld a, h
        xor 10h
        ld h, a
        ld a, l
        xor 21h
        ld l, a
zcu2:   djnz zcu1
        ld (zcrc), hl
        pop bc
        pop hl
        pop af
        ret

zdot:   push af
        push bc
        push de
        push hl
        ld a, '.'
        call emit
        pop hl
        pop de
        pop bc
        pop af
        ret

; ---- the tape --------------------------------------------------------------

; ZTAPESAVE: SAVEs every block of the .tap image in the buffer (zrxpos
; bytes) to the tape, through the ROM: IX = data, DE = length, A = flag.
ztapesave:
        ld hl, szsave
        call puts
        ld hl, ZBUF
        ld de, (zrxpos)
        add hl, de
        ld (zend2), hl          ; where the image ends
        ld hl, ZBUF
zts1:   ld de, (zend2)
        push hl
        and a
        sbc hl, de
        pop hl
        jp nc, ztsok            ; at the end
        ld e, (hl)              ; block length (flag, data, checksum)
        inc hl
        ld d, (hl)
        inc hl
        ld a, d
        or e
        jp z, ztsok
        push hl
        add hl, de
        ld (znext), hl
        pop hl
        ld a, (hl)              ; the flag
        inc hl
        push hl
        pop ix
        dec de                  ; less the flag and the checksum
        dec de
        call SABYTES
        ld hl, (znext)
        jp zts1
ztsok:  ld hl, szsaved
        jp puts

; ZUPLOAD: the next header and its data from the tape, as a .tap image in
; the buffer (header block at ZBUF, data block after it), then zsend.
zupload:
        call hidecur
        ld hl, szload
        call puts
        ld ix, ZBUF + 3         ; the header's 17 bytes
        ld de, 17
        xor a                   ; flag 00h: a header
        scf                     ; LOAD, not VERIFY
        call LDBYTES
        jp nc, zuperr
        ld hl, (ZBUF + 3 + 11)  ; the data's length
        ld (zdlen), hl
        ld de, ZBUFMAX - 30
        and a
        sbc hl, de
        jp nc, zupbig
        ld ix, ZBUF + 24
        ld de, (zdlen)
        ld a, 0FFh
        scf
        call LDBYTES
        jp nc, zuperr
        ; Put the .tap together: 19, 00 flag, header, checksum; length, FFh, data, checksum.
        ld hl, 19
        ld (ZBUF), hl
        xor a
        ld (ZBUF + 2), a
        ld hl, ZBUF + 3
        ld b, 17
        xor a
zup1:   xor (hl)
        inc hl
        djnz zup1
        ld (ZBUF + 20), a
        ld hl, (zdlen)
        inc hl
        inc hl
        ld (ZBUF + 21), hl
        ld a, 0FFh
        ld (ZBUF + 23), a
        ld hl, ZBUF + 24
        ld bc, (zdlen)
        ld e, 0FFh
zup2:   ld a, b
        or c
        jp z, zup3
        ld a, e
        xor (hl)
        ld e, a
        inc hl
        dec bc
        jp zup2
zup3:   ld (hl), e
        inc hl
        ld de, ZBUF
        and a
        sbc hl, de
        ld (zlen), hl
        ; The name: the header's, trimmed, with .tap.
        ld hl, ZBUF + 4
        ld de, zname
        ld b, 10
zup4:   ld a, (hl)
        ld (de), a
        inc hl
        inc de
        djnz zup4
zup5:   dec de                  ; trailing spaces off
        ld a, (de)
        cp ' '
        jp z, zup5
        inc de
        ld hl, sztap
        ld bc, 5
        ldir
        ld hl, szsend
        call puts
        ld hl, zname
        call puts
        jp zsend
zuperr: ld hl, sznotape
        jp puts
zupbig: ld hl, sztoobig
        jp puts

szrcv:  db 13, 10, "[ZMODEM download: BREAK cancels]", 13, 10, 0
szfile: db "Receiving ", 0
szok:   db " OK", 13, 10, 0
szsave: db "Saving to the tape in the deck...", 13, 10, 0
szsaved: db 'Saved. EDIT, then LOAD "" to run it.', 13, 10, 0
szload: db 13, 10, "[ZMODEM upload: loading the next file from tape;", 13, 10
        db "BREAK gives up]", 13, 10, 0
szsend: db "Sending ", 0
szsent: db 13, 10, "Sent.", 13, 10, 0
sztap:  db ".tap", 0
sznotape: db "No file loaded from the tape.", 13, 10, 0
sztoobig: db 13, 10, "Too big for TERM's buffer.", 13, 10, 0
szcancl: db 13, 10, "Cancelled by the other end.", 13, 10, 0
szabort: db 13, 10, "Cancelled.", 13, 10, 0
szerrs: db 13, 10, "Too many errors.", 13, 10, 0
szrz:   db "rz", 13, 0
szcanit: db ZCAN, ZCAN, ZCAN, ZCAN, ZCAN, ZCAN, ZCAN, ZCAN, 8, 8, 8, 8, 8, 8, 8, 8, 0

zsavsp: dw 0
zerrs:  db 0
zgot:   db 0
zcans:  db 0
zend:   db 0
zhtype: db 0            ; the received header: type, then 4 bytes
zhdr:   ds 4
ztxh:   ds 4
zcrc:   dw 0
zrcrc:  dw 0
zsublen: dw 0
zrxpos: dw 0, 0          ; positions go into headers as 4 bytes; the top two stay 0
ztxpos: dw 0, 0
zlen:   dw 0
zdlen:  dw 0
zbufp:  dw 0
zend2:  dw 0
znext:  dw 0
zwait:  dw 0
zstart: dw 0
zname:  ds 26
zsub:   ds 1040
