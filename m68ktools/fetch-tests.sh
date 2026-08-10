#!/bin/sh
# Fetch the SingleStepTests/m68000 vectors used by m68ktools/run-sst.mjs.
#
# ~138 MB across 127 files, one per instruction form. They are deliberately NOT
# committed: this repository keeps no binaries, and the vectors are regenerated
# upstream from time to time. Re-running this is idempotent — curl skips files
# that are already the right size.
#
#   m68ktools/fetch-tests.sh [dir]      (default: ./m68k-tests)
#   node m68ktools/run-sst.mjs --dir <dir>
#
# The vectors were generated from MAME's microcoded 68000, which is the closest
# thing to a public oracle for this chip. See docs/m68000-design.md.
set -eu

DIR="${1:-./m68k-tests}"
REPO="SingleStepTests/m68000"
BRANCH="main"
JOBS="${JOBS:-8}"

mkdir -p "$DIR"

echo "listing $REPO/v1 ..."
LIST="$DIR/.filelist"
curl -sSL --max-time 60 \
  "https://api.github.com/repos/$REPO/contents/v1?per_page=200" \
  | grep -o '"download_url": *"[^"]*"' \
  | sed 's/.*"download_url": *"//; s/"$//' > "$LIST"

COUNT=$(wc -l < "$LIST" | tr -d ' ')
if [ "$COUNT" -lt 100 ]; then
  echo "expected ~127 files, got $COUNT — is the GitHub API rate-limiting you?" >&2
  exit 1
fi

echo "downloading $COUNT files into $DIR (about 138 MB) ..."
( cd "$DIR" && xargs -a .filelist -P "$JOBS" -n 1 curl -sSL --max-time 300 -O )
rm -f "$LIST"

echo "done. now run:"
echo "  node m68ktools/run-sst.mjs --dir $DIR"
