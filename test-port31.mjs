// Port 31h bit 2 (PC-8801): the N80 ROM bank select that works *without*
// leaving N88 mode.
//
// M88 splits the window across two functions but both follow the same bit:
//
//     Update00R:  read = rom + (port31 & 4 ? n80 : n88);   // 0000-5fff
//     Update60R:  else if ((port31 & 6) == 4)              // 6000-7fff
//                     read = rom + n80 + 0x6000;
//
// We honoured the bit in the text-window test at 8000-83ff and nowhere else,
// which meant a game that asked for the N80 ROM kept reading N88 bytes.
//
// Games use the bit as a *probe*, because the two ROMs differ in their opening
// instruction — N88 starts `LD SP,0E1A0h`, N80 starts `LD SP,0FFFFh` — so the
// word at 0x0002 says which one is mapped. 北海道連鎖殺人事件 オホーツクに消ゆ
// reads exactly that and treats anything but FFFF as fatal:
//
//     c000  LD HL,(0002h)
//     c003  INC HL
//     c004  LD A,H / OR L
//     c006  JR NZ,0C040h      ; not the N80 ROM -> give up
//     c040  LD A,04h / OUT (31h),A / RST 00h    ; select N80, reboot, retry
//
// Reading N88 bytes made that check fail every time, so the title rebooted
// through the loop every ~40 frames for the whole 1500-frame run.
//
// No ROM file needed: the mapping is what is under test, so synthetic images
// with distinguishable bytes are strictly better than real ones. (A test that
// skips when a ROM is missing is a test that silently stops guarding — see
// docs/lessons-from-the-parity-run.md.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pc8801Machine } from './machine88.js';

const N88 = 0x11, N80 = 0x22, RAM = 0x33;
const mk = () => {
  const m = new Pc8801Machine({
    main: new Uint8Array(0x8000).fill(N88),
    n80: new Uint8Array(0x8000).fill(N80),
  });
  m.ram.fill(RAM);
  return m;
};

test('31h b2=0: 0000-7fff reads the N88 ROM', () => {
  const m = mk();
  m.out(0x31, 0x00);
  assert.equal(m.readMem(0x0002), N88);
  assert.equal(m.readMem(0x5fff), N88);
  assert.equal(m.readMem(0x6000), N88);
});

test('31h b2=1: the whole 0000-7fff window swaps to the N80 ROM', () => {
  // Both halves matter. The first carries the signature games probe; the second
  // carries the N-BASIC hook the ROM calls at `179e CALL 7F00h`, and serving
  // RAM there put the CPU on a NOP sled through uninitialised memory.
  const m = mk();
  m.out(0x31, 0x04);
  assert.equal(m.readMem(0x0000), N80, 'the reset vector comes from the N80 ROM');
  assert.equal(m.readMem(0x0002), N80, 'and so does the LD SP operand games probe');
  assert.equal(m.readMem(0x5fff), N80);
  assert.equal(m.readMem(0x6000), N80, 'Update60R: (port31 & 6) == 4 maps n80 + 0x6000');
  assert.equal(m.readMem(0x7f00), N80, 'the hook the N80 ROM CALLs');
  assert.equal(m.readMem(0x7fff), N80);
});

test('31h b1 still wins: 64K RAM mode ignores b2 entirely', () => {
  const m = mk();
  m.out(0x31, 0x06); // b1 = 64K RAM, b2 = N80
  assert.equal(m.readMem(0x0000), RAM);
  assert.equal(m.readMem(0x6000), RAM);
});

test('the bank select is live: flipping b2 changes what the same address reads', () => {
  // The probe only works because the switch takes effect immediately — the game
  // writes 31h and does `RST 00h` in the next instruction.
  const m = mk();
  m.out(0x31, 0x00);
  assert.equal(m.readMem(0x0004), N88);
  m.out(0x31, 0x04);
  assert.equal(m.readMem(0x0004), N80);
  m.out(0x31, 0x00);
  assert.equal(m.readMem(0x0004), N88);
});

test('with no N80 image the machine keeps the old behaviour rather than reading 0xff', () => {
  // Not every caller has an N80 ROM to hand; serving 0xff there would be worse
  // than serving the N88 bytes we used to serve.
  const m = new Pc8801Machine({ main: new Uint8Array(0x8000).fill(N88) });
  m.out(0x31, 0x04);
  assert.equal(m.readMem(0x0002), N88);
});
