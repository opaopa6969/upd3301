// boot88-fdd — watch the main/sub handshake happen (or not).
// usage: node tools/boot88-fdd.mjs [frames] [path.d88]
import { readFile } from 'node:fs/promises';
import { Pc8801Machine } from '../machine88.js';
import { parseD88All } from '../d88.js';

const frames = Number(process.argv[2] ?? 240);
const d88path = process.argv[3] ?? null;

const main = new Uint8Array(await readFile('roms/8801mkIIFR/n88.rom'));
const sub = new Uint8Array(await readFile('roms/8801mkIIFR/disk.rom'));
const ext = new Uint8Array(0x8000);
for (let i = 0; i < 4; i++) {
  ext.set(new Uint8Array(await readFile(`roms/8801mkIIFR/n88_${i}.rom`)), i * 0x2000);
}

const m = new Pc8801Machine({ main, ext, sub, mode: 'n88' });

if (d88path) {
  const disks = parseD88All(new Uint8Array(await readFile(d88path)));
  m.insertDisk(0, disks[0]);
  console.log(`mounted: "${disks[0].name}" (${disks.length} disk(s) in file)`);
}

let lastSubPc = -1;
const fdcCmds = new Set();
const origWrite = m.sub.fdc.write.bind(m.sub.fdc);
let cmdLog = [];
m.sub.fdc.write = (v) => {
  if (m.sub.fdc.phase === 'idle') {
    fdcCmds.add(v & 0x1f);
    cmdLog.push(`f${m.frame}:${(v & 0x1f).toString(16)}`);
  }
  origWrite(v);
};

for (let f = 0; f < frames; f++) {
  m.stepFrame();
  if (f % 60 === 59) {
    const s = m.sub.getState();
    console.log(`frame ${f + 1}: mainPC=${m.cpu.pc.toString(16).padStart(4, '0')}` +
      ` subPC=${s.pc.toString(16).padStart(4, '0')}${s.halted ? '(halt)' : ''}` +
      ` fdc=${s.fdc.phase} motor=${s.motor.toString(2)}`);
  }
}

console.log('\nFDC commands seen:', [...fdcCmds].map((c) => c.toString(16)).join(',') || 'none');
console.log('command log:', cmdLog.slice(0, 40).join(' '));
console.log('\nscreen:');
for (const line of m.screenText()) console.log('|' + line);
