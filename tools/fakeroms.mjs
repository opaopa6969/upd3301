// tools/fakeroms — synthetic ROM images, one per machine.
//
// WHY THIS EXISTS
// No ROM ships with this repository (they are all somebody's copyright), so a
// headless smoke test of demo/machine.html cannot get as far as constructing a
// machine: every boot path in the demo bails out with "choose a ROM" before a
// machine object exists, and the input/render/snapshot paths never run. These
// generators produce the smallest image each loader will *accept*, so a test
// can build a machine, step it and render it.
//
// WHAT THESE ARE NOT
// They are not dumps and they are not reconstructions. Every one of them is
// zeros plus (a) whatever header/vector bytes the loader validates and (b) a
// handful of hand-encoded instructions that park the CPU in a tight loop so it
// does not run off into unmapped memory and turn a smoke test into a crash
// report about the wrong thing. Nothing here boots BASIC, draws a title screen
// or plays a note. If a test needs a machine that *does* something, the test
// files (test-nes.mjs, test-md.mjs, mdtools/mkrom.mjs, ...) already build
// purpose-shaped images and are the better model to copy.
//
// The repo already owns two of these builders — buildINes() in ines.js and
// buildPce() in pcerom.js exist for exactly this reason — so they are reused
// rather than reimplemented. The rest are laid out here byte by byte because
// there is no builder for them.
//
// Everything is deterministic: same call, same bytes, no Math.random, no I/O.

import { buildINes, MIRRORING } from '../ines.js';
import { buildPce } from '../pcerom.js';

// ---------------------------------------------------------------------------
// little helpers. Endianness is per-machine, so it is spelled out every time
// rather than hidden behind one "put32" that would be wrong half the time.

const be16 = (b, o, v) => { b[o] = (v >>> 8) & 0xff; b[o + 1] = v & 0xff; };
const be32 = (b, o, v) => { be16(b, o, (v >>> 16) & 0xffff); be16(b, o + 2, v & 0xffff); };
const ascii = (b, o, s, len, pad = 0x20) => {
  for (let i = 0; i < len; i++) b[o + i] = i < s.length ? s.charCodeAt(i) & 0xff : pad;
};

// ---------------------------------------------------------------------------
// PC-8001 (machine.js / Pc8001Machine)
//
// The class only asks for "an N-BASIC ROM image" of at least 4 KB and copies
// the first 32 KB over the bottom of the map; there is no header and no
// checksum, so the whole contract is "the Z80 starts at 0000 and must not
// wander".
//
// A bare self-loop would satisfy that, but it renders a 0x0 frame: on this
// machine the screen geometry comes out of the CRTC, and an unprogrammed
// uPD3301 emits no rows at all. So the ROM does what N-BASIC does at boot —
// 80x25 colour, DMA channel 2 pointed at the text VRAM, display on — which is
// the same sequence Pc8001TextSystem.initTextMode() writes, only from the Z80
// side so it goes through the real port map. One character and its attribute
// pair are poked into VRAM so "the renderer produced pixels" is a real signal.
export function fakePc8001Rom() {
  const rom = new Uint8Array(0x8000);
  const code = [];
  const ldOut = (port, v) => code.push(0x3e, v & 0xff, 0xd3, port & 0xff); // LD A,n ; OUT (p),A
  const ldStore = (addr, v) => code.push(0x3e, v & 0xff, 0x32, addr & 0xff, (addr >> 8) & 0xff); // LD A,n ; LD (nn),A

  const COLS = 80, ROWS = 25, VRAM = 0xf3c8; // N-BASIC's default text VRAM base
  const bytesPerFrame = ROWS * (COLS + 40);  // 80 codes + 20 attribute pairs per row

  code.push(0xf3);                     // DI
  ldOut(0x30, 0x01);                   // system port: 80 columns, colour

  ldOut(0x51, 0x00);                   // CRTC RESET, then five parameters
  ldOut(0x50, 0x80 | (COLS - 2));      // burst mode, characters per row
  ldOut(0x50, 0x40 | (ROWS - 1));      // blink rate, rows per screen
  ldOut(0x50, 0x07);                   // blinking underline cursor, 8 lines/char
  ldOut(0x50, ((7 - 1) << 5) | (14 - 2)); // vblank rows, hblank
  ldOut(0x50, 20 - 1);                 // attribute mode 0, 20 pairs per row

  ldOut(0x68, 0x80 | 0x04);            // DMAC: autoload, channel 2 enabled
  ldOut(0x64, VRAM & 0xff);            // channel 2 address, low then high
  ldOut(0x64, VRAM >> 8);
  const tc = 0x8000 | (bytesPerFrame - 1); // read mode + terminal count
  ldOut(0x65, tc & 0xff);
  ldOut(0x65, tc >> 8);

  ldOut(0x51, 0x40);                   // unmask the VRTC interrupt
  ldOut(0x51, 0x20);                   // start the display
  ldOut(0x51, 0x81);                   // cursor on...
  ldOut(0x50, 0x00);                   // ...at column 0
  ldOut(0x50, 0x00);                   // ...row 0

  // A semigraphic cell rather than a character: semigraphics are drawn from the
  // code byte itself (2x4 block bitmap), so this lights real pixels without a
  // CGROM. renderScreen() takes the font from its CALLER, and there is no font
  // in this repository either — a plain 'A' here would render blank and a smoke
  // test could not tell that apart from a broken raster.
  ldStore(VRAM, 0xff);                 // all eight blocks on, top-left cell
  ldStore(VRAM + COLS + 0, 0x00);      // attribute pair 0: position = column 0
  ldStore(VRAM + COLS + 1, 0xf8);      // ...value = white + semigraphic

  code.push(0x18, 0xfe);               // JR $-2
  rom.set(code, 0);
  return rom;
}

