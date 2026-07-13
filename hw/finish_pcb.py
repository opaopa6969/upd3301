#!/usr/bin/env python3.10
"""Import the routed SES, save the final board, plot Gerbers + drill."""
import pcbnew, os, zipfile

# KiCad 6: ImportSpecctraSES(filename) works on the internally loaded board
board = pcbnew.LoadBoard('vstream.kicad_pcb')
import shutil
shutil.copy('vstream.kicad_pcb', 'vstream-routed.kicad_pcb')
board = pcbnew.LoadBoard('vstream-routed.kicad_pcb')
ok = pcbnew.ImportSpecctraSES('vstream.ses')
print('SES import:', ok)
board = pcbnew.GetBoard() or board
print('tracks:', len(board.GetTracks()))
pcbnew.SaveBoard('vstream-routed.kicad_pcb', board)

out = 'gerber'
os.makedirs(out, exist_ok=True)
pc = pcbnew.PLOT_CONTROLLER(board)
po = pc.GetPlotOptions()
po.SetOutputDirectory(out)
po.SetPlotFrameRef(False)
po.SetUseGerberProtelExtensions(True)
po.SetCreateGerberJobFile(False)
po.SetSubtractMaskFromSilk(True)
LAYERS = [
    ('F_Cu', pcbnew.F_Cu), ('B_Cu', pcbnew.B_Cu),
    ('F_SilkS', pcbnew.F_SilkS), ('B_SilkS', pcbnew.B_SilkS),
    ('F_Mask', pcbnew.F_Mask), ('B_Mask', pcbnew.B_Mask),
    ('Edge_Cuts', pcbnew.Edge_Cuts),
]
for name, layer in LAYERS:
    pc.SetLayer(layer)
    pc.OpenPlotfile(name, pcbnew.PLOT_FORMAT_GERBER, name)
    pc.PlotLayer()
pc.ClosePlot()

# drill
ew = pcbnew.EXCELLON_WRITER(board)
ew.SetFormat(True)
ew.CreateDrillandMapFilesSet(out, True, False)

files = sorted(os.listdir(out))
with zipfile.ZipFile('vstream-gerber.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.write(os.path.join(out, f), f)
print('gerber files:', files)
print('zip:', os.path.getsize('vstream-gerber.zip'), 'bytes')
