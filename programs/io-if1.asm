; I1TERM's modem I/O: the Interface 1's RS232 at 19200 baud, where
; K-Prompt wires the same telnet modem TERM reaches on its own ports.
;
; The Interface 1 has no UART; its ROM sends and receives every bit by
; timing loops, and so does this, with its own routines: the ROM's (hook
; codes 1Dh and 1Eh) wait over a frame with interrupts off when nothing
; comes, and the keyboard would freeze. These look for a byte for a moment
; and go back to the keys.
;
; The loader runs FORMAT "b";19200 first, which sets the Interface 1's
; BAUD variable to 5: one bit is 26 x (5 + 2) = 182 T-states, the timing
; below. The ports (inverted lines: 1 is a start bit or a 0):
;   EFh out  bit 0 1 = the TX line is the RS232's, bit 4 CTS (send to me)
;   EFh in   bit 3 DTR: the modem can take a byte
;   F7h out  bit 0 TX;  F7h in  bit 7 RX

; The line rests (TX at 0), the Interface 1 driving the RS232.
minit:  ld a, 0EFh
        out (0EFh), a
        xor a
        out (0F7h), a
        ld a, 0EEh
        out (0EFh), a
        ret

; Carry set and A = the byte, if one comes within about 1,400 T-states of
; raising CTS; carry clear (and CTS down) if not. BC and DE are kept.
; Interrupts are off while it listens, and the 48K offers its interrupt
; for only 32 T-states a frame: a loop of nothing but this would rarely
; let the ROM read the keyboard. So when nothing comes it waits (HALT) for
; the next interrupt: when idle, the keys are read every frame, and bytes
; come at most a frame late.
mpoll:  push bc
        push de
        di
        ld a, 0FEh      ; CTS up: the modem may send
        out (0EFh), a
        ld b, 40
rxwait: in a, (0F7h)    ; 35 T-states a look
        rlca
        jr c, rxstart
        djnz rxwait
        ld a, 0EEh      ; nothing: CTS down
        out (0EFh), a
        ei
        halt            ; the keyboard's turn
        pop de
        pop bc
        and a           ; carry clear
        ret
; The start bit: the middle of bit 0 is 1.5 bits (273 T) on. From the IN
; that saw it to the IN that samples bit 0: 61 + 13 x 16 = 269 T.
rxstart:
        ld a, 0EEh      ; CTS down: one byte at a time
        out (0EFh), a
        ld e, 8
        ld d, 0
        ld b, 16
        djnz $
; Each bit: 45 + 13 x 10 + 8 = 183 T-states.
rxbit:  in a, (0F7h)
        rlca            ; carry = the line: 1 for a 0 bit
        ccf
        rr d
        ld b, 10
        djnz $
        nop
        nop
        dec e
        jr nz, rxbit
        ld a, d
        ei
        pop de
        pop bc
        scf
        ret

; Sends A, waiting until the modem can take it: a start bit, 8 bits from
; bit 0 and two stop bits, 182 T-states each.
send:   push bc
        push de
        ld c, a
        ld a, 0EFh      ; the TX line is the RS232's, CTS down
        out (0EFh), a
txwait: in a, (0EFh)
        and 8           ; DTR: the modem is ready
        jr z, txwait
        di
        ld a, 1         ; the start bit
        out (0F7h), a
        ld b, 11        ; 43 + 13 x 11 = 186 T to the first bit
        djnz $
        ld e, 8
; Each bit: 52 + 13 x 10 = 182 T-states.
txbit:  rr c            ; carry = the bit
        ld a, 0
        ccf
        rla             ; A = 1 for a 0 bit
        out (0F7h), a
        ld b, 10
        djnz $
        dec e
        jr nz, txbit
        xor a           ; the stop bits
        out (0F7h), a
        ld b, 28
        djnz $
        ld a, 0EEh
        out (0EFh), a
        ei
        pop de
        pop bc
        ret

banner: db "K-Prompt I1TERM: 64 columns on the Interface 1's RS232,", 13, 10
        db "19200 baud, to the telnet modem. ATI lists the boards,", 13, 10
        db "ATDT 1 dials the first. EDIT (CAPS SHIFT+1) goes back to", 13, 10
        db "BASIC with the call up; RUN 20 comes back. BREAK sends ESC,", 13, 10
        db "EXTEND+letter is CTRL+letter.", 13, 10, 10, 0
