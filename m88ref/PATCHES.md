# M88M source patches needed for refdrv.cpp hooks

Apply these to a fresh `git clone https://github.com/bubio/M88M` before building:

## src/devices/Z80c.cpp
- `SingleStep()`: prepend `if (g_pcHook && (void*)this == g_mainCpu) g_pcHook(GetPC());`
  and declare `extern void* g_mainCpu; extern void (*g_pcHook)(unsigned pc);`
- `Write8()`: after `addr &= 0xffff;` add
  `extern void (*g_e6cdHook)(unsigned,unsigned,unsigned); if (g_e6cdHook && (addr==0xe6cd||addr==0xec88||addr==0xec89)) g_e6cdHook(GetPC(),addr,data);`

## src/pc88/fdc.cpp  (after `using namespace PC8801;`)
- `extern void (*g_fdcResultHook)(unsigned,unsigned,unsigned,unsigned,unsigned,unsigned,unsigned);`
- `ReadData()`: prepend `extern void (*g_fdcReadHook)(unsigned,unsigned,unsigned,unsigned,unsigned); if(g_fdcReadHook) g_fdcReadHook(idr.c,idr.h,idr.r,idr.n,eot);`
- `ShiftToResultPhase7()`: before `Intr(true);` add `if(::g_fdcResultHook) ::g_fdcResultHook(buffer[0..6]);`
- `GetData()` execreadphase: add `g_fdcDataCount++;` (declare `extern unsigned g_fdcDataCount;`)

## src/pc88/subsys.cpp  (after `using namespace PC8801;`)
- `extern void (*g_mrdHook)(unsigned,unsigned);`
- `M_Read0()`: after `uint d=piom.Read0();` add `if(::g_mrdHook) ::g_mrdHook(0,d);`

Build (no cmake): compile src/{common,devices,pc88}/*.cpp (minus Z80_x86/Z80Test/Z80Debug/memview/ioview)
with `-fpermissive -DNDEBUG -DM88_NO_Z80_X86 -DM88_PORTABLE`, ar into libm88core.a, link refdrv.cpp -lz.