// ---------------------------------------------------------------------------
// PC-8801 (machine88.js / Pc8801Machine)
//
// Five images, because the 88 is five ROMs on a board:
//   main  32 KB N88 (the constructor rejects anything shorter)
//   ext   the four 8 KB banks at 6000-7FFF as ONE flat 32 KB array — the class
//         indexes it as romExt[bank * 0x2000 + offset], so an array of four
//         Uint8Arrays would silently read undefined and land on the ?? 0xff
//         fallback for every byte
//   sub   the PC-80S31's own ROM (Pc80s31 wants >= 2 KB); its Z80 runs this
//         image too, so it gets the same self-loop
//   n80   the N-BASIC mode ROM, same shape as main
//   kanji 128 KB. It MUST be a power of two: the read port does
//         kanjiRom[addr & (kanjiRom.length - 1)]
export function fakePc8801Set() {
  const idle = (len) => {
    const b = new Uint8Array(len);
    b.set([0xf3, 0x18, 0xfe], 0); // DI ; JR $-2
    return b;
  };
  return {
    main: idle(0x8000),
    ext: new Uint8Array(4 * 0x2000), // four banks, flat — see the note above
    sub: idle(0x0800),
    n80: idle(0x8000),
    kanji: new Uint8Array(0x20000), // blank glyphs, but the port stops floating
  };
}

// ---------------------------------------------------------------------------
// Famicom / NES (ines.js + machinenes.js)
//
// A plain NROM-256 card: 32 KB PRG at $8000-$FFFF, 8 KB CHR, horizontal
// mirroring. buildINes() writes the iNES header, so all that is left is the
// 6502 program and the vectors — and the vectors are the point. An unset reset
// vector on a zero-filled PRG sends the CPU to $0000, which is work RAM, which
// is BRK ($00) — the smoke test would then be measuring an interrupt storm.
export function fakeNesCart() {
  const prg = new Uint8Array(0x8000);
  const CODE = 0x4000; // $C000

  // $C000: SEI / CLD / LDX #$FF / TXS / JMP $C005 (the JMP branches to itself)
  prg.set([0x78, 0xd8, 0xa2, 0xff, 0x9a, 0x4c, 0x05, 0xc0], CODE);
  prg[CODE + 0x10] = 0x40; // $C010: RTI, for anything that fires anyway

  const vec = (off, addr) => { prg[off] = addr & 0xff; prg[off + 1] = (addr >> 8) & 0xff; };
  vec(0x7ffa, 0xc010); // NMI
  vec(0x7ffc, 0xc000); // RESET
  vec(0x7ffe, 0xc010); // IRQ/BRK

  return buildINes({
    prg,
    chr: new Uint8Array(0x2000),
    mapper: 0,
    mirroring: MIRRORING.HORIZONTAL,
  });
}

