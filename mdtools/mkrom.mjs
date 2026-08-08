// mdtools/mkrom — hand-assembled Mega Drive ROMs for the tests.
//
// The tests need cartridges that do one thing each and do it in a known number
// of frames. There is no free redistributable ROM that fits that description,
// and pulling in a 68000 assembler for twenty instructions would be a strange
// dependency for a zero-dependency repo, so the handful of instruction words
// are emitted directly. Each one is spelled out next to its encoding — the
// encodings come from the M68000 User's Manual and are worth reading as
// documentation of what the test is actually asking the CPU to do.
//
// Nothing here ships in a build; it exists so `node --test` can prove the
// machine boots, draws, takes interrupts and runs a DMA without needing a
// commercial cartridge on disk.

const VECTORS = 0x100;   // 64 vectors * 4 bytes ends here
const CODE = 0x200;
const ROM_SIZE = 0x8000;

// ---- instruction emitters ---------------------------------------------------
class Asm {
  constructor(org) { this.org = org; this.words = []; }
  get pc() { return this.org + this.words.length * 2; }
  w(...v) { for (const x of v) this.words.push(x & 0xffff); return this; }
  l(v) { return this.w((v >>> 16) & 0xffff, v & 0xffff); }

  // MOVE.W #imm,(xxx).L   0011 001 111 111 100
  moveWImmAbs(imm, addr) { return this.w(0x33fc, imm).l(addr); }
  // MOVE.L #imm,(xxx).L   0010 001 111 111 100
  moveLImmAbs(imm, addr) { return this.w(0x23fc).l(imm).l(addr); }
  // MOVE.W #imm,(An)      0011 nnn 010 111 100
  moveWImmInd(imm, an) { return this.w(0x30bc | (an << 9), imm); }
  // MOVE.W Dn,(An)        0011 nnn 010 000 rrr
  moveWRegInd(dn, an) { return this.w(0x3080 | (an << 9) | dn); }
  // LEA (xxx).L,An        0100 nnn 111 111 001
  lea(addr, an) { return this.w(0x41f9 | (an << 9)).l(addr); }
  // MOVEQ #n,Dn           0111 nnn 0 iiiiiiii
  moveq(imm, dn) { return this.w(0x7000 | (dn << 9) | (imm & 0xff)); }
  // ADDQ.L #1,(xxx).L     0101 001 0 10 111 001
  addqLAbs(addr) { return this.w(0x52b9).l(addr); }
  // MOVE.W #imm,SR        0100 0110 0111 1100  (privileged)
  moveToSr(imm) { return this.w(0x46fc, imm); }
  // DBF Dn,label          0101 0001 1100 1rrr + 16-bit displacement
  dbf(dn, target) { this.w(0x51c8 | dn); const at = this.pc; this.w(target - at); return this; }
  // BRA.W label           0110 0000 0000 0000 + 16-bit displacement
  bra(target) { this.w(0x6000); const at = this.pc; this.w(target - at); return this; }
  nop() { return this.w(0x4e71); }
  rte() { return this.w(0x4e73); }
  bytes() {
    const b = new Uint8Array(this.words.length * 2);
    this.words.forEach((v, i) => { b[i * 2] = (v >> 8) & 0xff; b[i * 2 + 1] = v & 0xff; });
    return b;
  }
}

// A VDP control-port word that writes register `n` with `v`.
const vdpReg = (n, v) => 0x8000 | ((n & 0x1f) << 8) | (v & 0xff);
// The 32-bit command that points the data port at `addr` with access `code`.
const vdpCmd = (code, addr) => ((((code & 3) << 14) | (addr & 0x3fff)) * 0x10000
  + ((((code >> 2) & 0x0f) << 4) | ((addr >> 14) & 3))) >>> 0;

const CTRL = 0xc00004, DATA = 0xc00000;
const CD_VRAM_W = 0x01, CD_CRAM_W = 0x03;

// Registers that put the VDP into a plain, known state: mode 5, H40, display
// on with the vertical interrupt enabled, plane A at $C000, plane B at $E000,
// window at $B000, sprites at $F000, horizontal scroll at $FC00, 64x32 planes,
// auto-increment 2.
const BASE_REGS = [
  [0, 0x04], [1, 0x74], [2, 0x30], [3, 0x2c], [4, 0x07], [5, 0x78], [6, 0x00],
  [7, 0x00], [10, 0xff], [11, 0x00], [12, 0x81], [13, 0x3f], [15, 0x02],
  [16, 0x01], [17, 0x00], [18, 0x00], [19, 0x00], [20, 0x00],
];

export const TEST_COUNTER = 0xffff00; // where the interrupt handler counts

