// Headless M88M reference tracer — boots a D88 and watches key game state,
// to diff against our pure-JS emulator. Usage: refdrv <romDir> <disk.d88> [frames]
#include "pc88.h"
#include "subsys.h"
#include "memory.h"
#include "diskmgr.h"
#include "tapemgr.h"
#include "draw.h"
#include "config.h"
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <unistd.h>

static int g_frame = 0;
static unsigned g_last[3] = {0x100,0x100,0x100}; // e6cd, ec88, ec89 last-logged
void (*g_e6cdHook)(unsigned pc, unsigned addr, unsigned val) = nullptr;
static void e6cdLog(unsigned pc, unsigned addr, unsigned val) {
  int idx = (addr==0xe6cd)?0:(addr==0xec88)?1:2;
  if (g_last[idx] == val) return;         // only log transitions
  g_last[idx] = val;
  const char* nm = (addr==0xe6cd)?"E6CD":(addr==0xec88)?"EC88lo":"EC88hi";
  printf("f%-4d %s <- %02x  @pc=%04x\n", g_frame, nm, val, pc);
}

static int g_rdN = 0;
static int g_traceOn = 0, g_traceN = 0, g_traceMax = 0;
// M88_TRACE_R=1: record the Z80 refresh counter alongside each PC. R counts M1
// cycles, so it is a direct fingerprint of "how many instructions has this CPU
// actually executed" — and it stops advancing while the CRTC's DMA holds the
// bus. Two emulators running the identical instruction stream can still差 here
// if they steal cycles differently, which is exactly what a PC-only trace hides.
static int g_traceR = 0;
static unsigned char* g_rbuf = nullptr;
static unsigned* g_pcbuf = nullptr;
void* g_mainCpu = nullptr;
void (*g_pcHook)(unsigned pc) = nullptr;
// Arming: by frame (M88_TRACE_FROM) or by first execution of a PC
// (M88_TRACE_ARMPC). The PC anchor is the useful one for cross-emulator diffs —
// our emulator boots ~20 frames ahead of M88, so frame numbers do not line up,
// but "the first time the program reaches address X" does.
static int g_armFrame = -1, g_armFdc = 0;
static long g_armPc = -1;
static void pcLog(unsigned pc) {
  if (!g_traceOn) {
    if (g_armPc >= 0 && (long)pc == g_armPc) g_traceOn = 1;
    else if (g_armFrame >= 0 && g_frame >= g_armFrame) g_traceOn = 1;
    else return;
  }
  if (g_traceN < g_traceMax) {
    if (g_traceR && g_rbuf && g_mainCpu) {
      const Z80Reg& rg = ((Z80C*)g_mainCpu)->GetReg();
      g_rbuf[g_traceN] = (unsigned char)((rg.rreg & 0x7f) | (rg.rreg7 & 0x80));
    }
    g_pcbuf[g_traceN++] = pc;
  }
}

// Range write-watch, the M88-side mirror of tools/watch-write.mjs.
// M88_WATCH=<lo>-<hi> (hex) prints every MAIN-CPU store landing in that range.
unsigned g_wrLo = 0xffffffff, g_wrHi = 0;
void (*g_wrHook)(unsigned pc, unsigned addr, unsigned val) = nullptr;
static long g_wrMax = 400, g_wrN = 0;
static void wrLog(unsigned pc, unsigned addr, unsigned val) {
  if (++g_wrN > g_wrMax) return;
  printf("WR f%-4d pc=%04x [%04x]=%02x\n", g_frame, pc, addr, val);
}

// Range read-watch. Reads are the better probe when two emulators run the same
// code over different *data*: this records the bytes the CPU actually saw,
// already resolved through whatever bank was selected, so it needs no guess
// about where an address lives.
unsigned g_rdLo = 0xffffffff, g_rdHi = 0;
void (*g_rdHook)(unsigned pc, unsigned addr, unsigned val) = nullptr;
static long g_rdMax = 4000, g_rdWN = 0;
static unsigned g_rdPcLo = 0, g_rdPcHi = 0xffff;   // M88_RWATCH_PC=<lo>[-<hi>]
static void rdLog(unsigned pc, unsigned addr, unsigned val) {
  if (pc < g_rdPcLo || pc > g_rdPcHi) return;
  if (++g_rdWN > g_rdMax) return;
  printf("RD f%-4d pc=%04x [%04x]=%02x\n", g_frame, pc, addr, val);
}
unsigned g_fdcDataCount=0;
void (*g_mrdHook)(unsigned,unsigned)=nullptr;
static void mrdLog(unsigned port,unsigned val){ printf("MRD %02x\n", val); }
static int g_resN = 0;
void (*g_fdcResultHook)(unsigned,unsigned,unsigned,unsigned,unsigned,unsigned,unsigned) = nullptr;
static void fdcResultLog(unsigned st0,unsigned st1,unsigned st2,unsigned c,unsigned h,unsigned r,unsigned n){
  printf("f%-4d RESULT ST[%02x %02x %02x] C%u H%u R%u N%u\n", g_frame, st0,st1,st2,c,h,r,n);
  // legacy arming: M88_TRACE_ARMFDC=<n> starts the trace after the n'th FDC
  // result (this was hardcoded to 6 for 軽井沢's cyl20 read).
  if (g_armFdc > 0 && ++g_resN == g_armFdc) g_traceOn = 1;
}

