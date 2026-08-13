**English** · [日本語](./README.ja.md)

# m88ref — a headless M88 as a cycle-accurate reference oracle

When our pure-JS PC-8801 emulator (`upd3301`) misbehaves on a title that a
reference emulator boots fine, the bug is *ours*. This directory turns **M88M**
(the cross-platform port of the classic M88 PC-8801 emulator) into a **headless,
scriptable oracle**: it boots the same disk, and exposes hooks so you can diff
M88's behaviour against ours **instruction-by-instruction, byte-by-byte, and
RAM-region-by-RAM-region**. That diff is what localizes an emulation bug from
"it hangs" down to a single divergent value.

This is the method that cracked (and is still cracking) 軽井沢誘拐案内: it proved
our FDC, our 8255 handshake, the copy-protection reads, and the game's injected
`SW-LOADER` were all faithful, by showing M88 produced *identical* FAT tables,
directory entries, and read sequences — narrowing a boot hang to one nested
loader stage.

## What's here

| file | what it is |
|------|------------|
| `build.sh` | clone M88M @ pinned commit → apply hooks → build core + `refdrv` |
| `m88m-hooks.patch` | the trace hooks, as a `git apply`-able diff (3 files) |
| `refdrv.cpp` | the headless driver: boots a `.d88`, drives the hooks, dumps state. **Mounts image 0 in drive 0 and image 1 in drive 1** (see below) |
| `PATCHES.md` | prose description of each hook (for porting to a newer M88M) |
| `README.ja.md` | 日本語版 |

Nothing here needs the M88M tree checked in — `build.sh` fetches and patches it.

### Both sides must be the same machine (a hole found on 2026-08-13)

A `.d88` may hold several images. **202 of our 353 files do**, and the Node side
(`tools/batch-compare.mjs`) has always put image 1 into drive 1. `refdrv.cpp` only called
`Mount(0, …)`, so on most of the collection **the two emulators were running different
machines**.

Titles that want a USER disk or a disk B (Hydlide3, Stercru, starclsr, PRO_FAN) found
drive 1 empty on the M88 side, fell back to the N88-BASIC prompt, and spent five days
recorded as **"titles M88 cannot boot"**. Mounting drive 1 boots all four (exact 328→332,
tracking 333→341, divergence list 18→11).

**When touching refdrv, check that it inserts the same disks, in the same order, as the
Node harness.**

## Build

```sh
./build.sh                 # → _m88m_build/M88M/refdrv
```
Requires `git`, `g++` (C++17), `ar`, and zlib headers (`-lz`). Verified
reproducible from a clean clone (41 core objects). The core is built
`-DM88_PORTABLE -DM88_NO_Z80_X86 -fpermissive -Wno-narrowing`; the raylib/GUI
front-end is skipped, screen output is a null stub. Pinned to M88M commit
`6fc74b5` — the patch is against that tree.

## Run

```sh
refdrv <romDir> <disk.d88> [frames] [win0 win1]
```
- `romDir` — a directory of M88 ROMs. The M88 loaders open ROMs by **cwd-relative
  names**, some case-sensitive (`N88.ROM`/`n88.rom`, `DISK.ROM`, `N88_0.ROM`..
  `N88_3.ROM`, `kanji1.rom`, `kanji2.rom`, `N80.ROM`, `FONT.ROM`, `pc88.rom` =
  combined, sub-ROM at offset 0x14000). `refdrv` `chdir()`s into `romDir`; provide
  both upper- and lowercase spellings your ROM set expects. A stock `m88204` set
  works as-is.
- `frames` — 60 Hz frames to run (default 600). ~250 reaches a menu.

### Instrumentation via environment (the workhorse for cross-emulator diffs)

| variable | meaning |
|----------|---------|
| `M88_TRACE=<path>` | dump the MAIN CPU instruction trace (one PC per line, consecutive dups collapsed) |
| `M88_TRACE_ARMPC=<hex>` | start tracing at the **first execution of this PC** (preferred) |
| `M88_TRACE_FROM=<frame>` | start tracing at a frame (default 0) |
| `M88_TRACE_ARMFDC=<n>` | start after the n'th FDC result (the old 軽井沢-specific arming) |
| `M88_TRACE_MAX=<n>` | instruction budget (default 200000) |
| `M88_WATCH=<lo>-<hi>` | print every MAIN-CPU store into that address range (`WR f… pc=… [addr]=val`) |
| `M88_WATCH_MAX=<n>` | cap the printed lines (default 400) |

**Use `M88_TRACE_ARMPC`.** Our emulator boots ~20 frames ahead of M88, so frame
numbers do not name the same program point; "the first time the program reaches
address X" does, however the timing drifted.

Our side has the matching `tools/pc-trace.mjs` (same format, same arming) and
`tools/watch-write.mjs`. Diff with `tools/trace-diff.mjs`.

```sh
# trace both from the same program point, then truncate the longer one
M88_TRACE=/tmp/m88.txt M88_TRACE_ARMPC=fc11 M88_TRACE_MAX=6000000 \
  refdrv <romDir> <disk.d88> 300
node tools/pc-trace.mjs <disk.d88> /tmp/ours.txt 150 --armpc fc11 --max 3000000
head -n $(wc -l < /tmp/ours.txt) /tmp/m88.txt > /tmp/m88cut.txt
node tools/trace-diff.mjs /tmp/ours.txt /tmp/m88cut.txt
```
**Do truncate the longer trace** — otherwise "PCs only one side executes" just
means "that side ran longer". M88 needs ~20 extra frames to reach the same point.

