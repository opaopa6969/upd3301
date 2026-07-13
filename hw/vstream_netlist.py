#!/usr/bin/env python3.10
"""PC-8001 VSTREAM adapter — skidl netlist generator.

Feeds video frame streams (.p8v) from a microSD card into a real PC-8001:
the Z80 reads I/O port 70h with INIR while the board flow-controls via
/WAIT. Level shifting 5V bus <-> 3.3V RP2040 via 74LVC245 (5V-tolerant
inputs, 3.3V outputs meet TTL VIH).

Run: python3.10 vstream_netlist.py  -> vstream.net (KiCad netlist) + bom.csv
Then: import into KiCad (or kinet2pcb) -> place/route -> Gerber.
ERC-checked netlist; NOT silicon-verified. J1 pinout must be confirmed
against the PC-8001 service manual before layout.
"""
from skidl import Part, Pin, Net, ERC, generate_netlist
import csv

def part(ref, name, footprint, pins):
    p = Part(name=name, tool='skidl', footprint=footprint)
    p.ref = ref
    for num, pname, ptype in pins:
        p += Pin(num=str(num), name=pname, func=ptype)
    return p

I, O, B, PWR, OD = Pin.types.INPUT, Pin.types.OUTPUT, Pin.types.BIDIR, Pin.types.PWRIN, Pin.types.OPENCOLL

# ---- nets ----------------------------------------------------------------
P5V, P3V3, GND = Net('+5V'), Net('+3V3'), Net('GND')
D = [Net(f'D{i}') for i in range(8)]          # Z80 data bus (5V)
A = [Net(f'A{i}') for i in range(8)]          # Z80 address (5V)
nIORQ, nRD, nM1, nRESET, nWAIT = Net('~IORQ'), Net('~RD'), Net('~M1'), Net('~RESET'), Net('~WAIT')
nSEL = Net('~SEL')          # 74HC688 address match (A1-A7 = 0111000, /M1 high)
OR1, OR2 = Net('OR1'), Net('OR2')
nOE = Net('~OE_READ')       # low only during IN A,(70h)
PD = [Net(f'PD{i}') for i in range(8)]        # Pico-side data (3.3V)
OE33, RST33 = Net('OE33'), Net('RST33')       # shifted control senses
WAIT_G = Net('WAIT_GATE')
SD_MISO, SD_CS, SD_SCK, SD_MOSI = Net('SD_MISO'), Net('SD_CS'), Net('SD_SCK'), Net('SD_MOSI')

# ---- J1: PC-8001 expansion bus ------------------------------------------
# PIN NUMBERS ARE PLACEHOLDERS: verify against the PC-8001 service manual.
j1 = part('J1', 'PC8001_EXPANSION', 'Connector_PinSocket_2.54mm:PinSocket_2x25_P2.54mm_Vertical',
    [(1, '+5V', PWR), (2, 'GND', PWR), (50, 'GND2', PWR)]
    + [(3 + i, f'D{i}', B) for i in range(8)]
    + [(11 + i, f'A{i}', I) for i in range(8)]
    + [(19, '~IORQ', I), (20, '~RD', I), (21, '~M1', I), (22, '~RESET', I), (23, '~WAIT', OD)])
j1['+5V'] += P5V; j1['GND'] += GND; j1['GND2'] += GND
for i in range(8): j1[f'D{i}'] += D[i]
for i in range(8): j1[f'A{i}'] += A[i]
j1['~IORQ'] += nIORQ; j1['~RD'] += nRD; j1['~M1'] += nM1
j1['~RESET'] += nRESET; j1['~WAIT'] += nWAIT

# ---- U1: Raspberry Pi Pico (module) --------------------------------------
u1 = part('U1', 'RPi_Pico', 'vstream:RPi_Pico_TH',
    [(39, 'VSYS', PWR), (36, '3V3_OUT', PWR), (38, 'GND', PWR), (3, 'GND2', PWR)]
    + [(i + 1 if i < 3 else i + 2, f'GP{i}', B) for i in range(8)]  # GP0-7 (pins 1,2,4,5,6,7,9,10)
    + [(11, 'GP8', I), (12, 'GP9', O), (14, 'GP10', I),
       (21, 'GP16', I), (22, 'GP17', O), (24, 'GP18', O), (25, 'GP19', O)])
