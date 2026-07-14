**English** · [日本語](./z80asm.ja.md)

# z80asm — the macro assembler, full reference

A two-pass Z80 macro assembler in one dependency-free JS file (`z80asm.js`).
It grew up inside the ICE's assembler pane, then acquired MACRO-80
compatibility because the author asked for "enough expressiveness to build
USES in userland" — and got exactly that (see the [worked example](#userland-uses)).

```js
import { assemble } from './z80asm.js';
const r = assemble(source, { org: 0x9000 });
// r = { bytes, org, symbols, listing, errors, warnings, fixups }
```

Errors are collected (never thrown) as `{line, message}`, with
`(expanded from line N)` appended when the offending line came out of a
macro expansion.

## Source format

```asm
label:  LD A,10        ; colon labels
.loop:  DJNZ .loop     ; local label — scoped to the last global label
name    EQU 42         ; the EQU/MACRO/PROC/STRUC/ENDS/ENDP forms need no colon
        JR label       ; comments start with ;
```

Mnemonics, registers and symbols are case-insensitive. The full Z80
instruction set is supported, including the useful undocumented corners
(`SLL`, `IXH/IXL/IYH/IYL`, the DDCB/FDCB register-copy forms such as
`RR (IX+4),B`, `IN (C)`, `OUT (C),0`).

## Numbers and expressions

| form | example |
|---|---|
| decimal | `10`, `10d` |
| hex | `0x1F`, `1Fh`, `0FFh` (leading digit required for the `h` form) |
| binary | `1010b`, `0b1010` |
| character | `'A'`, `'\n'` |
| here | `$` = address of the current statement |

Operators, C-like precedence: `+ - * / % & | ^ << >> ~` and parentheses.
Forward references are fine everywhere an expression is used at assembly
time (the second pass resolves them) — **except** inside `IF`-family
conditions, which evaluate during expansion and honestly error on symbols
that don't exist yet.

## Pseudo-ops

| op | meaning |
|---|---|
| `ORG addr` | set the location counter (known on pass 1) |
| `name EQU expr` (or `=`) | define a constant |
| `DB / DEFB / DEFM` | bytes; strings allowed: `DB "HI",13,10,0` |
| `DW / DEFW` | little-endian words |
| `DS n [, fill]` | reserve n bytes (count must be known on pass 1) |
| `END` | stop assembling |
| `INCLUDE "path"` | textual include via the resolver callback (see the IDE) |

## Macros

```asm
out2    MACRO port, val     ; also: MACRO out2 port,val
        LD A,val
        OUT (port),A
        ENDM

        out2 51h, 0         ; expand
        out2 51h, <1, 2>    ; <…> travels as ONE argument (commas kept)
        out2 51h, %(N*2+1)  ; %expr passes the evaluated VALUE, not the text
```

- `REPT n … ENDM` repeats a block n times (n from EQUs known so far).
- `IRP r,<bc,de,hl> … ENDM` iterates a `<>`-guarded list, binding `r`.
- `IRPC c,ABC … ENDM` iterates characters. Inside string literals the
  binding is reached with `'&c'` (the M80 idiom).
- `LOCAL a,b` declares names minted fresh per expansion (M80 style).
  Our automatic `.label` scoping does the same with less typing — both work.
- `EXITM` bails out of the innermost macro / REPT / IRP expansion —
  classically used from inside an `IF`.
- `PURGE name` deletes a macro definition (see shadowing below).

### `&` pasting

`label&n:` glues a parameter to a token — with `n = 2` it becomes
`label2:`. The `&` is consumed **only when directly adjacent** to a
substituted parameter; `a & b` with spaces stays the bitwise AND. This is
deliberately stricter than M80, which had no `&` operator to protect.

### Conditional assembly

```asm
        IF expr          ; true = nonzero
          …
        ELSE
          …
        ENDIF
```