// ---------------------------------------------------------------------------
// PC Engine (pcerom.js + machinepce.js)
//
// A 32 KB HuCard with no 512-byte header. buildPce() places the code at the
// start of bank 0 and fills $1FF6-$1FFF with the vector table; bank 0 is what
// MPR7 sees at reset, so the code lives at $E000.
//
// Two things are worth doing beyond "spin".
//
// Mapping work RAM: the HuC6280 comes up with nothing but the hardware page
// banked in, so page zero and the stack do not exist until MPR1 is set. A
// machine that takes any interrupt before that pushes into the void.
//
// Programming the VDC's geometry: frameWidth/frameHeight come out of the chip's
// timing registers, and an unprogrammed VDC leaves render() returning an 8x1
// frame. That is not a crash, but it makes any render-path smoke test
// meaningless, so the standard 256x224 timings go in. The display is left with
// nothing to draw (no tiles, no palette), which is the honest result: a black
// screen of the right size.
export function fakePceCart() {
  // ST0/ST1/ST2 reach the VDC directly, whatever the MPRs say.
  const vdc = (reg, val) => [0x03, reg, 0x13, val & 0xff, 0x23, (val >> 8) & 0xff];
  const code = [
    0x78,             // SEI
    0xd8,             // CLD
    0xa9, 0xf8,       // LDA #$F8   (bank $F8 = the 8 KB work RAM)
    0x53, 0x02,       // TAM #$02   (-> MPR1, so $2000 is RAM: zero page + stack)
    0xa2, 0xff,       // LDX #$FF
    0x9a,             // TXS
    ...vdc(0x0b, 0x041f), // HDR: 256 pixels wide
    ...vdc(0x0c, 0x0f02), // VPR
    ...vdc(0x0d, 0x00df), // VDW: 224 lines
    ...vdc(0x0e, 0x0004), // VCR
    ...vdc(0x09, 0x0000), // MWR: 32x32 background map
    ...vdc(0x05, 0x0080), // CR: background on, interrupts off
    0x80, 0xfe,       // BRA $-2
  ];
  const rom = buildPce({
    size: 0x8000,
    code,
    entry: 0x0000,
    // Every non-reset vector goes to a lone RTI at $E100 rather than back
    // through the init code.
    vectors: { irq2: 0xe100, irq1: 0xe100, timer: 0xe100, nmi: 0xe100 },
  });
  rom[0x0100] = 0x40; // RTI
  return rom;
}

// ---------------------------------------------------------------------------
// Mega Drive (mdrom.js + machinemd.js)
//
// mdrom.js accepts a file either because "SEGA" is at $100 or because the
// reset vectors look bootable. Both are cheap, so this image does both, and
// fills in the rest of the header (region at $1F0, ROM/RAM extents, and a
// correct checksum at $18E) so summarizeMdRom() has something to print and the
// loader raises no warnings.
//
// Layout is the console's: $000-$0FF exception vectors, $100-$1FF header,
// $200 code.
export function fakeMdCart() {
  const rom = new Uint8Array(0x8000);
  const CODE = 0x200, STUB = 0x210;

  be16(rom, CODE, 0x60fe);  // BRA.S $-2  (branches to itself)
  be16(rom, STUB, 0x4e73);  // RTE

  be32(rom, 0x00, 0x00fffe00); // vector 0: initial SSP, top of work RAM
  be32(rom, 0x04, CODE);       // vector 1: initial PC
  for (let v = 2; v < 64; v++) be32(rom, v * 4, STUB);

  ascii(rom, 0x100, 'SEGA MEGA DRIVE ', 16);
  ascii(rom, 0x110, '(C)FAKE 2026    ', 16);
  ascii(rom, 0x120, 'FAKEROM', 48);   // domestic name
  ascii(rom, 0x150, 'FAKEROM', 48);   // overseas name
  ascii(rom, 0x180, 'GM 00000000-00', 14);
  ascii(rom, 0x190, 'J', 16);         // I/O support
  be32(rom, 0x1a0, 0);                // ROM start
  be32(rom, 0x1a4, rom.length - 1);   // ROM end (last valid address)
  be32(rom, 0x1a8, 0x00ff0000);       // RAM start
  be32(rom, 0x1ac, 0x00ffffff);       // RAM end
  ascii(rom, 0x1b0, '  ', 2);         // no "RA" -> no backup RAM
  ascii(rom, 0x1f0, 'JUE', 3);        // region: runs anywhere

  // The header checksum is a 16-bit sum of big-endian words from $200 up.
  let sum = 0;
  for (let i = 0x200; i + 1 < rom.length; i += 2) sum = (sum + ((rom[i] << 8) | rom[i + 1])) & 0xffff;
  be16(rom, 0x18e, sum);

  return rom;
}