u1['VSYS'] += P5V; u1['3V3_OUT'] += P3V3; u1['GND'] += GND; u1['GND2'] += GND
for i in range(8): u1[f'GP{i}'] += PD[i]
u1['GP8'] += OE33      # sense: IN cycle in progress
u1['GP9'] += WAIT_G    # drive: FET gate for /WAIT
u1['GP10'] += RST33    # sense: bus reset
u1['GP16'] += SD_MISO; u1['GP17'] += SD_CS; u1['GP18'] += SD_SCK; u1['GP19'] += SD_MOSI

# ---- U2: 74LVC245 data driver (Pico -> bus, output-only port) -------------
u2 = part('U2', '74LVC245A', 'Package_SO:TSSOP-20_4.4x6.5mm_P0.65mm',
    [(1, 'DIR', I), (19, '~OE', I), (20, 'VCC', PWR), (10, 'GND', PWR)]
    + [(2 + i, f'A{i}', B) for i in range(8)]
    + [(18 - i, f'B{i}', B) for i in range(8)])
u2['VCC'] += P3V3; u2['GND'] += GND
u2['DIR'] += P3V3            # fixed A->B: the stream port is read-only
u2['~OE'] += nOE             # enabled only during IN A,(70h)
for i in range(8):
    u2[f'A{i}'] += PD[i]
    u2[f'B{i}'] += D[i]

# ---- U3: 74LVC245 control-signal level shift (5V bus -> 3.3V Pico) --------
u3 = part('U3', '74LVC245A', 'Package_SO:TSSOP-20_4.4x6.5mm_P0.65mm',
    [(1, 'DIR', I), (19, '~OE', I), (20, 'VCC', PWR), (10, 'GND', PWR),
     (2, 'A0', B), (3, 'A1', B), (18, 'B0', B), (17, 'B1', B)])
u3['VCC'] += P3V3; u3['GND'] += GND
u3['DIR'] += P3V3            # B->A? fixed one direction toward Pico: wire bus on B side
u3['~OE'] += GND             # always enabled
u3['B0'] += nOE; u3['A0'] += OE33
u3['B1'] += nRESET; u3['A1'] += RST33

# ---- U4: 74HC688 address comparator (A1-A7 + /M1 == 0111000,1) ------------
u4 = part('U4', '74HC688', 'Package_SO:SOIC-20W_7.5x12.8mm_P1.27mm',
    [(20, 'VCC', PWR), (10, 'GND', PWR), (1, '~G', I), (19, '~P=Q', O)]
    + [(2 + 2 * i, f'P{i}', I) for i in range(8)]
    + [(3 + 2 * i, f'Q{i}', I) for i in range(8)])
u4['VCC'] += P5V; u4['GND'] += GND
u4['~G'] += GND
u4['~P=Q'] += nSEL
# P side: A1..A7 + /M1 ; Q side hardwired to port base 70h>>1 = 0111000, M1=1
for i in range(7): u4[f'P{i}'] += A[i + 1]
u4['P7'] += nM1
QVAL = [0, 0, 0, 1, 1, 1, 0, 1]  # A1,A2,A3=0 A4,A5,A6=1 A7=0 ; M1=1
for i, v in enumerate(QVAL): u4[f'Q{i}'] += (P5V if v else GND)

# ---- U5: 74HC32 qualification: /OE = /SEL | /IORQ | /RD | A0 --------------
u5 = part('U5', '74HC32', 'Package_SO:SOIC-14_3.9x8.7mm_P1.27mm',
    [(14, 'VCC', PWR), (7, 'GND', PWR),
     (1, '1A', I), (2, '1B', I), (3, '1Y', O),
     (4, '2A', I), (5, '2B', I), (6, '2Y', O),
     (9, '3A', I), (10, '3B', I), (8, '3Y', O)])
