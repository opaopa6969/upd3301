// machinenes — the Famicom / NES as a machine, on the same contract as
// Pc8801Machine: `stepFrame()`, `frame`, `snapshot()`, `restore()`,
// `schemaVersion`. The host in demo/machine.html implements fast-forward,
// rewind and jog-shuttle on top of that contract and nothing else, so a
// machine that satisfies it gets time travel for free. That is the entire
// reason this console is here.
//
// The coordinator closes the loop the engines cannot close themselves:
// m6502.js knows nothing about a PPU, nesppu.js knows nothing about a CPU,
// nesmapper.js knows nothing about either. This file wires them.
//
// ## How the CPU and the PPU stay in step
//
// The PPU runs at exactly three dots per CPU cycle, and games depend on that
// ratio to the dot: they change the scroll registers *while a scanline is
// being drawn*. An emulator that runs "one instruction, then N dots" puts
// those writes at instruction granularity and the split-screen lands a few
// pixels off.
//
// m6502.js has no cycle table — every bus access is exactly one cycle (see
// docs/nes-design.md §4). So the CPU's own bus IS a cycle clock, and the
// synchronisation is one line: tick the PPU three dots at the start of every
// bus access, then perform the access. Register writes then land on their
// real dot with no catch-up logic anywhere, and the dummy reads the 6502
// performs (page-cross, read-modify-write) advance the PPU exactly as they do
// on hardware.
//
// ## The APU and the CPU
//
// nesapu.js is clocked from the same _tick3() as the PPU, one APU tick per CPU
// cycle. Two of its outputs are not sound at all and have to be wired here: the
// frame counter's IRQ (games use it as a timer) and the DMC's DMA, which halts
// the CPU for four cycles while it fetches a sample byte. The halt is done the
// same way OAM DMA does it — by spending the cycles on the machine's clock
// while the CPU is not executing.

import { M6502 } from './m6502.js';
import { NesPpu, SCREEN_W, SCREEN_H, buildNesPaletteRgb } from './nesppu.js';
import { createMapper } from './nesmapper.js';
import { parseINes, MIRRORING } from './ines.js';
import { NesApu } from './nesapu.js';

export const SCHEMA_VERSION = 1;

// NTSC: 21.477272 MHz / 12 for the CPU, and the frame is 261.5 scanlines of
// 341 dots on average (the odd-frame short line), i.e. 60.0988 Hz. Using the
// real rate rather than a flat 60 keeps the emulation clock — and, once the
// APU lands, the music tempo — at true speed.
export const NTSC_FRAME_HZ = 60.098813897440515;
export const NTSC_CPU_HZ = 1789772.7272727273;

// Controller bits, in the order the shift register presents them.
export const BUTTON = Object.freeze({
  A: 0, B: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7,
});

const PALETTE_RGB = buildNesPaletteRgb();

export class NesMachine {
  // Either `cart` (already parsed by ines.js) or `rom` (raw .nes bytes).
  constructor({ cart = null, rom = null, frameHz = NTSC_FRAME_HZ, sampleRate = 48000 } = {}) {
    if (!cart && rom) cart = parseINes(rom);
    if (!cart) throw new Error('NesMachine needs a cartridge (cart or rom)');
    this.cart = cart;
    this.schemaVersion = SCHEMA_VERSION;
    this.frameHz = frameHz;
    this.frame = 0;
    this._acc = 0;

    this.ram = new Uint8Array(0x800); // the console's entire work memory
    this.mapper = createMapper(cart);
    this.ppu = new NesPpu(this.mapper, { fourScreen: cart.mirroring === MIRRORING.FOUR_SCREEN });

    // Controllers: one byte of live button state each (BUTTON bits), plus the
    // shift register the game clocks out of $4016/$4017.
    this.pads = new Uint8Array(2);
    this._padShift = new Uint8Array(2);
    this._strobe = false;

    this._openBus = 0;
    this._nmiPrev = false;
    this._dmaActive = false;
    this._inDmcDma = false;

    this.apu = new NesApu({ sampleRate, cpuHz: NTSC_CPU_HZ });

    // The bus is a closure so the CPU sees a plain { read, write } and stays a
    // general 6502. Every access ticks the clock first (see the header).
    this.cpu = new M6502({
      read: (a) => { this._tick3(); return this._read(a); },
      write: (a, v) => { this._tick3(); this._write(a, v); },
    });

    if (cart.trainer) this.mapper.prgRam.set(cart.trainer.subarray(0, 512), 0x1000);
    this.reset();
  }

  reset() {
    this.ppu.reset();
    this.apu.reset();
    this._nmiPrev = false;
    this.cpu.setNmi(false);
    this.cpu.reset();
    return this;
  }