| form | true when |
|---|---|
| `IF expr` | expr ≠ 0 |
| `IFE expr` | expr = 0 |
| `IFDEF name` / `IFNDEF` | symbol or macro is defined (so far) / isn't |
| `IFB <arg>` / `IFNB` | the argument is blank / isn't — variadic-style macros |
| `IFIDN <a>,<b>` / `IFDIF` | argument texts match (case-insensitive) / differ |

Conditions evaluate **once, during expansion**, before the two assembly
passes — so they are pass-consistent by construction. A label address in an
`IF` is a forward reference the expander cannot know: honest error.

### Mnemonic shadowing and PURGE

A macro may share its name with a builtin mnemonic — **the macro wins**.
Inside that macro's own body, the name resolves back to the **builtin**
(the M80 rule; this is what keeps a `RET` shadow from recursing forever).
`PURGE name` removes the macro and restores the builtin.

<a id="userland-uses"></a>
### Worked example: USES in userland

The built-in `PROC USES` sugar, rebuilt from raw macro parts — shadowing
`RET` so every return grows the epilogue automatically:

```asm
PROLOG  MACRO
        PUSH BC
        PUSH DE
        ENDM
RET     MACRO               ; shadow the builtin
        POP DE
        POP BC
        RET                 ; ← inside the shadow this IS the builtin RET
        ENDM

f:      PROLOG
        LD BC,0
        RET                 ; expands to POP DE / POP BC / RET
        PURGE RET           ; builtin RET is back for the rest of the file
```

This assembles byte-for-byte identical to:

```asm
f PROC USES BC,DE
        LD BC,0
        RET
f ENDP
```

## MACRO-80 difference table

| feature | status | notes |
|---|---|---|
| `MACRO` / `ENDM` / `REPT` | compatible | both `name MACRO` and `MACRO name` forms |
| `IRP` / `IRPC` | compatible | `<>` lists; `'&c'` inside strings |
| `LOCAL` | compatible | plus our automatic `.label` scoping |
| `EXITM` | compatible | unwinds macro / REPT / IRP |
| `IF/IFE/ELSE/ENDIF`, `IFDEF/IFNDEF`, `IFB/IFNB`, `IFIDN/IFDIF` | compatible | expansion-time, pass-consistent |
| `&` pasting, `%expr` value args | compatible | `&` only when directly adjacent |
| mnemonic shadowing + `PURGE` | compatible | builtin resolution inside the shadow |
| `IF1` / `IF2` | **unsupported** | we expand once and assemble twice; pass-specific source cannot exist — clear error |
| macro definitions inside `IF` | **unsupported** | definitions are collected before expansion; an `IFNDEF`-guarded redefinition won't guard |
| `.PHASE/.DEPHASE`, `PUBLIC/EXTRN`, `.REQUEST` | unsupported | single-image assembler, no linker |
| local labels `.name` | **extension** | auto-scoped to the last global label and per expansion |
| forward references in operands | **extension** | M80 needed them declared; our pass 2 just resolves them |
| `PROC USES` / `STRUC` / `RELOC` / `FIXUPTABLE` | **extension** | stone-tool sugar, see [ICE design](./ice-design.md) |
| error provenance | **extension** | `(expanded from line N)` on macro-born errors |

## Extensions in detail

### PROC USES

```asm
f PROC USES BC,DE      ; prologue: PUSH BC / PUSH DE
        RET            ; every plain RET becomes POP DE / POP BC / RET
f ENDP
```

A conditional `RET NZ` inside is an **error** — rewriting it would change
the meaning, so that epilogue is yours to write.

### STRUC

```asm
player STRUC
x       DB 0
hp      DW 0
player ENDS            ; player.x=0, player.hp=1, player=3 (total size)
        LD A,(IX+player.x)
```

### RELOC / FIXUPTABLE

```asm
RELOC
start:  LD HL,msg      ; absolute refs to region-born labels are recorded
        JP start       ; ← warning: fits a JR (JR relocates for free)
msg:    DB "HI",0
ENDRELOC
table:  FIXUPTABLE     ; emits DW count, then DW offsets (region-relative)
```

`result.fixups` returns the same offsets programmatically — feed either to
a self-relocating loader.
