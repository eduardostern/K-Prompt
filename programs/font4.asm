; Tom Thumb, a 4x6 font in a 4x8 cell: characters 20h-7Fh, 8 bytes each,
; the pixels in bits 7-4 (bit 4 is the gap between characters).
;
; Copyright 1999 Brian J. Swetland, 1999 Vassilii Khachaturov; portions
; copyright Dan Marks; readability changes by Robey Pointer. 3-clause BSD
; licence: redistributions must keep this notice, the conditions and the
; disclaimer; the authors' names may not be used to endorse derived products.
; THE SOFTWARE IS PROVIDED AS IS, WITHOUT WARRANTIES; the full licence is
; in FONT-LICENSE.txt. Converted from Adafruit GFX's TomThumb.h for K-Prompt.

font4:
        db 000h, 000h, 000h, 000h, 000h, 000h, 000h, 000h   ;  
        db 000h, 080h, 080h, 080h, 000h, 080h, 000h, 000h   ; !
        db 000h, 0A0h, 0A0h, 000h, 000h, 000h, 000h, 000h   ; "
        db 000h, 0A0h, 0E0h, 0A0h, 0E0h, 0A0h, 000h, 000h   ; #
        db 000h, 060h, 0C0h, 060h, 0C0h, 040h, 000h, 000h   ; $
        db 000h, 080h, 020h, 040h, 080h, 020h, 000h, 000h   ; %
        db 000h, 0C0h, 0C0h, 0E0h, 0A0h, 060h, 000h, 000h   ; &
        db 000h, 080h, 080h, 000h, 000h, 000h, 000h, 000h   ; '
        db 000h, 040h, 080h, 080h, 080h, 040h, 000h, 000h   ; (
        db 000h, 080h, 040h, 040h, 040h, 080h, 000h, 000h   ; )
        db 000h, 0A0h, 040h, 0A0h, 000h, 000h, 000h, 000h   ; *
        db 000h, 000h, 040h, 0E0h, 040h, 000h, 000h, 000h   ; +
        db 000h, 000h, 000h, 000h, 040h, 080h, 000h, 000h   ; ,
        db 000h, 000h, 000h, 0E0h, 000h, 000h, 000h, 000h   ; -
        db 000h, 000h, 000h, 000h, 000h, 080h, 000h, 000h   ; .
        db 000h, 020h, 020h, 040h, 080h, 080h, 000h, 000h   ; /
        db 000h, 060h, 0A0h, 0A0h, 0A0h, 0C0h, 000h, 000h   ; 0
        db 000h, 040h, 0C0h, 040h, 040h, 040h, 000h, 000h   ; 1
        db 000h, 0C0h, 020h, 040h, 080h, 0E0h, 000h, 000h   ; 2
        db 000h, 0C0h, 020h, 040h, 020h, 0C0h, 000h, 000h   ; 3
        db 000h, 0A0h, 0A0h, 0E0h, 020h, 020h, 000h, 000h   ; 4
        db 000h, 0E0h, 080h, 0C0h, 020h, 0C0h, 000h, 000h   ; 5
        db 000h, 060h, 080h, 0E0h, 0A0h, 0E0h, 000h, 000h   ; 6
        db 000h, 0E0h, 020h, 040h, 080h, 080h, 000h, 000h   ; 7
        db 000h, 0E0h, 0A0h, 0E0h, 0A0h, 0E0h, 000h, 000h   ; 8
        db 000h, 0E0h, 0A0h, 0E0h, 020h, 0C0h, 000h, 000h   ; 9
        db 000h, 000h, 080h, 000h, 080h, 000h, 000h, 000h   ; :
        db 000h, 000h, 040h, 000h, 040h, 080h, 000h, 000h   ; ;
        db 000h, 020h, 040h, 080h, 040h, 020h, 000h, 000h   ; <
        db 000h, 000h, 0E0h, 000h, 0E0h, 000h, 000h, 000h   ; =
        db 000h, 080h, 040h, 020h, 040h, 080h, 000h, 000h   ; >
        db 000h, 0E0h, 020h, 040h, 000h, 040h, 000h, 000h   ; ?
        db 000h, 040h, 0A0h, 0E0h, 080h, 060h, 000h, 000h   ; @
        db 000h, 040h, 0A0h, 0E0h, 0A0h, 0A0h, 000h, 000h   ; A
        db 000h, 0C0h, 0A0h, 0C0h, 0A0h, 0C0h, 000h, 000h   ; B
        db 000h, 060h, 080h, 080h, 080h, 060h, 000h, 000h   ; C
        db 000h, 0C0h, 0A0h, 0A0h, 0A0h, 0C0h, 000h, 000h   ; D
        db 000h, 0E0h, 080h, 0E0h, 080h, 0E0h, 000h, 000h   ; E
        db 000h, 0E0h, 080h, 0E0h, 080h, 080h, 000h, 000h   ; F
        db 000h, 060h, 080h, 0E0h, 0A0h, 060h, 000h, 000h   ; G
        db 000h, 0A0h, 0A0h, 0E0h, 0A0h, 0A0h, 000h, 000h   ; H
        db 000h, 0E0h, 040h, 040h, 040h, 0E0h, 000h, 000h   ; I
        db 000h, 020h, 020h, 020h, 0A0h, 040h, 000h, 000h   ; J
        db 000h, 0A0h, 0A0h, 0C0h, 0A0h, 0A0h, 000h, 000h   ; K
        db 000h, 080h, 080h, 080h, 080h, 0E0h, 000h, 000h   ; L
        db 000h, 0A0h, 0E0h, 0E0h, 0A0h, 0A0h, 000h, 000h   ; M
        db 000h, 0A0h, 0E0h, 0E0h, 0E0h, 0A0h, 000h, 000h   ; N
        db 000h, 040h, 0A0h, 0A0h, 0A0h, 040h, 000h, 000h   ; O
        db 000h, 0C0h, 0A0h, 0C0h, 080h, 080h, 000h, 000h   ; P
        db 000h, 040h, 0A0h, 0A0h, 0E0h, 060h, 000h, 000h   ; Q
        db 000h, 0C0h, 0A0h, 0E0h, 0C0h, 0A0h, 000h, 000h   ; R
        db 000h, 060h, 080h, 040h, 020h, 0C0h, 000h, 000h   ; S
        db 000h, 0E0h, 040h, 040h, 040h, 040h, 000h, 000h   ; T
        db 000h, 0A0h, 0A0h, 0A0h, 0A0h, 060h, 000h, 000h   ; U
        db 000h, 0A0h, 0A0h, 0A0h, 040h, 040h, 000h, 000h   ; V
        db 000h, 0A0h, 0A0h, 0E0h, 0E0h, 0A0h, 000h, 000h   ; W
        db 000h, 0A0h, 0A0h, 040h, 0A0h, 0A0h, 000h, 000h   ; X
        db 000h, 0A0h, 0A0h, 040h, 040h, 040h, 000h, 000h   ; Y
        db 000h, 0E0h, 020h, 040h, 080h, 0E0h, 000h, 000h   ; Z
        db 000h, 0E0h, 080h, 080h, 080h, 0E0h, 000h, 000h   ; [
        db 000h, 000h, 080h, 040h, 020h, 000h, 000h, 000h   ; \
        db 000h, 0E0h, 020h, 020h, 020h, 0E0h, 000h, 000h   ; ]
        db 000h, 040h, 0A0h, 000h, 000h, 000h, 000h, 000h   ; ^
        db 000h, 000h, 000h, 000h, 000h, 0E0h, 000h, 000h   ; _
        db 000h, 080h, 040h, 000h, 000h, 000h, 000h, 000h   ; `
        db 000h, 000h, 0C0h, 060h, 0A0h, 0E0h, 000h, 000h   ; a
        db 000h, 080h, 0C0h, 0A0h, 0A0h, 0C0h, 000h, 000h   ; b
        db 000h, 000h, 060h, 080h, 080h, 060h, 000h, 000h   ; c
        db 000h, 020h, 060h, 0A0h, 0A0h, 060h, 000h, 000h   ; d
        db 000h, 000h, 060h, 0A0h, 0C0h, 060h, 000h, 000h   ; e
        db 000h, 020h, 040h, 0E0h, 040h, 040h, 000h, 000h   ; f
        db 000h, 000h, 060h, 0A0h, 0E0h, 020h, 040h, 000h   ; g
        db 000h, 080h, 0C0h, 0A0h, 0A0h, 0A0h, 000h, 000h   ; h
        db 000h, 080h, 000h, 080h, 080h, 080h, 000h, 000h   ; i
        db 000h, 020h, 000h, 020h, 020h, 0A0h, 040h, 000h   ; j
        db 000h, 080h, 0A0h, 0C0h, 0C0h, 0A0h, 000h, 000h   ; k
        db 000h, 0C0h, 040h, 040h, 040h, 0E0h, 000h, 000h   ; l
        db 000h, 000h, 0E0h, 0E0h, 0E0h, 0A0h, 000h, 000h   ; m
        db 000h, 000h, 0C0h, 0A0h, 0A0h, 0A0h, 000h, 000h   ; n
        db 000h, 000h, 040h, 0A0h, 0A0h, 040h, 000h, 000h   ; o
        db 000h, 000h, 0C0h, 0A0h, 0A0h, 0C0h, 080h, 000h   ; p
        db 000h, 000h, 060h, 0A0h, 0A0h, 060h, 020h, 000h   ; q
        db 000h, 000h, 060h, 080h, 080h, 080h, 000h, 000h   ; r
        db 000h, 000h, 060h, 0C0h, 060h, 0C0h, 000h, 000h   ; s
        db 000h, 040h, 0E0h, 040h, 040h, 060h, 000h, 000h   ; t
        db 000h, 000h, 0A0h, 0A0h, 0A0h, 060h, 000h, 000h   ; u
        db 000h, 000h, 0A0h, 0A0h, 0E0h, 040h, 000h, 000h   ; v
        db 000h, 000h, 0A0h, 0E0h, 0E0h, 0E0h, 000h, 000h   ; w
        db 000h, 000h, 0A0h, 040h, 040h, 0A0h, 000h, 000h   ; x
        db 000h, 000h, 0A0h, 0A0h, 060h, 020h, 040h, 000h   ; y
        db 000h, 000h, 0E0h, 060h, 0C0h, 0E0h, 000h, 000h   ; z
        db 000h, 060h, 040h, 080h, 040h, 060h, 000h, 000h   ; {
        db 000h, 080h, 080h, 000h, 080h, 080h, 000h, 000h   ; |
        db 000h, 0C0h, 040h, 020h, 040h, 0C0h, 000h, 000h   ; }
        db 000h, 060h, 0C0h, 000h, 000h, 000h, 000h, 000h   ; ~
        db 0F0h, 0F0h, 0F0h, 0F0h, 0F0h, 0F0h, 0F0h, 0F0h   ; block