// A cartridge that fills one screen with a solid tile and counts vertical
// interrupts into work RAM. `useDmaFill` swaps the nametable write loop for a
// VDP fill DMA so the DMA path is exercised by the same test.
export function buildTestRom({ useDmaFill = false, cells = 64 * 32 } = {}) {
  const rom = new Uint8Array(ROM_SIZE);
  rom.fill(0);

  const a = new Asm(CODE);
  a.moveToSr(0x2700);                              // interrupts off while we set up
  for (const [n, v] of BASE_REGS) a.moveWImmAbs(vdpReg(n, v), CTRL);

  // Palette: entry 0 black, entry 1 bright green, entry 2 red.
  a.moveLImmAbs(vdpCmd(CD_CRAM_W, 0x0000), CTRL);
  a.moveWImmAbs(0x0000, DATA);
  a.moveWImmAbs(0x00e0, DATA);
  a.moveWImmAbs(0x000e, DATA);

  // Tile 1: 32 bytes of nibble 1, i.e. a solid square of palette colour 1.
  a.moveLImmAbs(vdpCmd(CD_VRAM_W, 0x0020), CTRL);
  a.lea(DATA, 0);
  a.moveq(15, 0);                                  // 16 words = 32 bytes
  const tileLoop = a.pc;
  a.moveWImmInd(0x1111, 0);
  a.dbf(0, tileLoop);

  if (useDmaFill) {
    // A VDP fill DMA over the plane A nametable. Length in registers 19/20,
    // source register 23 = $80 selects fill, then the command with CD5 set and
    // one data-port write to supply the fill byte.
    //
    // A fill writes its byte to only ONE byte of each word (the other keeps
    // whatever was there), so filling a nametable with $01 over cleared VRAM
    // leaves entries of $0001 — tile 1 — which is exactly what is wanted. The
    // very first cell is the exception: the data-port write that triggers the
    // fill lands as a whole word, so cell 0 reads $0101. That asymmetry is the
    // hardware's, and the test asserts it.
    const len = cells * 2;
    a.moveWImmAbs(vdpReg(19, len & 0xff), CTRL);
    a.moveWImmAbs(vdpReg(20, (len >> 8) & 0xff), CTRL);
    a.moveWImmAbs(vdpReg(23, 0x80), CTRL);
    a.moveLImmAbs(vdpCmd(CD_VRAM_W | 0x20, 0xc000), CTRL);
    a.moveWImmAbs(0x0101, DATA);
  } else {
    a.moveLImmAbs(vdpCmd(CD_VRAM_W, 0xc000), CTRL);
    a.lea(DATA, 0);
    // A full plane is more cells than MOVEQ's 8 bits can hold, so the loop
    // count comes in as a word.
    a.w(0x303c, cells - 1);                        // MOVE.W #cells-1,D0
    const ntLoop = a.pc;
    a.moveWImmInd(0x0001, 0);                      // nametable entry: tile 1, palette 0
    a.dbf(0, ntLoop);
  }

  a.moveToSr(0x2000);                              // interrupts on
  const idle = a.pc;
  a.nop();
  a.bra(idle);

  const code = a.bytes();
  rom.set(code, CODE);

  // The vertical-interrupt handler: bump a long in work RAM and return.
  const handlerAt = CODE + code.length;
  const h = new Asm(handlerAt);
  h.addqLAbs(TEST_COUNTER);
  h.rte();
  rom.set(h.bytes(), handlerAt);

  // Vectors. Every unused one points at the handler too, so a stray exception
  // shows up as a wildly wrong counter instead of a silent runaway.
  const setVec = (n, addr) => {
    rom[n * 4] = (addr >>> 24) & 0xff; rom[n * 4 + 1] = (addr >>> 16) & 0xff;
    rom[n * 4 + 2] = (addr >>> 8) & 0xff; rom[n * 4 + 3] = addr & 0xff;
  };
  setVec(0, 0x00fffe00);      // initial SSP
  setVec(1, CODE);            // initial PC
  for (let v = 2; v < 64; v++) setVec(v, handlerAt);

  writeHeader(rom);
  return rom;
}

// A cartridge that does nothing but spin, for tests that only need a CPU with
// vectors and a machine that boots.
export function buildIdleRom() {
  const rom = new Uint8Array(ROM_SIZE);
  const a = new Asm(CODE);
  const idle = a.pc;
  a.nop();
  a.bra(idle);
  rom.set(a.bytes(), CODE);
  const setVec = (n, addr) => {
    rom[n * 4] = (addr >>> 24) & 0xff; rom[n * 4 + 1] = (addr >>> 16) & 0xff;
    rom[n * 4 + 2] = (addr >>> 8) & 0xff; rom[n * 4 + 3] = addr & 0xff;
  };
  setVec(0, 0x00fffe00);
  setVec(1, CODE);
  for (let v = 2; v < 64; v++) setVec(v, CODE);
  writeHeader(rom);
  return rom;
}

function writeHeader(rom) {
  const put = (off, s, len) => {
    for (let i = 0; i < len; i++) rom[off + i] = i < s.length ? s.charCodeAt(i) : 0x20;
  };
  put(0x100, 'SEGA MEGA DRIVE ', 16);
  put(0x110, '(C)UPD3301 2026 ', 16);
  put(0x120, 'MDTEST', 48);
  put(0x150, 'MDTEST', 48);
  put(0x180, 'GM 00000000-00', 14);
  put(0x190, 'J', 16);
  const be32 = (off, v) => { rom[off] = (v >>> 24) & 0xff; rom[off + 1] = (v >>> 16) & 0xff; rom[off + 2] = (v >>> 8) & 0xff; rom[off + 3] = v & 0xff; };
  be32(0x1a0, 0);
  be32(0x1a4, rom.length - 1);
  be32(0x1a8, 0x00ff0000);
  be32(0x1ac, 0x00ffffff);
  put(0x1b0, '  ', 2);
  put(0x1f0, 'JUE', 3);
  // The checksum is over $200 to the end, big-endian words, 16-bit wrap.
  let sum = 0;
  for (let i = 0x200; i + 1 < rom.length; i += 2) sum = (sum + ((rom[i] << 8) | rom[i + 1])) & 0xffff;
  rom[0x18e] = (sum >> 8) & 0xff; rom[0x18f] = sum & 0xff;
  return rom;
}

export { VECTORS, CODE, ROM_SIZE };