void (*g_fdcReadHook)(unsigned c, unsigned h, unsigned r, unsigned n, unsigned eot) = nullptr;
static void fdcReadLog(unsigned c, unsigned h, unsigned r, unsigned n, unsigned eot) {
  ++g_rdN;
}

class NullDraw : public Draw {
  uint8 buf_[640*400*2];
public:
  bool Init(uint,uint,uint) override { return true; }
  bool Cleanup() override { return true; }
  bool Lock(uint8** p, int* bpl) override { *p=buf_; *bpl=640; return true; }
  bool Unlock() override { return true; }
  uint GetStatus() override { return 7; } // readytodraw|shouldrefresh|flippable
  void Resize(uint,uint) override {}
  void DrawScreen(const Region&) override {}
  void SetPalette(uint,uint,const Palette*) override {}
  bool SetFlipMode(bool) override { return true; }
};

int main(int argc, char** argv) {
  if (argc < 3) { printf("usage: refdrv <romDir> <disk.d88> [frames]\n"); return 2; }
  const char* romDir = argv[1];
  const char* diskPath = argv[2];
  int frames = argc > 3 ? atoi(argv[3]) : 600;
  if (chdir(romDir) != 0) { printf("ERR chdir %s\n", romDir); return 1; } // ROM loaders use cwd-relative paths

  using PC8801::Config;
  static Config cfg;
  memset(&cfg, 0, sizeof(cfg));
  cfg.basicmode = Config::N88V2;
  cfg.clock = 40;            // 4MHz (units of 0.1MHz)
  cfg.mainsubratio = 1;
  cfg.speed = 100;
  cfg.cpumode = Config::msauto;
  cfg.dipsw = 1829;
  cfg.flags = Config::enableopna | Config::subcpucontrol | Config::enablewait
            | Config::precisemixing | Config::mixsoundalways;
  cfg.flag2 = Config::resetondrop;
  cfg.sound = 0;             // no audio device
  cfg.opnclock = 3993600;

  static NullDraw draw;
  static DiskManager diskmgr;
  static TapeManager tapemgr;
  static PC88 pc88;

  if (!diskmgr.Init()) { printf("ERR diskmgr.Init\n"); return 1; }
  if (!pc88.Init(&draw, &diskmgr, &tapemgr, romDir)) { printf("ERR pc88.Init (roms?)\n"); return 1; }
  pc88.ApplyConfig(&cfg);
  pc88.Reset();
  if (!diskmgr.Mount(0, diskPath, true, 0, false)) { printf("ERR mount %s\n", diskPath); return 1; }
  // MOUNT IMAGE 1 INTO DRIVE 1 AS WELL -- 202 of our 353 .d88 files hold more
  // than one image, and the Node harness has always put image 1 into drive 1
  // ("insert every image, u<2" in tools/batch-compare.mjs). Mounting only image
  // 0 here meant the two emulators ran different machines on more than half the
  // collection: any title that wants a second disk -- Hydlide3's USER disk,
  // PRO_FAN's Gibs disk, Star Cruiser's disk B -- found drive 1 empty and sat on
  // the N88-BASIC prompt. Those four titles spent the whole parity run recorded
  // as "M88 cannot boot them", which was evidence that M88 is not a gold
  // standard. It was this line. Mounting image 1 moved the sweep from 328 exact
  // / 333 tracking to 332 / 341 and took the divergence list from 18 to 11.
  // A single-image file simply fails the mount, which is fine and expected.
  if (diskmgr.Mount(1, diskPath, true, 1, false)) printf("# drive1: image 1 mounted\n");
  else printf("# drive1: single-image file, drive 1 left empty\n");
  pc88.Reset();

  PC8801::Memory* mem = pc88.GetMem1();
  uint8* ram = mem->GetRAM();
  uint8* tv  = mem->GetTVRAM();

  int clock = cfg.clock;
  int eff   = clock * cfg.speed / 100;
  int fp    = pc88.GetFramePeriod();
  printf("# booted. framePeriod=%d clock=%d eff=%d\n", fp, clock, eff);

  g_e6cdHook = e6cdLog;
  g_fdcReadHook = fdcReadLog;
  g_fdcResultHook = fdcResultLog;
  // Which CPU the pc/read/write hooks follow. The disk sub-system is a second
  // Z80 running DISK.ROM, and the 8255 handshake between the two is where a
  // whole class of divergences lives — so it must be traceable too.
  const char* whichCpu = getenv("M88_CPU");
  const bool traceSub = whichCpu && (whichCpu[0] == 's' || whichCpu[0] == 'S' || whichCpu[0] == '2');
  g_mainCpu = traceSub ? (void*)pc88.GetCPU2() : (void*)pc88.GetCPU1();
  if (traceSub) printf("# hooks follow the SUB cpu (CPU2)\n");
  // g_mrdHook = mrdLog;  // (byte log off — capturing pc trace instead)

  // ---- env-configured instrumentation (see m88ref/README.md) ----
  const char* tracePath = getenv("M88_TRACE");
  if (tracePath) {
    if (const char* s = getenv("M88_TRACE_FROM"))  g_armFrame = atoi(s);
    if (const char* s = getenv("M88_TRACE_ARMPC")) g_armPc = strtol(s, 0, 16);
    if (const char* s = getenv("M88_TRACE_ARMFDC")) g_armFdc = atoi(s);
    g_traceMax = (int)((getenv("M88_TRACE_MAX")) ? atol(getenv("M88_TRACE_MAX")) : 200000);
    if (g_armFrame < 0 && g_armPc < 0 && g_armFdc == 0) g_armFrame = 0;  // default: from boot
    g_pcbuf = new unsigned[g_traceMax];
    if (getenv("M88_TRACE_R")) { g_traceR = 1; g_rbuf = new unsigned char[g_traceMax]; }
    g_pcHook = pcLog;
    printf("# trace -> %s  (armFrame=%d armPc=%ld armFdc=%d max=%d)\n",
           tracePath, g_armFrame, g_armPc, g_armFdc, g_traceMax);
  }
  if (const char* w = getenv("M88_WATCH")) {
    unsigned lo = 0, hi = 0; char* end = nullptr;
    lo = (unsigned)strtol(w, &end, 16);
    hi = (end && *end == '-') ? (unsigned)strtol(end + 1, 0, 16) : lo;
    g_wrLo = lo; g_wrHi = hi; g_wrHook = wrLog;
    if (const char* s = getenv("M88_WATCH_MAX")) g_wrMax = atol(s);
    printf("# watching MAIN writes to %04x-%04x (max %ld lines)\n", lo, hi, g_wrMax);
  }
  if (const char* w = getenv("M88_RWATCH")) {
    char* end = nullptr;
    unsigned lo = (unsigned)strtol(w, &end, 16);
    unsigned hi = (end && *end == '-') ? (unsigned)strtol(end + 1, 0, 16) : lo;
    g_rdLo = lo; g_rdHi = hi; g_rdHook = rdLog;
    if (const char* s = getenv("M88_RWATCH_MAX")) g_rdMax = atol(s);
    if (const char* s = getenv("M88_RWATCH_PC")) {
      char* e2 = nullptr;
      g_rdPcLo = (unsigned)strtol(s, &e2, 16);
      g_rdPcHi = (e2 && *e2 == '-') ? (unsigned)strtol(e2 + 1, 0, 16) : g_rdPcLo;
      printf("# ... only reads issued from pc %04x-%04x\n", g_rdPcLo, g_rdPcHi);
    }
    printf("# watching MAIN reads of %04x-%04x (max %ld lines)\n", lo, hi, g_rdMax);
  }
  int win0 = argc > 4 ? atoi(argv[4]) : -1, win1 = argc > 5 ? atoi(argv[5]) : -1;
  for (g_frame = 0; g_frame < frames; g_frame++) {
    pc88.Proceed(fp, clock, eff);   // full frame = correct M88 timing
    if (g_frame >= win0 && g_frame <= win1)
      printf("F%-4d pc=%04x  E6CD=%02x C_ptr(EC88)=%04x\n", g_frame, pc88.GetCPU1()->GetPC(), ram[0xe6cd], ram[0xec88]|(ram[0xec89]<<8));
  }
  g_e6cdHook = nullptr;

  g_pcHook = nullptr;
  // dump the instruction trace (dedup consecutive dups) for cross-emulator diff
  if (tracePath && g_pcbuf) {
    FILE* tf = fopen(tracePath, "w");
    if (!tf) { printf("# ERR cannot write trace to %s\n", tracePath); }
    else {
      unsigned prev = 0xffffffff;
      long n = 0;
      if (g_traceR) {
        // no dedup: R changes every instruction, so a repeat of the same PC is
        // still a distinct sample
        for (int i = 0; i < g_traceN; i++) { fprintf(tf, "%04x %02x\n", g_pcbuf[i], g_rbuf[i]); n++; }
      } else
      for (int i = 0; i < g_traceN; i++) { if (g_pcbuf[i] != prev) { fprintf(tf, "%04x\n", g_pcbuf[i]); prev = g_pcbuf[i]; n++; } }
      fclose(tf);
      printf("# traced %d instrs (%ld after dedup) -> %s\n", g_traceN, n, tracePath);
      if (g_traceN >= g_traceMax) printf("# WARNING trace buffer full — raise M88_TRACE_MAX\n");
    }
  }
  if (g_wrHook && g_wrN > g_wrMax) printf("# WARNING %ld writes matched, only %ld printed\n", g_wrN, g_wrMax);

  printf("# M88 total FDC data bytes served to sub: %u\n", g_fdcDataCount);
  // dump key game-state regions for cross-emulator diff
  printf("# MEMDUMP E690: ");
  for (int i = 0xe690; i < 0xe6d0; i++) printf("%02x ", ram[i]); printf("\n");
  printf("# MEMDUMP EF80: ");
  for (int i = 0xef80; i < 0xefd0; i++) printf("%02x ", ram[i]); printf("\n");
  printf("# MEMDUMP EFD0: ");
  for (int i = 0xefd0; i < 0xf000; i++) printf("%02x ", ram[i]); printf("\n");
  // optional arbitrary dump: argv[6] = hex address, dumps 0x40 bytes of main RAM
  if (argc > 6) { unsigned da = (unsigned) strtol(argv[6], 0, 16);
    printf("# MEMDUMP %04X: ", da);
    for (unsigned i = da; i < da + 0x40; i++) printf("%02x ", ram[i & 0xffff]); printf("\n"); }

  // sub-CPU RAM: FAT walk cross-check for 軽井沢 SW-LOADER
  { uint8* sram = pc88.GetMem2()->GetRAM();  // 0x4000-sized, sub addr A → sram[A-0x4000]
    printf("# SUB FDC read commands (g_rdN): %d\n", g_rdN);
    printf("# SUB dir entry @6110: ");
    for (int i = 0x2110; i < 0x2120; i++) printf("%02x ", sram[i]); printf("\n");
    printf("# SUB FAT @6d40-6d60: ");
    for (int i = 0x2d40; i < 0x2d60; i++) printf("%02x ", sram[i]); printf("\n");
    printf("# SUB FAT[0x52] (6d52) = %02x   (>=c0 => file S is terminal/1-cluster)\n", sram[0x2d52]);
  }

  // final: count tvram content + look for "ENIX"
  int tvnz = 0; for (int i = 0; i < 0x1000; i++) if (tv[i]) tvnz++;
  // Graphics-plane fingerprint. tvramNZ alone cannot judge a title that turns the
  // text plane off and draws everything in GVRAM — it reads as "blank screen" on
  // whichever side got there first. Count non-zero bytes across the three planes
  // so a graphics-only screen is still comparable. (Total is plane-order
  // independent, so it does not matter that M88 packs the planes per address
  // while we keep three arrays.)
  { PC8801::Memory::quadbyte* gv = mem->GetGVRAM();
    int gnz = 0;
    for (int i = 0; i < 0x4000; i++)
      for (int p = 0; p < 3; p++) if (gv[i].byte[p]) gnz++;
    printf("# final gvramNZ=%d\n", gnz); }
  printf("# final E6CD=%02x EC88=%04x tvramNZ=%d\n", ram[0xe6cd], ram[0xec88]|(ram[0xec89]<<8), tvnz);
  printf("# tvram text rows (ASCII):\n");
  for (int r = 0; r < 25; r++) {
    char line[130]; int any=0;
    for (int c = 0; c < 80; c++) { uint8 ch = tv[r*120+c]; line[c] = (ch>=0x20&&ch<0x7f)?ch:(ch?'.':' '); if(ch>0x20)any=1; }
    line[80]=0;
    if (any) printf("%2d|%s\n", r, line);
  }
  return 0;
}