// ---------------------------------------------------------------------------
// X68000 (machinex68.js)
//
// The IPL is 128 KB and the machine maps its last 64 KB at $FF0000, which is
// where the 68000 fetches its reset vectors from while the boot overlay is up.
// So the vectors go at IPL offset $10000 and the code at $10010 ($FF0010),
// which is where the real ROM puts its first instruction.
//
// The prologue is the real ROM's: mask interrupts, give the supervisor a
// stack, then RESET — which is what drops the boot overlay so $000000 becomes
// RAM. Skipping the RESET leaves the machine in a state no software expects.
export function fakeX68Set() {
  const ipl = new Uint8Array(0x20000);
  const BASE = 0x10000; // $FF0000

  be32(ipl, BASE + 0, 0x00002000);  // initial SSP
  be32(ipl, BASE + 4, 0x00ff0010);  // initial PC

  const code = [
    0x46fc, 0x2700,               // MOVE #$2700,SR   (supervisor, all IRQs masked)
    0x4ff9, 0x0000, 0x2000,       // LEA $00002000,A7
    0x4e70,                       // RESET            (drops the boot overlay)
    0x60fe,                       // BRA.S $-2
  ];
  code.forEach((w, i) => be16(ipl, BASE + 0x10 + i * 2, w));

  // 768 KB of blank glyphs. The machine allocates the full CGROM either way;
  // handing it a real-sized array keeps the snapshot/render paths on the same
  // shape they take with a dump.
  return { ipl, cgrom: new Uint8Array(0xc0000) };
}

// ---------------------------------------------------------------------------
// PC-9801 (machinepc98.js)
//
// Four images. The BIOS is the 96 KB window at $E8000-$FFFFF, so its reset
// vector sits at offset $17FF0 (= $FFFF0) and its entry point at offset 0
// (= E800:0000).
//
// The ITF is the wrinkle. When one is supplied it is mapped OVER the top 32 KB
// at power-on, which means the reset vector the CPU reads is the ITF's, not
// the BIOS's. The real ITF hands over by writing $12 to port $43D and jumping
// into the BIOS — but the instant that OUT retires, the very next opcode fetch
// comes from the BIOS instead of the ITF. So the handover stub is written to
// BOTH images at the same linear address ($FFF00): identical bytes on both
// sides of the switch means the fetch that straddles it cannot land on garbage.
//
// The BIOS itself pokes one character into text VRAM and starts the GDC before
// halting, so render() has something to produce and a smoke test can tell
// "drew nothing" apart from "drew a blank screen".
export function fakePc98Set() {
  const bios = new Uint8Array(0x18000).fill(0xff);
  const itf = new Uint8Array(0x8000).fill(0xff);

  // E800:0000 — the BIOS entry.
  bios.set([
    0xfa,                                     // CLI
    0xb8, 0x00, 0xa0,                         // MOV AX,A000h
    0x8e, 0xc0,                               // MOV ES,AX
    0x26, 0xc7, 0x06, 0x00, 0x00, 0x41, 0x00, // MOV word ES:[0000],'A'
    0x26, 0xc6, 0x06, 0x00, 0x20, 0xe1,       // MOV byte ES:[2000],E1h (visible, white)
    0xb0, 0x6b, 0xe6, 0x62,                   // MOV AL,6Bh / OUT 62h,AL  (GDC1 START)
    0xf4,                                     // HLT
  ], 0);

  // F000:FF00 — the ITF exit stub, duplicated into both images.
  const stub = [
    0xba, 0x3d, 0x04,             // MOV DX,043Dh
    0xb0, 0x12,                   // MOV AL,12h
    0xee,                         // OUT DX,AL        (ITF off; BIOS takes over here)
    0xea, 0x00, 0x00, 0x00, 0xe8, // JMP FAR E800:0000
  ];
  bios.set(stub, 0x17f00);
  itf.set(stub, 0x7f00);

  // FFFF:0000 — the reset vector, in both images for the same reason.
  const reset = [0xea, 0x00, 0xff, 0x00, 0xf0]; // JMP FAR F000:FF00
  bios.set(reset, 0x17ff0);
  itf.set(reset, 0x7ff0);

  // The font ROM's fixed 288,768-byte layout. Only the glyph the BIOS prints
  // is filled in, so "some pixels are lit" is a real signal and not an artifact
  // of a ROM full of 0xFF.
  const font = new Uint8Array(288768);
  font.fill(0xff, 0x800 + 0x41 * 16, 0x800 + 0x42 * 16); // single-byte 'A'

  // A PC-9801-26K sound BIOS is 16 KB of option ROM. Blank is fine: nothing
  // calls into it unless software goes looking, and its presence is what flips
  // hasSoundBios.
  return { bios, itf, font, sound: new Uint8Array(0x4000) };
}

