#!/usr/bin/env node
// upd3301 MCP server — wraps pure JS library functions as MCP tools.
// Streamable HTTP /mcp + /healthz, PORT env, 0.0.0.0 bind.
// SDK: @modelcontextprotocol/sdk (resolved via volta-mcp node_modules)

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { assemble } from '../z80asm.js';
import { disasm } from '../z80dis.js';
import { identify, ROM_TABLE } from '../romid.js';
import { parseD88All, summarize } from '../d88.js';
import { validate, merge } from '../analysisdb.js';
import { CrtPhosphor, PHOSPHORS } from '../crt.js';
import { CrtTube, MASKS } from '../tube.js';

const VERSION = '0.1.0';
const NAMESPACE = 'upd3301';

function log(...a) {
  process.stderr.write('[' + NAMESPACE + '-mcp] ' + a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n');
}

// ---- helpers ---------------------------------------------------------------
const hexEncode = (bytes) => {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0').toUpperCase();
  return s;
};
const hexDecode = (hex) => {
  hex = hex.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length % 2) throw new Error('hex string has odd length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
};
const b64Encode = (bytes) => Buffer.from(bytes).toString('base64');
const b64Decode = (str) => new Uint8Array(Buffer.from(str, 'base64'));
const decodeBytes = (str) => {
  if (!str) return new Uint8Array(0);
  // auto-detect base64 vs hex: hex chars are [0-9a-fA-F], base64 can have +/=
  const trimmed = str.trim();
  if (/^[0-9a-fA-F\s]+$/.test(trimmed) && trimmed.replace(/\s/g, '').length % 2 === 0) {
    return hexDecode(trimmed);
  }
  return b64Decode(trimmed);
};

// ---- MCP server ------------------------------------------------------------
function createServer() {
  const server = new McpServer({
    name: NAMESPACE + '-mcp',
    version: VERSION,
  });

  const ann = { readOnlyHint: true, idempotentHint: true };

  // 1. z80_assemble
  server.registerTool('z80_assemble', {
    description: 'Z80ソースをアセンブルする（two-pass macro assembler）。危険度: none。入力: Z80アセンブラソーステキスト + org（省略時0）。出力: bytes(hex), symbols, listing, errors, warnings',
    inputSchema: { source: z.string(), org: z.number().optional() },
    annotations: ann,
  }, async (args) => {
    const result = assemble(args.source, { org: args.org ?? 0 });
    const out = {
      bytes: hexEncode(result.bytes),
      org: result.org,
      symbols: result.symbols,
      listing: result.listing,
      errors: result.errors,
      warnings: result.warnings,
    };
    return { content: [{ type: 'text', text: JSON.stringify(out) }] };
  });

  // 2. z80_disassemble
  server.registerTool('z80_disassemble', {
    description: 'Z80バイナリを逆アセンブルする。危険度: none。入力: bytes(hex or base64) + addr（省略時0）+ syntax(zilog|intel, 省略時zilog)。出力: text, len, bytes(hex)',
    inputSchema: { bytes: z.string(), addr: z.number().optional(), syntax: z.enum(['zilog', 'intel']).optional() },
    annotations: ann,
  }, async (args) => {
    const data = hexDecode(args.bytes);
    const addr = args.addr ?? 0;
    let pos = 0;
    const read = (a) => {
      const off = a - addr;
      return off >= 0 && off < data.length ? data[off] : 0;
    };
    const result = disasm(read, addr, { syntax: args.syntax ?? 'zilog' });
    const out = {
      text: result.text,
      len: result.len,
      bytes: hexEncode(result.bytes),
    };
    return { content: [{ type: 'text', text: JSON.stringify(out) }] };
  });

  // 3. crt_render
  server.registerTool('crt_render', {
    description: 'フレームをCRT物理（蛍光体・シャドウマスク・管面）でレンダリングする。危険度: none。入力: pixels(hex or base64), width, height, mode(indexed|rgba), phosphor(P22|P39|AMBER|LONG, 省略時P22), mask(none|aperture|shadow|slot|plasma, 省略時aperture), barrel(省略時0.06), gamma(省略時2.2)。出力: rgba(base64), width, height',
    inputSchema: {
      pixels: z.string(),
      width: z.number().int().min(1).max(1024),
      height: z.number().int().min(1).max(1024),
      mode: z.enum(['indexed', 'rgba']),
      phosphor: z.string().optional(),
      mask: z.string().optional(),
      barrel: z.number().optional(),
      gamma: z.number().optional(),
    },
    annotations: ann,
  }, async (args) => {
    const srcData = decodeBytes(args.pixels);
    const w = args.width, h = args.height;
    const phosName = args.phosphor ?? 'P22';
    const phosphor = PHOSPHORS[phosName] ?? PHOSPHORS.P22;
    const maskName = args.mask ?? 'aperture';

    // Build phosphor layer
    const phos = new CrtPhosphor({ width: w, height: h, phosphor });
    if (args.mode === 'indexed') {
      if (srcData.length < w * h) throw new Error(`indexed mode needs ${w * h} bytes, got ${srcData.length}`);
      phos.step(srcData.subarray(0, w * h), 1 / 60);
    } else {
      // rgba: convert to indexed (GRB 0..7) by thresholding
      const indexed = new Uint8Array(w * h);
      for (let i = 0; i < w * h && i * 4 + 3 < srcData.length; i++) {
        const r = srcData[i * 4], g = srcData[i * 4 + 1], b = srcData[i * 4 + 2];
        indexed[i] = ((g > 128) << 2) | ((r > 128) << 1) | (b > 128);
      }
      phos.step(indexed, 1 / 60);
    }
    const lum = phos.composite();

    // Build tube layer
    const tube = new CrtTube({
      srcWidth: w, srcHeight: h,
      outWidth: w, outHeight: h * 2,
      mask: MASKS.includes(maskName) ? maskName : 'aperture',
      barrel: args.barrel ?? 0.06,
    });
    const rgba = tube.apply(lum, null, { gamma: args.gamma ?? 2.2 });

    const out = {
      rgba: b64Encode(rgba),
      width: tube.outWidth,
      height: tube.outHeight,
    };
    return { content: [{ type: 'text', text: JSON.stringify(out) }] };
  });

  // 4. rom_identify
  server.registerTool('rom_identify', {
    description: 'ROMファイル名を識別してPC-8001/8801の役割に割り当てる。危険度: none。入力: filename, size(省略可)。出力: {role, label, sizes, supported, sizeWarn} | null',
    inputSchema: { filename: z.string(), size: z.number().optional() },
    annotations: ann,
  }, async (args) => {
    const result = identify({ name: args.filename, size: args.size ?? null });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 5. analysis_validate
  server.registerTool('analysis_validate', {
    description: '解析レコード（analysisdb JSON）を検証する。危険度: none。入力: doc(JSON object)。出力: {ok, errors, warnings}',
    inputSchema: { doc: z.record(z.any()) },
    annotations: ann,
  }, async (args) => {
    const result = validate(args.doc);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 6. analysis_merge
  server.registerTool('analysis_merge', {
    description: '2つの解析レコードをマージする（可換・結合的・冪等）。危険度: none。入力: docA, docB (JSON objects), force(bool, 省略時false), allowUnknownRom(bool, 省略時true)。出力: {ok, doc, conflicts, warnings}',
    inputSchema: {
      docA: z.record(z.any()),
      docB: z.record(z.any()),
      force: z.boolean().optional(),
      allowUnknownRom: z.boolean().optional(),
    },
    annotations: ann,
  }, async (args) => {
    const result = merge(args.docA, args.docB, {
      force: args.force ?? false,
      allowUnknownRom: args.allowUnknownRom ?? true,
    });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 7. d88_info
  server.registerTool('d88_info', {
    description: 'D88ディスクイメージのメタデータを読む（PC-88/98フロッピーフォーマット）。危険度: none。入力: bytes(hex or base64)。出力: [{name, media, tracks, sectors, bytes, sectorSizes, oddities, writeProtect}]',
    inputSchema: { bytes: z.string() },
    annotations: ann,
  }, async (args) => {
    const data = decodeBytes(args.bytes);
    const disks = parseD88All(data);
    const out = disks.map((d) => summarize(d));
    return { content: [{ type: 'text', text: JSON.stringify(out) }] };
  });

  // ---- resources ----
  server.resource('spec', NAMESPACE + '://spec', {
    mimeType: 'application/json',
    description: 'upd3301 MCP の能力仕様',
  }, async () => {
    const spec = {
      namespace: NAMESPACE,
      name: 'upd3301 MCP',
      version: VERSION,
      summary: 'NEC μPD3301 CRTC エミュレータの純JSライブラリ（Z80アセンブラ/逆アセンブラ, CRT物理レンダラー, ROM識別, 解析DB, D88読み取り）をMCP tool として公開',
      capabilities: [
        { kind: 'tool', name: 'z80_assemble', summary: 'Z80ソースをアセンブル', side_effect: 'none', long_running: false, min_role: 'MEMBER' },
        { kind: 'tool', name: 'z80_disassemble', summary: 'Z80バイナリを逆アセンブル', side_effect: 'none', long_running: false, min_role: 'MEMBER' },
        { kind: 'tool', name: 'crt_render', summary: 'CRT物理レンダリング', side_effect: 'none', long_running: false, min_role: 'MEMBER' },
        { kind: 'tool', name: 'rom_identify', summary: 'ROMファイル名識別', side_effect: 'none', long_running: false, min_role: 'MEMBER' },
        { kind: 'tool', name: 'analysis_validate', summary: '解析レコード検証', side_effect: 'none', long_running: false, min_role: 'MEMBER' },
        { kind: 'tool', name: 'analysis_merge', summary: '解析レコードマージ', side_effect: 'none', long_running: false, min_role: 'MEMBER' },
        { kind: 'tool', name: 'd88_info', summary: 'D88ディスクメタデータ読み取り', side_effect: 'none', long_running: false, min_role: 'MEMBER' },
        { kind: 'resource', name: 'spec', summary: '能力仕様' },
        { kind: 'resource', name: 'guide', summary: '使い方ガイド' },
        { kind: 'resource', name: 'rom_hashes', summary: 'ROMハッシュ表' },
      ],
      compositions: [
        { title: 'Z80往復テスト', flow: ['upd3301__z80_assemble', 'upd3301__z80_disassemble'], note: 'アセンブル結果を逆アセンブルして一致確認' },
        { title: 'CRTレトロ風レンダリング', flow: ['upd3301__crt_render'], note: '他サービスのピクセルをCRT物理でレンダリング' },
        { title: 'ROM解析パイプライン', flow: ['upd3301__rom_identify', 'upd3301__d88_info', 'upd3301__analysis_validate', 'upd3301__analysis_merge'], note: 'ファイル識別→ディスク構造→解析レコード検証→統合' },
      ],
      depends_on: [],
      health: '/healthz',
      docs: [NAMESPACE + '://guide'],
    };
    return { contents: [{ uri: NAMESPACE + '://spec', mimeType: 'application/json', text: JSON.stringify(spec, null, 2) }] };
  });

  server.resource('guide', NAMESPACE + '://guide', {
    mimeType: 'text/markdown',
    description: 'upd3301 MCP の使い方',
  }, async () => {
    const text = [
      '# upd3301 MCP ガイド',
      '',
      '## z80_assemble',
      'Z80ソースをアセンブルする。`source` にZ80アセンブラソース、`org` に開始アドレス（省略時0）。',
      '```json',
      '{"source": "NOP\\nJP 0", "org": 0}',
      '```',
      '→ `{bytes: "00C30000", symbols: {}, listing: [...], errors: [], warnings: []}`',
      '',
      '## z80_disassemble',
      'Z80バイナリを逆アセンブルする。`bytes` はhex or base64、`addr` は開始アドレス（省略時0）、`syntax` は zilog|intel。',
      '',
      '## crt_render',
      'ピクセルデータをCRT物理でレンダリングする。`mode: "indexed"` は 0..7 の GRBインデックス、`mode: "rgba"` は RGBA。',
      '`phosphor`: P22(既定), P39, AMBER, LONG。`mask`: aperture(既定), shadow, slot, none, plasma。',
      '',
      '## rom_identify',
      'PC-8001/8801のROMファイル名を識別する。`n88.rom`, `n80.rom`, `disk.rom` 等。',
      '',
      '## analysis_validate / analysis_merge',
      '解析DBレコード（analysisdb.js 形式）の検証とマージ。merge は可換・結合的・冪等。',
      '',
      '## d88_info',
      'D88ディスクイメージのメタデータを読む。`bytes` はhex or base64。',
    ].join('\n');
    return { contents: [{ uri: NAMESPACE + '://guide', mimeType: 'text/markdown', text }] };
  });

  server.resource('rom_hashes', NAMESPACE + '://rom_hashes', {
    mimeType: 'application/json',
    description: 'ROMハッシュ表（romid.js の ROM_TABLE）',
  }, async () => {
    const table = Object.entries(ROM_TABLE).map(([name, e]) => ({ name, role: e.role, label: e.label, sizes: e.sizes, supported: e.supported !== false }));
    return { contents: [{ uri: NAMESPACE + '://rom_hashes', mimeType: 'application/json', text: JSON.stringify(table, null, 2) }] };
  });

  return server;
}

// ---- HTTP server -----------------------------------------------------------
async function main() {
  const port = parseInt(process.env.PORT ?? '9270', 10);
  const transports = new Map();

  const httpServer = http.createServer(async (req, res) => {
    res.setHeader('content-encoding', 'identity');
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, name: NAMESPACE + '-mcp', version: VERSION }));
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }

    const sid = req.headers['mcp-session-id'];
    if (sid && transports.has(sid)) {
      return await transports.get(sid).handleRequest(req, res);
    }

    if (req.method === 'POST' && !sid) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => { transports.set(id, transport); log('session open', id); },
        onsessionclosed: (id) => { transports.delete(id); log('session closed', id); },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      const server = createServer();
      await server.connect(transport);
      return await transport.handleRequest(req, res);
    }

    if (req.method === 'DELETE' && sid && transports.has(sid)) {
      const transport = transports.get(sid);
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid request' }));
  });

  httpServer.listen(port, '0.0.0.0', () => {
    log('listening on 0.0.0.0:' + port);
  });
}

main().catch((err) => { log('fatal', err); process.exit(1); });