Example (the reference run this repo diffs against):
```sh
refdrv /path/to/m88roms /path/to/karuizawa.d88 250
```

### Config baked into refdrv (what boots 軽井沢)
`basicmode=N88V2`, `clock=40` (4 MHz), `dipsw=1829`,
`flags = enableopna | subcpucontrol | enablewait | precisemixing | mixsoundalways`.
Change these in `refdrv.cpp`'s `Config` block if a title needs a different machine.

## What refdrv reports (the hooks)

The patch inserts function-pointer hooks; `refdrv.cpp` wires them up:

- **FDC command / result / read** — every `READ DATA` id (`C H R N EOT`) and every
  7-byte result phase (`ST0 ST1 ST2 C H R N`). This pinned the µPD765 result-ID /
  end-of-cylinder behaviour (`R←R+1`, wrap to `C+1/R=1` at EOT).
- **Main-CPU PC trace** — armed at a chosen event (e.g. the 6th FDC result),
  bounded, deduped, written to a file for set/prefix diffing against ours.
- **`E6CD` / `EC88` writes** — the game's keyboard-scan gate and a load pointer,
  logged on transition with the writing PC (revealed E6CD=ff is a *symptom* of an
  incomplete load, cleared by `pc=0x1b92` only when the load finishes).
- **Sub-CPU RAM dump** — `GetMem2()->GetRAM()` (sub addr `A` → `ram[A-0x4000]`):
  directory entries, the FAT table, `FAT[cluster]`. This proved the FAT walk is
  byte-identical to ours.
- **Main-received byte stream / sub FDC data count** — for byte-exact transfer
  diffs.

Edit `refdrv.cpp` to arm/aim a hook at the phase you're investigating, rebuild
(re-links in seconds once the core lib exists), re-run.

## The method — cross-emulator differential debugging

The oracle is only half of it. The other half is instrumenting **our** emulator
at the *same* semantic points and diffing. The loop:

1. **Reproduce headless on both.** Same `.d88`, same frame count, deterministic
   PRNG. Ours is pure-JS; drive it from a tiny Node harness: `new
   Pc8801Machine({main,ext,sub,...})` → `insertDisk(0, parseD88All(...)[0])` →
   `stepFrame()` in a loop, then hook `cpu.step`, `sub.cpu.bus.write`,
   `fdc._results`, or `globalThis.__fdcCmd`.
2. **Diff coarse → fine.** Start where behaviour visibly differs (E6CD, tvram,
   read count). Then bisect: FDC result IDs → main PC trace (longest common
   prefix) → sub-CPU RAM regions → the single byte / port read / result field
   that first differs.
3. **Follow the divergent value to its source.** A wrong byte in a buffer → which
   FDC read stored it → compare that read's bytes to the raw `.d88` sectors. If
   ours matches the disk *and* M88, the input is innocent; move up a layer.
4. **Exonerate, don't just accuse.** Most of the work is *clearing* suspects
   (protection, ROM version, sub firmware, handshake, timing) by proving M88
   produces identical state. What survives every clearance is the bug.

### Agent prompt (paste to a sub-agent)

> You are debugging why the pure-JS PC-8801 emulator at `upd3301/` fails to boot
> `<TITLE>.d88` while M88 boots it. Use `upd3301/m88ref/` as a cycle-accurate
> reference oracle. Build it with `m88ref/build.sh` if `_m88m_build/M88M/refdrv`
> is absent. Run **both** emulators headless on the same disk and same frame
> count. Localize the divergence by bisecting coarse→fine: compare FDC command
> and result sequences, then main-CPU PC traces (longest common prefix), then
> sub-CPU RAM regions (`refdrv` dumps them via `GetMem2()->GetRAM()`), down to
> the first differing byte / port read / result field. For any suspect byte,
> trace it to the FDC read that produced it and compare against the raw `.d88`
> sectors — if ours matches both the disk and M88, that layer is innocent; move
> up. Add/aim hooks in `refdrv.cpp` (rebuild is seconds) and instrument our
> emulator at the *same* semantic point via a Node harness (`new Pc8801Machine`
> → `insertDisk` → `stepFrame`, hooking `cpu.step`, `sub.cpu.bus.write`,
> `fdc._results`, `globalThis.__fdcCmd`). Report the single localized divergence,
> and which subsystems you *cleared* by proving M88 produces identical state.
> Keep a running "battle record" of suspects cleared and evidence.

## Porting to a newer M88M

The patch is pinned to commit `6fc74b5`. If it stops applying, re-create it from
`PATCHES.md` (anchors + payloads) and re-pin `M88M_COMMIT` in `build.sh`. The
hooks are tiny function-pointer calls at: `Z80C::SingleStep`, `Z80C::Write8`,
`FDC::ReadData`, `FDC::GetData`, `FDC::ShiftToResultPhase7`,
`SubSystem::M_Read0`.