// ---------------------------------------------------------------------------
// Seta arcade (setarom.js + machineseta.js)
//
// This one needs a real .zip, because that is what the host hands to
// loadSetaRomSet(). zip.js only reads, so a ~40-line STORED-method writer lives
// below.
//
// The set is thunderl (Thunder & Lightning): a 64 KB 68000 program built from
// two interleaved 32 KB chips, plus four 128 KB sprite chips. The sample ROMs
// are marked optional in SETA_SETS and are left out — 1 MB of zeros to prove
// nothing.
//
// THE CRC PROBLEM, AND WHY ONE CRC IS FORGED
// loadSetaRomSet() called without an explicit `set` (which is how the demo
// calls it) identifies the board by CRC32 alone, and throws "not a known Seta
// ROM set" if not one chip matches. Names are only consulted afterwards, when
// filling in the regions. So a set that matches zero CRCs cannot be loaded the
// way the host loads one, no matter what its members are called.
//
// CRC32 is affine, so four bytes anywhere in a file can be solved for to give
// the file any CRC you like. Exactly ONE chip gets that treatment — m4, whose
// CRC belongs to no other set — and the four bytes are patched into dead space
// far past the code. Every other member matches by NAME only, which is
// deliberate: setarom.js then reports `matched by name, not CRC - content may
// differ`, and the caller is told in its own words that this is not a dump.
export function fakeSetaZip() {
  // --- the 68000 program, as the assembled 64 KB region ---------------------
  const region = new Uint8Array(0x10000);
  const CODE = 0x400, STUB = 0x500;

  be32(region, 0, 0x00fffff0);  // initial SSP, top of the board's RAM at $FFC000
  be32(region, 4, CODE);        // initial PC
  be16(region, CODE, 0x60fe);   // BRA.S $-2
  be16(region, STUB, 0x4e73);   // RTE
  // The board's vblank interrupt is autovectored at level 2; sending every
  // vector to an RTE means a frame's worth of interrupts costs nothing.
  for (let v = 2; v < 256; v++) be32(region, v * 4, STUB);

  // --- split it back into the two chips the PCB actually has ---------------
  // SETA_SETS.thunderl: m4 is at:0 step:2 (even bytes), m5 is at:1 step:2.
  const m4 = new Uint8Array(0x8000);
  const m5 = new Uint8Array(0x8000);
  for (let i = 0; i < 0x8000; i++) { m4[i] = region[i * 2]; m5[i] = region[i * 2 + 1]; }

  // Forge m4's CRC. Offset $7FFC-$7FFF maps to region $FFF8-$FFFE: past the
  // vectors, past the code, read by nothing.
  forgeCrc32(m4, 0x7ffc, 0x1e6b9462);

  const gfx = () => new Uint8Array(0x20000); // blank sprite tiles

  return writeStoredZip([
    // maincpu
    { name: 'm4', bytes: m4 },
    { name: 'm5', bytes: m5 },
    // gfx1 — not optional, so all four sockets are populated
    { name: 't17', bytes: gfx() },
    { name: 't16', bytes: gfx() },
    { name: 't15', bytes: gfx() },
    { name: 't14', bytes: gfx() },
  ]);
}

// ---------------------------------------------------------------------------
// CRC32 (the reflected IEEE polynomial — zip's and MAME's) and the forgery.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

