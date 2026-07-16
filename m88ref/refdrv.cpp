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
static int g_traceOn = 0, g_traceN = 0;
static unsigned g_pcbuf[200000];
void* g_mainCpu = nullptr;
void (*g_pcHook)(unsigned pc) = nullptr;
static void pcLog(unsigned pc) { if (g_traceOn && g_traceN < 200000) g_pcbuf[g_traceN++] = pc; }
unsigned g_fdcDataCount=0;
void (*g_mrdHook)(unsigned,unsigned)=nullptr;
static void mrdLog(unsigned port,unsigned val){ printf("MRD %02x\n", val); }
static int g_resN = 0;
void (*g_fdcResultHook)(unsigned,unsigned,unsigned,unsigned,unsigned,unsigned,unsigned) = nullptr;
static void fdcResultLog(unsigned st0,unsigned st1,unsigned st2,unsigned c,unsigned h,unsigned r,unsigned n){
  printf("f%-4d RESULT ST[%02x %02x %02x] C%u H%u R%u N%u\n", g_frame, st0,st1,st2,c,h,r,n);
  if (++g_resN == 6) { g_traceOn = 1; }   // arm MAIN pc trace right after read#6 (cyl20)
  if (g_traceN > 12000) g_traceOn = 0;     // bound the window
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
  g_mainCpu = (void*)pc88.GetCPU1();  // trace MAIN cpu
  g_pcHook = pcLog;                   // enable MAIN pc trace (armed at 6th FDC result)
  // g_mrdHook = mrdLog;  // (byte log off — capturing pc trace instead)
  int win0 = argc > 4 ? atoi(argv[4]) : -1, win1 = argc > 5 ? atoi(argv[5]) : -1;
  for (g_frame = 0; g_frame < frames; g_frame++) {
    pc88.Proceed(fp, clock, eff);   // full frame = correct M88 timing
    if (g_frame >= win0 && g_frame <= win1)
      printf("F%-4d pc=%04x  E6CD=%02x C_ptr(EC88)=%04x\n", g_frame, pc88.GetCPU1()->GetPC(), ram[0xe6cd], ram[0xec88]|(ram[0xec89]<<8));
  }
  g_e6cdHook = nullptr;

  g_pcHook = nullptr;
  // dump the post-cyl20 instruction trace (dedup consecutive dups) for cross-emu diff
  { FILE* tf = fopen("/home/opa/.claude/jobs/70f55d65/tmp/m88_trace.txt", "w");
    unsigned prev = 0xffffffff;
    for (int i = 0; i < g_traceN; i++) { if (g_pcbuf[i] != prev) { fprintf(tf, "%04x\n", g_pcbuf[i]); prev = g_pcbuf[i]; } }
    fclose(tf);
    printf("# traced %d instrs after cyl20 R8\n", g_traceN);
  }

  printf("# M88 total FDC data bytes served to sub: %u\n", g_fdcDataCount);
  // dump key game-state regions for cross-emulator diff
  printf("# MEMDUMP E690: ");
  for (int i = 0xe690; i < 0xe6d0; i++) printf("%02x ", ram[i]); printf("\n");
  printf("# MEMDUMP EF80: ");
  for (int i = 0xef80; i < 0xefd0; i++) printf("%02x ", ram[i]); printf("\n");
  printf("# MEMDUMP EFD0: ");
  for (int i = 0xefd0; i < 0xf000; i++) printf("%02x ", ram[i]); printf("\n");

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
