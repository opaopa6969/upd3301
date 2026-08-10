// gbtools/suite — run a directory of test ROMs and print a table.
//
//   node gbtools/suite.mjs <dir-or-rom> [--mooneye|--blargg] [--frames N]
//                                       [--model dmg|cgb|auto] [--quiet]
//
// The judge is picked per ROM by which detector fires, so a mixed directory
// works: mooneye's breakpoint wins if it happens, blargg's serial text
// otherwise. `--mooneye` / `--blargg` only force the judge for ROMs that
// produce neither, which is the honest way to count a timeout as a failure
// rather than dropping it from the table.

import { readdirSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { runTest, judgeMooneye, judgeBlargg } from './gbrun.mjs';

function collect(path) {
  const st = statSync(path);
  if (st.isFile()) return [path];
  const out = [];
  for (const e of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, e.name);
    if (e.isDirectory()) out.push(...collect(p));
    else if (/\.gbc?(\.gz)?$/i.test(e.name)) out.push(p);
  }
  return out.sort();
}

function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) {
    console.error('usage: node gbtools/suite.mjs <dir-or-rom> [--mooneye|--blargg] [--frames N] [--model dmg|cgb]');
    process.exit(2);
  }
  const flag = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : def;
  };
  const frames = Number(flag('frames', 2400));
  const model = flag('model', 'auto');
  const quiet = args.includes('--quiet');
  const forceMooneye = args.includes('--mooneye');
  const forceBlargg = args.includes('--blargg');

  const roms = collect(target);
  let pass = 0, fail = 0;
  const failures = [];
  for (const rom of roms) {
    const name = relative(target, rom) || basename(rom);
    let r, verdict, how;
    try {
      r = runTest(rom, { frames, model });
    } catch (e) {
      fail++; failures.push([name, `error: ${e.message}`]);
      if (!quiet) console.log(`FAIL  ${name}  (${e.message})`);
      continue;
    }
    if (r.breakpoint || (forceMooneye && !forceBlargg)) {
      const j = judgeMooneye(r);
      verdict = j.pass; how = j.regs ? `regs ${j.regs.join(',')}` : j.how;
    } else {
      const j = judgeBlargg(r);
      verdict = j.pass; how = j.text.split('\n').filter(Boolean).slice(-1)[0] || '(silent)';
    }
    if (verdict) { pass++; if (!quiet) console.log(`ok    ${name}`); }
    else { fail++; failures.push([name, how]); if (!quiet) console.log(`FAIL  ${name}  ${how}`); }
  }
  console.log(`\n${pass}/${pass + fail} passed`);
  if (failures.length && quiet) for (const [n, why] of failures) console.log(`  FAIL ${n}  ${why}`);
}

main();