  powerOn() {
    this.ram.fill(0);
    this.ppu.powerOn();
    this.apu.powerOn();
    this.mapper.reset();
    this.frame = 0;
    this._acc = 0;
    return this.reset();
  }

  // ---- the clock -----------------------------------------------------------
  _tick3() {
    // The 6502 latches the NMI edge at the END of a cycle, so the level the
    // PPU presents during cycle N only reaches the interrupt logic in cycle
    // N+1. That one cycle of pipeline is exactly the difference between "NMI
    // taken after this instruction" and "after the next one", which is what
    // blargg's nmi timing tests measure.
    // The NMI line is sampled inside the cycle, not at its edge. m6502.js
    // polls interrupts at instruction boundaries, so the level handed to it
    // at the start of cycle N is what the poll after cycle N sees — and the
    // dot at which that level was sampled is what blargg's 05-nmi_timing
    // measures, to a single PPU clock. Sampling after the SECOND of this
    // cycle's three dots puts the poll where the hardware puts it; sampling
    // at either end of the cycle is off by one dot in one direction or two
    // in the other (the granularity of a CPU cycle is three dots, so the
    // sample point has to sit inside).
    const ppu = this.ppu;
    // Boards whose IRQ counter runs off the CPU clock rather than the PPU's
    // address bus (Sunsoft FME-7, the VRC family) get told the cycle first, so
    // the line they raise is on the wire by this cycle's sample point below.
    // MMC3-class boards do not use this — they count PPU A12 rises — and the
    // flag keeps the call off the hot path for every board that needs neither.
    if (this.mapper.wantsCpuCycle) this.mapper.cpuCycle(1);
    ppu.tick();
    this.cpu.setNmi(ppu.nmiLine());
    ppu.tick();
    // The IRQ line has its own sample point. Two independent sources share the
    // wire (the mapper's scanline counter and the APU frame counter), and
    // setIrqSource keeps them apart so one releasing does not cancel the
    // other's request. The dot chosen here is what mmc3_test's
    // 4-scanline_timing measures — it asks, to a single PPU clock, whether the
    // IRQ lands before or after one more instruction.
    this.cpu.setIrqSource(0, this.mapper.irq);
    this.cpu.setIrqSource(1, this.apu.irq);
    ppu.tick();
    this.apu.tick();
    // The DMC has run out of shift-register bits and wants the next sample
    // byte. It cannot ask the bus itself — the bus belongs to the machine —
    // so the stall happens here, outside the APU, in the same way OAM DMA
    // does it. The guard is not paranoia: _dmcDma() spends cycles, each of
    // which comes back through _tick3().
    if (this.apu.dmc.needByte && !this._inDmcDma) this._dmcDma();
  }

  // ---- DMC DMA -------------------------------------------------------------
  // Four cycles of the CPU doing nothing while the sound hardware reads one
  // byte of sample data. Those cycles are *stolen*, not shared: an instruction
  // in progress is suspended between its own cycles, which is why a raster
  // split timed by counting instructions drifts when a sample is playing, and
  // why blargg's 4-irq_and_dma exists. The cost is charged to cpu.cycles
  // directly because the CPU is halted and cannot charge it itself.
  _dmcDma() {
    this._inDmcDma = true;
    this.cpu.stallForDma();
    const addr = this.apu.dmc.curAddr;
    for (let i = 0; i < 3; i++) this._dmaCycle();  // halt + alignment + dummy
    this.cpu.cycles++;
    this._tick3();
    const v = this._read(addr);
    this._openBus = v;
    this.apu.dmc.fill(v);
    this._inDmcDma = false;
  }

  // ---- CPU bus -------------------------------------------------------------
  _read(addr) {
    addr &= 0xffff;
    let v;
    if (addr < 0x2000) v = this.ram[addr & 0x7ff];              // 2KB, mirrored x4
    else if (addr < 0x4000) v = this.ppu.readReg(addr & 7);     // 8 registers, mirrored
    else if (addr === 0x4015) v = this.apu.readStatus(this._openBus);
    else if (addr === 0x4016) v = this._padRead(0);
    else if (addr === 0x4017) v = this._padRead(1);
    else if (addr < 0x4020) v = this._openBus;                  // write-only / test regs
    else v = this.mapper.cpuRead(addr);
    this._openBus = v;
    return v;
  }

  _write(addr, value) {
    addr &= 0xffff;
    value &= 0xff;
    this._openBus = value;
    if (addr < 0x2000) { this.ram[addr & 0x7ff] = value; return; }
    if (addr < 0x4000) { this.ppu.writeReg(addr & 7, value); return; }
    if (addr === 0x4014) { this._oamDma(value); return; }
    if (addr === 0x4016) { this._padStrobe(value); return; }
    if (addr < 0x4018) { this.apu.write(addr, value); return; }
    if (addr < 0x4020) return; // CPU test registers, disabled on a retail NES
    this.mapper.cpuWrite(addr, value, this.cpu.cycles);
  }

