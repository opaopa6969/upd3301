#!/bin/sh
# Fetch the SingleStepTests/8086 vectors used by pc98tools/run-sst.mjs.
#
# 256 gzipped JSON files, one per opcode, 2,000 tests each = 512,000 tests,
# about 130 MB. They are deliberately NOT committed: this repository keeps no
# binaries, and the vectors are regenerated upstream from time to time.
# Re-running is idempotent — curl -O skips nothing, but the files are stable.
#
#   pc98tools/fetch-tests.sh [dir]        (default: ./i8086-tests)
#   node pc98tools/run-sst.mjs --dir <dir>
#
# The vectors were captured from a real Intel P80C86A-2 with dbalsom's
# ArduinoX86 rig, which makes them an oracle rather than another emulator's
# opinion. See docs/pc98-design.md §9.
set -eu

DIR="${1:-./i8086-tests}"
REPO="SingleStepTests/8086"
JOBS="${JOBS:-8}"

mkdir -p "$DIR"

echo "listing $REPO/v1 ..."
LIST="$DIR/.filelist"
curl -sSL --max-time 120 \
  "https://api.github.com/repos/$REPO/contents/v1?per_page=300" \
  | grep -o '"download_url": *"[^"]*"' \
  | sed 's/.*"download_url": *"//; s/"$//' > "$LIST"

COUNT=$(wc -l < "$LIST" | tr -d ' ')
if [ "$COUNT" -lt 200 ]; then
  echo "expected 256 files, got $COUNT — is the GitHub API rate-limiting you?" >&2
  exit 1
fi

echo "downloading $COUNT files into $DIR (about 130 MB) ..."
( cd "$DIR" && xargs -a .filelist -P "$JOBS" -n 1 curl -sSL --max-time 300 -O )
rm -f "$LIST"

echo "done. now run:"
echo "  node pc98tools/run-sst.mjs --dir $DIR"
