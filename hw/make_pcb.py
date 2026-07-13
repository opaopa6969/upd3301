#!/usr/bin/env python3.10
"""vstream.net (skidl circuit) -> placed vstream.kicad_pcb (KiCad 6 API).

Loads footprints, assigns nets to pads, places parts at hand-picked
coordinates, draws the board outline, saves the .kicad_pcb, and exports a
Specctra DSN for autorouting.
"""
import sys, os
sys.path.insert(0, '.')
import pcbnew

# run the circuit definition (regenerates netlist as a side effect, fine)
import vstream_netlist  # noqa
import skidl
default_circuit = skidl.builtins.default_circuit if hasattr(skidl, "builtins") else __import__("builtins").default_circuit

FP_DIRS = ['/usr/share/kicad/footprints', './']

def load_fp(spec):
    lib, name = spec.split(':')
    for d in FP_DIRS:
        path = os.path.join(d, lib + '.pretty')
        if os.path.isdir(path):
            fp = pcbnew.FootprintLoad(path, name)
            if fp:
                return fp
    raise SystemExit(f'footprint not found: {spec}')

board = pcbnew.BOARD()

# nets
netmap = {}
for net in default_circuit.nets:
    if not net.name or net.name == 'NC':
        continue
    ni = pcbnew.NETINFO_ITEM(board, net.name)
    board.Add(ni)
    netmap[net.name] = ni

# placement (mm): J1 edge socket left, logic column, Pico right, SD far right
POS = {
    'J1': (18, 15, 0), 'U4': (42, 22, 0), 'U5': (42, 42, 0),
    'U2': (58, 22, 0), 'U3': (58, 42, 0),
    'U1': (80, 12, 0), 'J2': (102, 25, 0),
    'Q1': (42, 58, 0), 'R1': (50, 58, 0), 'R2': (58, 58, 0),
    'C1': (52, 32, 0), 'C2': (66, 32, 0), 'C3': (36, 32, 0), 'C4': (36, 52, 0),
    'C5': (26, 60, 0),
}

for part in default_circuit.parts:
    fp = load_fp(part.footprint)
    fp.SetReference(part.ref)
    fp.SetValue(part.name)
    x, y, rot = POS.get(part.ref, (30, 70, 0))
    fp.SetPosition(pcbnew.wxPointMM(float(x), float(y)))
    fp.SetOrientationDegrees(rot)
    board.Add(fp)
    # net assignment by pad number
    for pin in part.pins:
        if not pin.net or pin.net.name not in netmap:
            continue
        for pad in fp.Pads():
            if pad.GetNumber() == str(pin.num):
                pad.SetNet(netmap[pin.net.name])
board.BuildListOfNets()

# board outline: 115 x 75 mm
def edge(x1, y1, x2, y2):
    seg = pcbnew.PCB_SHAPE(board)
    seg.SetShape(pcbnew.SHAPE_T_SEGMENT)
    seg.SetStart(pcbnew.wxPointMM(float(x1), float(y1)))
    seg.SetEnd(pcbnew.wxPointMM(float(x2), float(y2)))
    seg.SetLayer(pcbnew.Edge_Cuts)
    seg.SetWidth(pcbnew.FromMM(0.1))
    board.Add(seg)
W, H = 115, 75
edge(5, 3, 5 + W, 3); edge(5 + W, 3, 5 + W, 3 + H)
edge(5 + W, 3 + H, 5, 3 + H); edge(5, 3 + H, 5, 3)

# design rules: hobby-friendly 0.2mm/0.2mm
# defaults are fine for a 2-layer hobby board (0.25/0.2 set at fab order)

pcbnew.SaveBoard('vstream.kicad_pcb', board)
print('saved vstream.kicad_pcb:',
      len(board.GetFootprints()), 'footprints,',
      board.GetNetCount(), 'nets')

ok = pcbnew.ExportSpecctraDSN(board, 'vstream.dsn')
print('DSN export:', ok)