  // ---- OAM DMA ($4014) -----------------------------------------------------
  // 256 bytes copied into OAM one at a time, with the CPU halted. It costs
  // 513 cycles (514 when it starts on an odd cycle), and those cycles are
  // real: the PPU keeps drawing through them, which is why a game that starts
  // its DMA too late gets a torn sprite list. The cycles are added to the CPU
  // count by hand because the CPU is not executing during them.
  _oamDma(page) {
    this._dmaActive = true;
    this.cpu.stallForDma();
    this._dmaCycle();                          // the halt cycle
    if (this.cpu.cycles & 1) this._dmaCycle(); // alignment: DMA reads on even cycles
    const base = (page & 0xff) << 8;
    for (let i = 0; i < 256; i++) {
      this._dmaCycle();
      const v = this._read(base + i);
      this._dmaCycle();
      this.ppu.writeReg(4, v);
    }
    this._dmaActive = false;
  }

  _dmaCycle() { this.cpu.cycles++; this._tick3(); }

  // ---- controllers ---------------------------------------------------------
  // The pad is a parallel-in serial-out shift register. While strobe is high
  // it reloads continuously; the game drops strobe and then clocks eight bits
  // out by reading $4016 eight times.
  _padStrobe(value) {
    const on = (value & 1) !== 0;
    if (on) { this._padShift[0] = this.pads[0]; this._padShift[1] = this.pads[1]; }
    else if (this._strobe) { this._padShift[0] = this.pads[0]; this._padShift[1] = this.pads[1]; }
    this._strobe = on;
  }

  _padRead(port) {
    if (this._strobe) { this._padShift[port] = this.pads[port]; }
    const v = this._padShift[port] & 1;
    if (!this._strobe) this._padShift[port] = (this._padShift[port] >> 1) | 0x80; // past bit 8: all 1s
    // Bits 5-7 are open bus; the high byte of the address ($40) is what a real
    // console leaves there, and several games AND with $01 anyway.
    return v | 0x40;
  }

  padDown(bit, pad = 0) { this.pads[pad] |= (1 << bit); return this; }
  padUp(bit, pad = 0) { this.pads[pad] &= ~(1 << bit); return this; }
  setPad(mask, pad = 0) { this.pads[pad] = mask & 0xff; return this; }

  // ---- audio ---------------------------------------------------------------
  // Same signature as machine88.renderAudio(): fill a mono Float32Array at the
  // APU's sample rate. The host pump in demo/machine.html calls this and does
  // not care which machine it is talking to. Unlike the OPN, the samples were
  // already produced while the CPU ran (see nesapu.js) — this only drains them.
  renderAudio(out, n = out.length) { return this.apu.render(out, n); }

  // ---- run -----------------------------------------------------------------
  // One video frame = "run until the PPU enters vblank". That boundary is the
  // natural one: the picture just finished, and the game's NMI handler runs at
  // the start of the NEXT stepFrame, so a snapshot taken here holds a complete
  // image and a game about to be told about it.
  stepFrame() {
    const ppu = this.ppu;
    ppu.frameComplete = false;
    // A frame is ~29,780 CPU cycles; the guard is a safety net for a jammed or
    // pathological ROM, not a timing device.
    let guard = 200000;
    while (!ppu.frameComplete && guard-- > 0) {
      // A KIL/JAM opcode stops the CPU dead, and with it every bus access —
      // so the raster would stop too and the host would hang inside one
      // stepFrame. Keep the clock running by hand instead.
      if (this.cpu.jammed) { this.cpu.cycles++; this._tick3(); }
      else this.cpu.step();
    }
    this.frame++;
    return this;
  }

  // Same shape as the 8801's: accumulate real time and emit whole frames.
  update(dt, onFrame = null) {
    this._acc += dt;
    const period = 1 / this.frameHz;
    while (this._acc >= period) { this._acc -= period; this.stepFrame(); if (onFrame) onFrame(); }
    return this;
  }

