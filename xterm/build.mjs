// build — single-file packaging for the ttyd client page. Zero deps.
//
// Not a real bundler; a transform that is exactly strong enough for this
// repo's own code style (top-level single-line `import { a, b } from '...'`,
// `export const/function/class`, `export { name };`) and nothing more. Each
// module becomes a lazily-evaluated factory in a tiny registry, so modules
// keep their own scope — crt.js and tube.js both export SCHEMA_VERSION and
// naive concatenation would be a SyntaxError. Anything the transform can't
// prove it handled makes the build throw instead of emitting garbage.
//
// Usage: node xterm/build.mjs
// Reads  xterm/ttyd-crt.html (the dev page, which imports real ES modules),
// swaps the marked script block for the inlined bundle, writes
// xterm/dist/ttyd-crt.html — the one file you hand to `ttyd --index`.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENTRY = 'xterm/crt-xterm.js';
export const TEMPLATE = 'xterm/ttyd-crt.html';
export const OUT = 'xterm/dist/ttyd-crt.html';
const MARK_START = '<!-- BUILD:BUNDLE-START -->';
const MARK_END = '<!-- BUILD:BUNDLE-END -->';

// module id = repo-root-relative posix path ('crt.js', 'demo/font.js', ...)
const resolveId = (fromId, spec) =>
  path.posix.normalize(path.posix.join(path.posix.dirname(fromId), spec));

// One module: strip imports (recording deps), unwrap exports (recording
// names), return { code, deps, exports } ready to wrap in a factory.
export function transformModule(source, id) {
  const deps = [];
  const exports = [];
  let code = source;

  // import { a, b as c } from './x.js';  →  const { a, b: c } = __req('id');
  code = code.replace(
    /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?[^\n]*$/gm,
    (_, names, spec) => {
      const dep = resolveId(id, spec);
      deps.push(dep);
      const bound = names.split(',').map((s) => s.trim()).filter(Boolean)
        .map((s) => s.replace(/\s+as\s+/, ': ')).join(', ');
      return `const { ${bound} } = __req(${JSON.stringify(dep)});`;
    });

  // export { a, b };  → (names were declared or imported above) record only
  code = code.replace(/^export\s*\{([^}]*)\}\s*;?[^\n]*$/gm, (_, names) => {
    for (const s of names.split(',').map((v) => v.trim()).filter(Boolean)) {
      const m = s.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
      exports.push(m ? `${m[2]}: ${m[1]}` : s);
    }
    return '';
  });

  // export const X / export function X / export class X → declaration + record
  code = code.replace(
    /^export\s+(const|let|var|async function|function|class)\s+([\w$]+)/gm,
    (_, kind, name) => { exports.push(name); return `${kind} ${name}`; });

  // safety net: any surviving module syntax means the transform missed
  // something — refuse to ship it
  if (/^\s*(import|export)\s/m.test(code)) {
    throw new Error(`build: unhandled import/export left in ${id}`);
  }
  if (code.includes('</script')) {
    throw new Error(`build: ${id} contains '</script' and cannot be inlined`);
  }
  return { code, deps, exports };
}

// DFS from the entry, emitting each module once, dependencies first (the
// registry is lazy, but define-before-use keeps the output readable).
export function bundleModules(entryId = ENTRY, root = ROOT) {
  const seen = new Map();
  const order = [];
  const visit = (id) => {
    if (seen.has(id)) return;
    seen.set(id, null); // pre-mark: a cycle would mean our deps went bad
    const src = readFileSync(path.join(root, id), 'utf8');
    const mod = transformModule(src, id);
    for (const d of mod.deps) visit(d);
    seen.set(id, mod);
    order.push(id);
  };
  visit(entryId);

  let out = '// bundled by xterm/build.mjs — do not edit; edit the modules\n'
    + 'const __defs = new Map(), __mods = new Map();\n'
    + 'const __def = (id, fn) => { __defs.set(id, fn); };\n'
    + 'const __req = (id) => {\n'
    + '  if (!__mods.has(id)) __mods.set(id, __defs.get(id)(__req));\n'
    + '  return __mods.get(id);\n'
    + '};\n';
  for (const id of order) {
    const { code, exports } = seen.get(id);
    out += `\n// ---- ${id} ----\n__def(${JSON.stringify(id)}, (__req) => {\n`
      + code
      + `\nreturn { ${exports.join(', ')} };\n});\n`;
  }
  return out;
}

export function buildHtml({ root = ROOT } = {}) {
  const template = readFileSync(path.join(root, TEMPLATE), 'utf8');
  const a = template.indexOf(MARK_START);
  const b = template.indexOf(MARK_END);
  if (a < 0 || b < 0 || b < a) throw new Error('build: BUNDLE markers not found in template');
  const bundle = bundleModules(ENTRY, root)
    + `\nconst { CrtRendererAddon, PHOSPHORS, MASKS } = __req(${JSON.stringify(ENTRY)});\n`
    + 'window.CrtRendererAddon = CrtRendererAddon;\n'
    + 'window.CrtPHOSPHORS = PHOSPHORS;\n'
    + 'window.CrtMASKS = MASKS;\n';
  const html = template.slice(0, a)
    + '<script type="module">\n' + bundle + '</script>'
    + template.slice(b + MARK_END.length);
  const outPath = path.join(root, OUT);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  return { outPath, bytes: html.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { outPath, bytes } = buildHtml();
  console.log(`wrote ${path.relative(ROOT, outPath)} (${bytes} bytes)`);
}
