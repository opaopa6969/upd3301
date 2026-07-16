#!/usr/bin/env bash
# Build a headless, cycle-accurate M88 (PC-8801) reference tracer.
# Clones M88M, applies the trace hooks, builds the emulation core as a static
# lib, and links refdrv.cpp against it. Reproducible: pinned to one M88M commit.
#
# Usage:   ./build.sh [BUILD_DIR]
#   BUILD_DIR defaults to ./_m88m_build (holds the M88M checkout + objects).
# Output:  $BUILD_DIR/refdrv   (the headless reference tracer)
#
# Requires: git, g++ (C++17), ar, zlib dev headers (-lz).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${1:-$HERE/_m88m_build}"
M88M_URL="https://github.com/bubio/M88M"
M88M_COMMIT="6fc74b5"          # pinned — the hooks patch is against this tree
FLAGS="-std=c++17 -fpermissive -Wno-narrowing -DNDEBUG -DM88_NO_Z80_X86 -DM88_PORTABLE"
INC="-Isrc -Isrc/pc88 -Isrc/devices -Isrc/common"
# debug/x86-asm/GUI-view TUs are excluded from the headless core:
EXCLUDE="Z80Debug Z80Test Z80_x86 ioview memview"

mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

if [ ! -d M88M/.git ]; then
  git clone "$M88M_URL" M88M
fi
cd M88M
git checkout -q "$M88M_COMMIT"
git checkout -q -- src 2>/dev/null || true   # drop any prior partial apply
echo "== applying trace hooks =="
git apply --check "$HERE/m88m-hooks.patch" 2>/dev/null && git apply "$HERE/m88m-hooks.patch" \
  || echo "   (hooks already applied — skipping)"

echo "== compiling emulation core =="
OBJS=()
for d in src/common src/devices src/pc88; do
  for f in "$d"/*.cpp; do
    base="$(basename "$f" .cpp)"
    case " $EXCLUDE " in *" $base "*) continue;; esac
    o="obj_$base.o"
    g++ $FLAGS $INC -c "$f" -o "$o"
    OBJS+=("$o")
  done
done
ar rcs libm88core.a "${OBJS[@]}"
echo "   -> libm88core.a ($(ar t libm88core.a | wc -l) objects)"

echo "== linking refdrv =="
g++ $FLAGS $INC "$HERE/refdrv.cpp" libm88core.a -lz -o refdrv
echo ""
echo "DONE.  Reference tracer: $BUILD_DIR/M88M/refdrv"
echo "Run:   $BUILD_DIR/M88M/refdrv <romDir> <disk.d88> [frames]"
echo "  romDir must contain M88 ROMs (N88.ROM, DISK.ROM, N88_0..3.ROM, kanji1.rom …),"
echo "  both UPPER and lowercase names as your ROM set provides."