  // ---- video ---------------------------------------------------------------
  // Plain data out, exactly like machine88.js:
  //   default        → { width, height, rgb }  (8 bits per channel)
  //   indexed: true  → { width, height, pixels, drive } for the demo's shared
  //                    CRT pipeline, where `pixels` is a GRB index (0..7) and
  //                    `drive` the per-gun beam level. The NES has 64 colours
  //                    and the phosphor sim has three guns, so the index alone
  //                    would flatten the picture to eight colours — `drive`
  //                    (analog) is what carries the real palette through.
  render({ out = null, indexed = false, analog = true } = {}) {
    const W = SCREEN_W, H = SCREEN_H, N = W * H;
    const buf = this.ppu.frameBuf, emph = this.ppu.frameEmph;
    if (indexed) {
      const pixels = out && out.length === N ? out : new Uint8Array(N);
      let drive = null;
      if (analog) {
        if (!this._driveBuf || this._driveBuf.length !== N * 3) this._driveBuf = new Float32Array(N * 3);
        drive = this._driveBuf;
      }
      for (let i = 0; i < N; i++) {
        const o = (((emph[i] & 7) << 6) | (buf[i] & 0x3f)) * 3;
        const r = PALETTE_RGB[o], g = PALETTE_RGB[o + 1], b = PALETTE_RGB[o + 2];
        pixels[i] = (g >= 128 ? 4 : 0) | (r >= 128 ? 2 : 0) | (b >= 128 ? 1 : 0);
        if (drive) { drive[i] = r / 255; drive[N + i] = g / 255; drive[2 * N + i] = b / 255; }
      }
      return { width: W, height: H, pixels, drive, schemaVersion: SCHEMA_VERSION };
    }
    const rgb = out && out.length === N * 3 ? out : new Uint8Array(N * 3);
    for (let i = 0; i < N; i++) {
      const o = (((emph[i] & 7) << 6) | (buf[i] & 0x3f)) * 3;
      rgb[i * 3] = PALETTE_RGB[o];
      rgb[i * 3 + 1] = PALETTE_RGB[o + 1];
      rgb[i * 3 + 2] = PALETTE_RGB[o + 2];
    }
    return { width: W, height: H, rgb, schemaVersion: SCHEMA_VERSION };
  }

  // ---- time travel ---------------------------------------------------------
  // The whole point. Everything mutable, nothing immutable: PRG-ROM and
  // CHR-ROM stay in the cartridge this machine already holds, and the frame
  // buffer is output, not state. That lands a snapshot at roughly 3KB for a
  // plain NROM game and ~11KB for a board with CHR-RAM and saved work RAM —
  // small enough that the host's 1000-snapshot ring is bounded by the ring,
  // not by memory.
  snapshot() {
    return {
      schemaVersion: SCHEMA_VERSION,
      cpu: this.cpu.getState(),
      ram: this.ram.slice(),
      ppu: this.ppu.getState(),
      mapper: this.mapper.getState(),
      pads: this.pads.slice(),
      padShift: this._padShift.slice(),
      strobe: this._strobe,
      openBus: this._openBus,
      nmiPrev: this._nmiPrev,
      // Arrays of numbers and booleans, no sample ring (see nesapu.js's header):
      // ~90 numbers, which is why adding the whole APU did not move the
      // snapshot size measurably.
      apu: this.apu.getState(),
      frame: this.frame,
      acc: this._acc,
    };
  }

  restore(s) {
    this.cpu.setState(s.cpu);
    this.ram.set(s.ram);
    this.ppu.setState(s.ppu);
    this.mapper.setState(s.mapper);
    this.pads.set(s.pads);
    this._padShift.set(s.padShift);
    this._strobe = s.strobe;
    this._openBus = s.openBus;
    this._nmiPrev = s.nmiPrev;
    this.apu.setState(s.apu);
    this.frame = s.frame;
    this._acc = s.acc ?? 0;
    // The CPU's own interrupt lines are part of its state, but the levels the
    // machine drives them with are ours; re-assert them so the first cycle
    // after a restore sees the same wires as the first cycle before it.
    this.cpu.setIrqSource(0, this.mapper.irq);
    this.cpu.setIrqSource(1, this.apu.irq);
    return this;
  }

  // ---- debugging -----------------------------------------------------------
  // What blargg's test ROMs write: a status byte at $6000 (00 = pass, 80 =
  // running, 81 = "reset me", anything else is the failure code) and a
  // NUL-terminated message from $6004. Only meaningful once the ROM has
  // written the $DE $B0 $61 signature, which is how "the test has started"
  // is told apart from "PRG-RAM happens to contain zero".
  testResult() {
    const ram = this.mapper.prgRam;
    if (!ram || ram.length < 0x100) return null;
    if (ram[1] !== 0xde || ram[2] !== 0xb0 || ram[3] !== 0x61) return null;
    let text = '';
    for (let i = 4; i < ram.length && ram[i] !== 0 && text.length < 512; i++) {
      text += String.fromCharCode(ram[i]);
    }
    return { status: ram[0], text };
  }
}

export function createNesMachine(opts) { return new NesMachine(opts); }
