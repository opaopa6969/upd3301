**English** · [日本語](./theory.ja.md)

# Racing the Electron Beam — CRT controller theory

**Yu**: Hey, is it true old computers had a separate *chip* just for putting
text on screen? Couldn't the CPU just... draw the letters?

**Me**: That's what I thought too — "just write pixels in a for-loop, right?"
Then I learned how a CRT works and changed my mind. A cathode-ray tube fires
an electron beam that sweeps from the top-left, line by line, lighting up
phosphor as it goes. And the beam **never waits for you**. It repaints the
whole screen 60 times a second; one scanline lasts just 63.5 microseconds.
The CPU has no time to daydream.

**Yu**: So you have to keep handing it the right dots at the exact moment the
beam passes?

**Me**: Forever, yes. I call it "racing the beam." And the chip that runs
that race for you is the CRT controller — our hero, the **μPD3301**, from a
1979 computer called the PC-8001.

**Yu**: Does the chip memorize the shapes of the letters?

**Me**: No, and the division of labor is the fun part. Font shapes live in a
separate ROM. The μPD3301 only manages *which character code sits at which
row and column* — and here's the kicker, **it doesn't even store that**. The
character table lives in main memory, and the μPD3301 can't read memory
by itself.

**Yu**: Then how does anything get displayed?!

**Me**: It has a partner: the **μPD8257** DMA controller. DMA means Direct
Memory Access — moving bytes without bothering the CPU. The μPD3301 just
raises a signal (DRQ) saying "next row, please!" and the μPD8257 hauls over
one row's worth: **120 bytes**. Eighty character codes, plus a 40-byte bonus.

**Yu**: Bonus?

**Me**: **Attributes** — twenty (position, property) pairs. Think of them as
**sticky notes**: "yellow from column 30," "blinking from column 50." Sending
a color for all 80 columns every time would be wasteful, so you only send the
*change points*, and each note stays in effect until the next one. Twenty
notes per row is the budget — that's why the PC-8001 famously could only
change colors 20 times per line. Not a spec bug; DMA thrift.

**Yu**: Ha! And when do letter shapes finally appear?

**Me**: Right before the beam arrives. Take the character code (`A` = 65) and
the beam's current line, look up "glyph 65, line 3" in the character
generator ROM, and out come 8 dots of on/off. A character cell is 8 dots × 8
lines, so the same code gets reused for 8 scanlines. That's why the μPD3301
keeps *two* row buffers inside: one is being displayed while DMA fills the
other. Double buffering.

**Yu**: I also saw "semigraphics" on one of those sticky notes — what's that?

**Me**: A note can say "this span isn't text, it's block art." Then the
character byte is read not as a font index but as a **2×4 tile picture**: the
cell splits into 8 blocks, two across and four down, and each 1-bit paints a
block. One byte per cell, instant pixel art. Before the Famicom existed, this
*was* PC-8001 graphics. The beer mug in the demo is drawn exactly this way.

**Yu**: What about switching between 40 and 80 columns? Does the screen get
wider?

**Me**: Same screen — what changes is **how fast dots are sent**. In
40-column mode the character clock is halved, so every dot is painted twice
as wide. The μPD3301 has no "40-column feature"; you just reprogram it to "a
row is 40 characters" and external circuitry halves the clock. That's why the
text looks bold.

**Yu**: Any downside to this whole scheme?

**Me**: A famous one. While DMA owns the memory bus, **the CPU stalls**. The
PC-8001 lost about 30% of its speed just by *showing* the screen — games
sometimes blanked the display to compute faster. But people also turned the
weakness inside out: program the DMA counter with *two* screens' worth
instead of one, and the two screens alternate every frame. On a machine
limited to 8 colors, flickering two colors fast enough looks like a color in
between — the magazine-famous "27-color" trick. Playing in the gaps of
the hardware.

**Yu**: So the playground isn't the spec — it's the gaps in the mechanism.

**Me**: That's my favorite part. Used as documented, this chip prints 80×25
text, period. One DMA counter later, it's a 27-color machine. A future the
designers never imagined was just lying there on the bus.

---

Once this clicks, `index.js` reads differently: `drq(buf)` inside
`stepFrame()` is the moment the chip asks the μPD8257 for row data to race
the beam; `expandAttrRow()` stretches the sticky notes into per-column
colors. In `pc8001.js`, `renderScreen()` is the CGROM lookup that turns codes
into dots, and the autoload in `upd8257.js`'s `drqPull()` is the seed of the
27-color trick.