u5['VCC'] += P5V; u5['GND'] += GND
u5['1A'] += nSEL; u5['1B'] += nIORQ; u5['1Y'] += OR1
u5['2A'] += OR1;  u5['2B'] += nRD;   u5['2Y'] += OR2
u5['3A'] += OR2;  u5['3B'] += A[0];  u5['3Y'] += nOE

# ---- Q1: /WAIT open-drain driver ------------------------------------------
q1 = part('Q1', '2N7002', 'Package_TO_SOT_SMD:SOT-23',
    [(1, 'G', I), (2, 'S', PWR), (3, 'D', OD)])
q1['G'] += WAIT_G; q1['S'] += GND; q1['D'] += nWAIT
r1 = part('R1', 'R_4k7', 'Resistor_SMD:R_0805_2012Metric', [(1, 'A', PWR), (2, 'B', PWR)])
r1['A'] += nWAIT; r1['B'] += P5V
r2 = part('R2', 'R_10k', 'Resistor_SMD:R_0805_2012Metric', [(1, 'A', PWR), (2, 'B', PWR)])
r2['A'] += WAIT_G; r2['B'] += GND  # FET off (WAIT released) until Pico boots

# ---- J2: microSD (SPI) -----------------------------------------------------
j2 = part('J2', 'microSD_SPI', 'Connector_Card:microSD_HC_Hirose_DM3AT-SF-PEJM5',
    [(1, 'CS', I), (2, 'MOSI', I), (3, 'GND', PWR), (4, 'VDD', PWR),
     (5, 'SCK', I), (6, 'GND2', PWR), (7, 'MISO', O)])
j2['VDD'] += P3V3; j2['GND'] += GND; j2['GND2'] += GND
j2['CS'] += SD_CS; j2['MOSI'] += SD_MOSI; j2['SCK'] += SD_SCK; j2['MISO'] += SD_MISO

# ---- decoupling -------------------------------------------------------------
for i, (net, ref) in enumerate([(P3V3, 'C1'), (P3V3, 'C2'), (P5V, 'C3'), (P5V, 'C4')]):
    c = part(ref, 'C_100n', 'Capacitor_SMD:C_0603_1608Metric', [(1, 'P', PWR), (2, 'N', PWR)])
    c['P'] += net; c['N'] += GND
c5 = part('C5', 'C_10u', 'Capacitor_SMD:C_0805_2012Metric', [(1, 'P', PWR), (2, 'N', PWR)])
c5['P'] += P5V; c5['N'] += GND

ERC()
generate_netlist(file_='vstream.net')

with open('bom.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['Ref', 'Part', 'Package', 'Qty', 'Note'])
    rows = [
        ('U1', 'Raspberry Pi Pico', 'module (2x20 header)', 1, 'RP2040: PIO bus IF + SD read'),
        ('U2', '74LVC245A', 'TSSOP-20', 1, 'data driver Pico->bus (5V-tol in, 3.3V out = TTL VIH ok)'),
        ('U3', '74LVC245A', 'TSSOP-20', 1, 'control sense 5V->3.3V'),
        ('U4', '74HC688', 'SOIC-20W', 1, 'address compare: port 70h + /M1 qualify'),
        ('U5', '74HC32', 'SOIC-14', 1, '/OE = /SEL|/IORQ|/RD|A0'),
        ('Q1', '2N7002', 'SOT-23', 1, '/WAIT open-drain (hardware flow control)'),
        ('R1', '4.7k', '0805', 1, '/WAIT pull-up to +5V'),
        ('R2', '10k', '0805', 1, 'WAIT gate pull-down (release on boot)'),
        ('C1-C4', '100nF', '0603', 4, 'decoupling'),
        ('C5', '10uF', '0805', 1, 'bulk'),
        ('J1', 'PC-8001 expansion', '2x25 2.54mm (verify!)', 1, 'PINOUT PLACEHOLDER - check service manual'),
        ('J2', 'microSD', 'Hirose DM3AT', 1, 'SPI mode'),
    ]
    for r in rows: w.writerow(r)
print('netlist + BOM written')
