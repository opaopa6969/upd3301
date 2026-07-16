**English** · [日本語](./io-ports.ja.md)

# upd3301 — PC-8801 I/O port map & implementation status

This is the working reference for the PC-8801 I/O ports as implemented in
`machine88.js` (`in()` / `out()`), written *from the implementation outward*: it
records what each port does, whether we model it, and — where we don't — why
that's safe. The port set and semantics were cross-checked against **M88** (the
`bubio/M88M` port), using the headless reference in [`../m88ref/`](../m88ref/):
we diff our behaviour against M88 title-by-title, so "unimplemented" here means
"audited and deliberately left out", not "unknown".

Status legend: **✔ implemented** · **≈ latched** (value stored, no side effect on
the hardware we model) · **○ visual/opt-in** (core captured, rendering is
browser-side and unverified) · **✗ not modelled** (with reason).

## Port table

| Port | Dir | Function | Status |
|------|-----|----------|--------|
| 00–0F | IN | Keyboard matrix rows | ✔ |
| 00–02 | OUT | **PCG** data / addr-lo / addr-hi (redefine 0x80–0xFF glyphs) | ○ capture ✔ / render ○ |
| 10 | OUT | μPD1990AC **calendar/clock** — command + serial-in | ✔ |
| 30 | IN/OUT | System control: 40/80 col, 20/25 line, mono (OUT); DIP low (IN) | ✔ |
| 31 | IN/OUT | Graphics control: 200/400-line, 64K-RAM, N-BASIC, VRAM disp, colour (OUT b0-4); DIP high (IN) | ✔ |
| 32 | IN/OUT | mkII SR+: EROMSL, ALU/ext-VRAM window, sound-IRQ mask | ✔ |
| 33 | OUT | N-BASIC bank select | ≈ (n80-mode only; N88 no-op) |
| 34 | OUT | ALU operation mode | ✔ |
| 35 | OUT | ALU control (mode, compare colour) | ✔ |
| 40 | IN | b5 = VRTC, b4 = RTC serial-out, b1 = misc | ✔ |
| 40 | OUT | RTC strobe/clock (b1 CSTB, b2 CCLK); b4 GVRAM wait-state | ✔ RTC / ✗ wait-state (timing-only) |
| 44/45 | IN/OUT | OPN (YM2203) register select / data; 45h IN also joypad | ✔ |
| 46/47 | IN/OUT | OPNA extended-register index / data (mirror of AA/AB) | ✔ |
| 50/51 | IN/OUT | μPD3301 CRTC parameter / command·status | ✔ |
| 53 | OUT | Display mask (b0 text-off, b1 graph-off) | ✔ |
| 54–5B | OUT | Analog palette (8 entries, 3 bits/gun) | ✔ |
| 5C–5F | OUT | GVRAM plane window select (B/R/G / main RAM) | ✔ |
| 60–68 | IN/OUT | μPD8257 DMAC | ✔ |
| 70 | IN/OUT | **Text window** base (see below) | ✔ |
| 71 | IN/OUT | Extension-ROM select (b0), EROMSL split with 32h | ✔ |
| 78 | OUT | **Text window** += one 256-byte page | ✔ |
| 99 | OUT | CD-BIOS / CD-EROM bank | ≈ (no CD-ROM fitted) |
| A8–AB | IN/OUT | Sound Board II (OPNA) bank0/1 index·data | ✔ |
| AC/AD | IN/OUT | OPNA extended-register index / data (mirror of AA/AB) | ✔ |
| E2/E3 | IN/OUT | EMM (extended RAM) window — returns 0xFF | ≈ |
| E4 | OUT | 8214 interrupt priority / mask | ✔ |
| E6 | OUT | Interrupt mask (VSYNC/RTC/SOUND enable) | ✔ |
| E8/E9 | IN/OUT | Kanji ROM level-1 address / glyph read | ✔ |
| EC/ED | IN/OUT | Kanji ROM level-2 address / glyph read | ✔ |
| F0/F1 | OUT | Dictionary ROM bank | ≈ (no dictionary ROM) |
| FC–FF | IN/OUT | Twin 8255 PIO ↔ disk sub-CPU (cross-wired) | ✔ |

## Notable features

### Text window (port 70h / 78h) — the one that mattered
A 1 KB region at `0x8000–0x83FF` that, when `(port31 & 6) == 0` and not in N80
mode, maps to `ram[txtwnd + (addr & 0x3FF)]`, where `txtwnd = port70h << 8`
(`OUT 78h` advances it by one page). `IN 70h` reads `txtwnd >> 8`.

N88-DISK-BASIC's program loader stores the loaded program at `0x0001+` and reads
it back **through this window** (`OUT 70h,00` makes `0x8001` alias `0x0001`) to
decide whether more remains to load. Without the window that read-back is 0, so
the loader stops early. This is the single missing feature that kept **軽井沢
誘拐案内** (and several other titles) from booting; see the case write-up. Matches
M88 `Memory::Out70` / `Update80`.

### PCG — Programmable Character Generator (ports 00h–02h)
`02h/01h` form a 14-bit address, `00h` the data byte; a write with address bit 12
set stores one glyph scanline into `pcgRam[addr & 0x3FF]` (glyphs `0x80–0xFF`, 8
rows each). The capture is in the core and testable. The visual overlay is opt-in
in `renderScreen({ pcg })` and, being browser-side, is currently **unverified**.
The PC-8001 PCG add-on (PCG8100) uses the same ports.

### μPD1990AC calendar/clock (ports 10h + 40h)
A serial RTC. `OUT 10h` loads the 3-bit command and the serial-in bit; `OUT 40h`
edge-clocks it (`b1` CSTB latches the command, `b2` CCLK shifts); `IN 40h b4` is
the serial-out. Command 3 loads the date into the shift registers, command 1
shifts it out LSB-first. The reported date is a fixed, deterministic default so
snapshots/replays stay reproducible; a live clock can be injected via the
`rtcDate` constructor option. Faithful to M88 `Calender`.

## Deliberately not implemented

- **40h GVRAM wait-state (b4)** — M88 uses it to pick a memory wait profile; our
  timing is an approximation that doesn't model per-page waits, so this bit is a
  no-op. All titles boot without it.
- **99h CD-BIOS, F0h/F1h dictionary ROM, E2h/E3h EMM** — bank/window selects for
  ROMs/RAM we don't fit; latched for read-back, no effect (matches M88 when those
  options are absent).
- **FGU (Functional Graphics Unit)** — a PC-8001 external 640×200 graphics board
  (FGU-8000/8200). The PC-8801 provides 640×200 GVRAM natively (which we do
  implement), so FGU only matters for PC-8001-mode software that targets it
  specifically; not modelled.

## How this was audited

The port list came from diffing our `in()`/`out()` against M88's IOBus connector
table (`src/pc88/pc88.cpp`), then running both emulators headless on the same
disks (`m88ref/`) and confirming that every port a title actually touches is
either implemented or provably inert. See [`../m88ref/README.md`](../m88ref/README.md)
for the reference-oracle method and the agent prompt that reproduces it.
