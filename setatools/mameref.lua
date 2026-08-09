-- setatools/mameref.lua — the oracle side of the comparison.
--
-- Run under MAME with -autoboot_script. At the frame numbers named in
-- SETAREF_FRAMES it writes the board's mutable state, and optionally the
-- screen's pixels, to the file named in SETAREF_OUT. setatools/mameref.mjs then
-- runs this machine to the same frames and diffs — region by region for state,
-- pixel by pixel for the picture. A disagreement lands on a chip instead of on
-- "the picture is wrong".
--
--   MAME 0.242 notes, both of which cost time to find:
--     * emu.add_machine_frame_notifier does not exist yet. The frame hook is
--       emu.register_frame_done.
--     * MAME segfaults on exit, after printing its speed line. The exit code is
--       useless as a success test — check the output file is complete instead.
--
-- Environment:
--   SETAREF_OUT     output path                         (default /tmp/setaref.txt)
--   SETAREF_FRAMES  comma-separated frame numbers       (default 60)
--   SETAREF_MODE    "state" | "pixels"                  (default state)
--   SETAREF_MAP     comma-separated base:len hex pairs, overriding the regions
--                   for a board whose map is not thunderl's
--
-- Usage (state):
--   SETAREF_OUT=/tmp/ref.txt SETAREF_FRAMES=10,60,300 \
--     mame thunderl -rompath <dir> -video none -sound none -nothrottle \
--       -skip_gameinfo -seconds_to_run 8 -autoboot_delay 0 \
--       -autoboot_script setatools/mameref.lua
--
-- Usage (pixels): the same with SETAREF_MODE=pixels. The picture is written as
-- raw ARGB32 after a one-line header, so nothing needs a PNG decoder.

local out_path = os.getenv("SETAREF_OUT") or "/tmp/setaref.txt"
local frames_env = os.getenv("SETAREF_FRAMES") or "60"
local mode = os.getenv("SETAREF_MODE") or "state"
local map_env = os.getenv("SETAREF_MAP")

local want = {}
for f in string.gmatch(frames_env, "[^,]+") do want[tonumber(f)] = true end

local mac = manager.machine
local cpu = mac.devices[":maincpu"]
local prog = cpu.spaces["program"]
local scr = mac.screens[":screen"]

-- thunderl's map. Anything else can be given in SETAREF_MAP.
local regions = {
  { "ram",     0xffc000, 0x4000 },
  { "pal",     0x700000, 0x0400 },
  { "spry",    0xd00000, 0x0600 },
  { "sprctrl", 0xd00600, 0x0008 },
  { "sprc",    0xe00000, 0x4000 },
}
if map_env then
  regions = {}
  local n = 0
  for pair in string.gmatch(map_env, "[^,]+") do
    local name, base, len = string.match(pair, "([^:]+):([^:]+):([^:]+)")
    n = n + 1
    regions[n] = { name, tonumber(base, 16), tonumber(len, 16) }
  end
end

local fh = io.open(out_path, mode == "pixels" and "wb" or "w")
local n = 0

if mode == "pixels" then
  fh:write(string.format("frames %s %d %d\n", frames_env, scr.width, scr.height))
end

-- Read through the CPU's own address space, so what is compared is what the CPU
-- would see rather than MAME's internal allocation: a mistake in the address
-- decoder then shows up as a difference instead of hiding behind it.
local function hexdump(base, len)
  local t = {}
  for i = 0, len - 1 do t[#t + 1] = string.format("%02x", prog:read_u8(base + i)) end
  return table.concat(t)
end

local function dump_state(frame)
  fh:write(string.format("frame %d\n", frame))
  fh:write(string.format("pc %x sr %x\n", cpu.state["PC"].value, cpu.state["SR"].value))
  for i = 0, 7 do fh:write(string.format("d%d %x\n", i, cpu.state["D" .. i].value)) end
  for i = 0, 7 do fh:write(string.format("a%d %x\n", i, cpu.state["A" .. i].value)) end
  for _, r in ipairs(regions) do
    fh:write(r[1] .. " " .. hexdump(r[2], r[3]) .. "\n")
  end
  fh:flush()
end

emu.register_frame_done(function()
  n = n + 1
  if not want[n] then return end
  if mode == "pixels" then fh:write(scr:pixels()) else dump_state(n) end
  fh:flush()
end)
