; TERM's modem I/O: K-Prompt's Hayes modem on two I/O ports, as A-Prompt's
; on CP/M and Ok-Prompt's on the MSX:
;   01BFh  in: status (bit 0 a byte waits, bit 1 ready to send, bit 7 carrier)
;          out: bit 0 is DTR; 0 hangs up
;   02BFh  data, both ways: AT commands in command mode, the line when online.
; BASIC can use it directly: IN 447, IN 703, OUT 703,x.

MSTAT   equ 01BFh
MDATA   equ 02BFh

; DTR on.
minit:  ld bc, MSTAT
        ld a, 1
        out (c), a
        ret

; Carry set and A = the byte, if one waits.
mpoll:  ld bc, MSTAT
        in a, (c)
        rra
        ret nc
        ld bc, MDATA
        in a, (c)
        scf
        ret

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

banner: db "K-Prompt TERM: 64 columns on the telnet modem.", 13, 10
        db "Type AT commands: ATI lists the boards, ATDT 1 dials the first.", 13, 10
        db "EDIT (CAPS SHIFT+1) goes back to BASIC with the call up; RUN 20", 13, 10
        db "comes back. BREAK sends ESC, EXTEND+letter is CTRL+letter.", 13, 10, 10, 0
