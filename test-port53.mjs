// Port 53h display mask (PC-8801): b0=1 hides the text plane, b1=1 hides
// graphics. Ys II draws its whole map in GVRAM and sets b0 to suppress the
// leftover text VRAM; without honouring 53h the text plane occluded the map
// (black centre). This locks the render gating so that regression can't return.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pc8801Machine } from './machine88.js';

const main = () => new Uint8Array(0x8000).fill(0xff);
// a cgrom whose every glyph line is solid (0xff) so ANY text cell is opaque —
// makes "is the text plane drawn?" a black-vs-white question, no ambiguity.
const solidCgrom = () => new Uint8Array(256 * 16).fill(0xff);

const litTextPixels = (img) => { let n = 0; for (const p of img.pixels) if (p) n++; return n; };

test('53h b0: writing 1 hides the text plane, 0 shows it', () => {
  const m = new Pc8801Machine({ main: main() });
  m.out(0x31, 0x10);            // colour mode, 200-line
  m.out(0x30, 0x01);            // 80 col
  // put a non-space char everywhere the CRTC will fetch text from
  m.crtc.getScreen = () => ({
    cols: 80, rows: 25, linesPerChar: 8, displayEnabled: true,
    cells: new Uint8Array(80 * 25).fill(0x41), // 'A'
    attrs: new Uint8Array(80 * 25),
    attrPairs: new Uint8Array(80 * 25), attrPerCell: true, attrsPerRow: 20,
    cursor: { on: false, x: 0, y: 0 },
  });
  const cg = solidCgrom();

  m.out(0x53, 0x00); // text ON
  const on = m.render({ cgrom: cg, indexed: true, textOpaque: true });
  assert.ok(litTextPixels(on) > 0, 'text plane should paint pixels when 53h b0=0');

  m.out(0x53, 0x01); // text OFF
  const off = m.render({ cgrom: cg, indexed: true, textOpaque: true });
  assert.equal(litTextPixels(off), 0, 'text plane must be fully suppressed when 53h b0=1');
});

test('53h b1: writing 1 hides graphics while text stays', () => {
  const m = new Pc8801Machine({ main: main() });
  m.out(0x31, 0x18);           // colour + gvram on (b3)
  m.gvram[0].fill(0xff);       // plane B all lit
  m.crtc.getScreen = () => ({
    cols: 80, rows: 25, linesPerChar: 8, displayEnabled: true,
    cells: new Uint8Array(80 * 25), attrs: new Uint8Array(80 * 25),
    attrPairs: new Uint8Array(80 * 25), attrPerCell: true, attrsPerRow: 20,
    cursor: { on: false, x: 0, y: 0 },
  });
  // blank cgrom → the text plane paints nothing, so lit pixels come ONLY from
  // graphics; that isolates the b1 graph-off gate from the text plane.
  const cg = new Uint8Array(256 * 16);

  m.out(0x53, 0x00);
  const on = m.render({ cgrom: cg, indexed: true });
  assert.ok(litTextPixels(on) > 0, 'graphics visible when 53h b1=0');

  m.out(0x53, 0x02); // graph OFF
  const off = m.render({ cgrom: cg, indexed: true });
  assert.equal(litTextPixels(off), 0, 'graphics must be suppressed when 53h b1=1 (text here is blank)');
});

test('53h survives snapshot/restore', () => {
  const m = new Pc8801Machine({ main: main() });
  m.out(0x53, 0x03);
  const snap = m.snapshot();
  m.out(0x53, 0x00);
  m.restore(snap);
  assert.equal(m._port53, 0x03, 'port53 round-trips through snapshot');
});
