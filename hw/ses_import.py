#!/usr/bin/env python3.10
"""Parse the Specctra .ses routes and inject tracks/vias into the board.

KiCad 6 standalone python can't ImportSpecctraSES (app-context only), but a
session file is just s-expressions: resolution um 10 → 1 unit = 0.1 um =
100 nm; DSN Y axis is inverted vs KiCad.
"""
import pcbnew, re, os, zipfile

def tokenize(text):
    return re.findall(r'\(|\)|"[^"]*"|[^\s()"]+', text)

def parse(tokens):
    it = iter(tokens)
    def walk():
        out = []
        for t in it:
            if t == '(':
                out.append(walk())
            elif t == ')':
                return out
            else:
                out.append(t.strip('"'))
        return out
    root = walk()
    return root

text = open('vstream.ses').read()
tree = parse(tokenize(text))

def find(node, name):
    return [n for n in node if isinstance(n, list) and n and n[0] == name]

session = tree[0] if isinstance(tree[0], list) else tree
routes = find(session, 'routes')[0]
nets = find(find(routes, 'network_out')[0], 'net')

U = 100  # (resolution um 10): 1 unit = 0.1um = 100 nm
LAYER = {'F.Cu': pcbnew.F_Cu, 'B.Cu': pcbnew.B_Cu}

board = pcbnew.LoadBoard('vstream.kicad_pcb')
netmap = {board.GetNetInfo().GetNetItem(i).GetNetname(): board.GetNetInfo().GetNetItem(i)
          for i in range(board.GetNetCount())}

ntracks = nvias = 0
for net in nets:
    netname = net[1]
    ni = netmap.get(netname)
    for wire in find(net, 'wire'):
        for path in find(wire, 'path'):
            layer = LAYER[path[1]]
            width = int(float(path[2])) * U
            coords = [float(v) for v in path[3:] if not isinstance(v, list)]
            pts = [(int(coords[i] * U), int(-coords[i + 1] * U)) for i in range(0, len(coords), 2)]
            for a, b in zip(pts, pts[1:]):
                t = pcbnew.PCB_TRACK(board)
                t.SetStart(pcbnew.wxPoint(*a))
                t.SetEnd(pcbnew.wxPoint(*b))
                t.SetLayer(layer)
                t.SetWidth(width)
                if ni: t.SetNet(ni)
                board.Add(t)
                ntracks += 1
    for via in find(net, 'via'):
        # (via "Via[0-1]_700:350_um" x y)
        m = re.match(r'Via\[.*\]_(\d+):(\d+)_um', via[1])
        dia, drill = (int(m.group(1)) * 1000, int(m.group(2)) * 1000) if m else (700000, 350000)
        x, y = float(via[2]), float(via[3])
        v = pcbnew.PCB_VIA(board)
        v.SetPosition(pcbnew.wxPoint(int(x * U), int(-y * U)))
        v.SetWidth(dia)
        v.SetDrill(drill)
        v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
        if ni: v.SetNet(ni)
        board.Add(v)
        nvias += 1

print(f'injected {ntracks} track segments, {nvias} vias')
pcbnew.SaveBoard('vstream-routed.kicad_pcb', board)

# plot final gerbers + drill, zip
out = 'gerber'
os.makedirs(out, exist_ok=True)
for f in os.listdir(out): os.remove(os.path.join(out, f))
pc = pcbnew.PLOT_CONTROLLER(board)
po = pc.GetPlotOptions()
po.SetOutputDirectory(out)
po.SetPlotFrameRef(False)
po.SetUseGerberProtelExtensions(True)
po.SetSubtractMaskFromSilk(True)
for name, layer in [('F_Cu', pcbnew.F_Cu), ('B_Cu', pcbnew.B_Cu),
                    ('F_SilkS', pcbnew.F_SilkS), ('B_SilkS', pcbnew.B_SilkS),
                    ('F_Mask', pcbnew.F_Mask), ('B_Mask', pcbnew.B_Mask),
                    ('Edge_Cuts', pcbnew.Edge_Cuts)]:
    pc.SetLayer(layer)
    pc.OpenPlotfile(name, pcbnew.PLOT_FORMAT_GERBER, name)
    pc.PlotLayer()
pc.ClosePlot()
ew = pcbnew.EXCELLON_WRITER(board)
ew.SetFormat(True)
ew.CreateDrillandMapFilesSet(out, True, False)
with zipfile.ZipFile('vstream-gerber.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for f in sorted(os.listdir(out)):
        z.write(os.path.join(out, f), f)
print('gerber zip:', os.path.getsize('vstream-gerber.zip'), 'bytes')