// The table's high bytes are a permutation of 0..255, which is what makes a
// CRC step invertible: the top byte of the result names the table entry that
// produced it.
const CRC_REV = (() => {
  const r = new Uint8Array(256);
  for (let k = 0; k < 256; k++) r[CRC_TABLE[k] >>> 24] = k;
  return r;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Rewrite bytes[at..at+3] in place so that crc32(bytes) === target.
//
// How: run the register forward to `at`, then walk it backwards from the
// desired end state. A backward step needs only the top byte of the register it
// is undoing, and the top byte survives every step whose unknown low bits have
// not reached it yet — so four backward steps recover the four table indices
// even though the four bytes are still unknown. With the indices in hand the
// forward pass names the bytes.
export function forgeCrc32(bytes, at, target) {
  let reg = 0xffffffff;
  for (let i = 0; i < at; i++) reg = (CRC_TABLE[(reg ^ bytes[i]) & 0xff] ^ (reg >>> 8)) >>> 0;

  // Unwind the bytes after the patch, from the final register backwards, to
  // learn the state the four patched bytes have to leave behind.
  let want = (target ^ 0xffffffff) >>> 0;
  for (let i = bytes.length - 1; i >= at + 4; i--) {
    const k = CRC_REV[want >>> 24];
    want = ((((want ^ CRC_TABLE[k]) << 8) >>> 0) | ((k ^ bytes[i]) & 0xff)) >>> 0;
  }

  // Four backward steps for the indices; only the high bits are needed and
  // they are still intact at each lookup.
  const k = new Uint8Array(4);
  let p = want;
  for (let i = 3; i >= 0; i--) {
    k[i] = CRC_REV[p >>> 24];
    p = ((p ^ CRC_TABLE[k[i]]) << 8) >>> 0;
  }

  // Forward again: each index and the register together name the byte.
  for (let i = 0; i < 4; i++) {
    bytes[at + i] = ((reg & 0xff) ^ k[i]) & 0xff;
    reg = (CRC_TABLE[k[i]] ^ (reg >>> 8)) >>> 0;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// A STORED-method ZIP writer. zip.js reads archives; nothing in the repo writes
// one, and a MAME set is the only way to hand a Seta board to the host. No
// compression, because DeflateStream would make this async for no benefit — a
// romset of zeros is thrown away the moment it is parsed.
//
// `files` is [{ name, bytes }]. Timestamps are fixed at 0 so the output is
// byte-for-byte reproducible.
export function writeStoredZip(files) {
  const enc = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.bytes);
    const n = f.bytes.length;

    const loc = new Uint8Array(30 + name.length);
    const lv = new DataView(loc.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header
    lv.setUint16(4, 20, true);         // version needed
    lv.setUint16(6, 0x0800, true);     // flags: bit 11 = the name is UTF-8
    lv.setUint16(8, 0, true);          // method 0 = stored
    lv.setUint16(10, 0, true);         // mod time
    lv.setUint16(12, 0, true);         // mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, n, true);         // compressed size
    lv.setUint32(22, n, true);         // uncompressed size
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);         // extra length
    loc.set(name, 30);

    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory header
    cv.setUint16(4, 20, true);         // version made by
    cv.setUint16(6, 20, true);         // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, n, true);
    cv.setUint32(24, n, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);         // extra
    cv.setUint16(32, 0, true);         // comment
    cv.setUint16(34, 0, true);         // disk number start
    cv.setUint16(36, 0, true);         // internal attributes
    cv.setUint32(38, 0, true);         // external attributes
    cv.setUint32(42, offset, true);    // offset of the local header
    cen.set(name, 46);

    locals.push(loc, f.bytes);
    central.push(cen);
    offset += loc.length + n;
  }

  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);   // end of central directory
  ev.setUint16(4, 0, true);            // this disk
  ev.setUint16(6, 0, true);            // disk with the central directory
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);      // central directory offset
  ev.setUint16(20, 0, true);           // comment length

  const parts = [...locals, ...central, eocd];
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const part of parts) { out.set(part, o); o += part.length; }
  return out;
}

export default {
  fakePc8001Rom, fakePc8801Set, fakeNesCart, fakePceCart, fakeMdCart,
  fakeX68Set, fakeSetaZip, fakePc98Set,
};
