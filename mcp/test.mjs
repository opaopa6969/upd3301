// e2e test for upd3301 MCP server
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = 9927; // test port to avoid conflict
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let client;

describe('upd3301 MCP server e2e', { concurrency: false }, () => {
  before(async () => {
    child = spawn('node', ['mcp/server.mjs'], {
      env: { ...process.env, PORT: String(PORT), NODE_PATH: '/home/opa/work/volta-mcp/node_modules' },
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    // wait for healthz
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(`${BASE}/healthz`);
        if (r.ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  after(async () => {
    if (client) await client.close().catch(() => {});
    if (child) child.kill();
  });

  it('/healthz returns 200', async () => {
    const r = await fetch(`${BASE}/healthz`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.name, 'upd3301-mcp');
  });

  it('connects and lists 7 tools', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
    client = new Client({ name: 'test', version: '0.1.0' });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.length >= 7, `expected >=7 tools, got ${tools.tools.length}`);
    const names = tools.tools.map((t) => t.name).sort();
    assert.ok(names.includes('z80_assemble'));
    assert.ok(names.includes('z80_disassemble'));
    assert.ok(names.includes('crt_render'));
    assert.ok(names.includes('rom_identify'));
    assert.ok(names.includes('analysis_validate'));
    assert.ok(names.includes('analysis_merge'));
    assert.ok(names.includes('d88_info'));
  });

  it('z80_assemble assembles NOP + JP 0', async () => {
    const r = await client.callTool({ name: 'z80_assemble', arguments: { source: 'NOP\nJP 0', org: 0 } });
    const j = JSON.parse(r.content[0].text);
    assert.ok(j.bytes.startsWith('00C3'), `expected 00C3..., got ${j.bytes}`);
    assert.equal(j.errors.length, 0);
  });

  it('z80_disassemble roundtrips', async () => {
    const asm = await client.callTool({ name: 'z80_assemble', arguments: { source: 'XOR A\nLD B,10\nLOOP: DEC B\nJR NZ,LOOP\nHALT', org: 0x8000 } });
    const asmJ = JSON.parse(asm.content[0].text);
    const dis = await client.callTool({ name: 'z80_disassemble', arguments: { bytes: asmJ.bytes, addr: 0x8000 } });
    const disJ = JSON.parse(dis.content[0].text);
    assert.ok(disJ.text.length > 0);
    assert.ok(disJ.len > 0);
  });

  it('rom_identify identifies n88.rom', async () => {
    const r = await client.callTool({ name: 'rom_identify', arguments: { filename: 'n88.rom', size: 0x8000 } });
    const j = JSON.parse(r.content[0].text);
    assert.equal(j.role, 'n88main');
    assert.equal(j.kind, 'rom');
  });

  it('rom_identify returns null for unknown', async () => {
    const r = await client.callTool({ name: 'rom_identify', arguments: { filename: 'unknown.bin' } });
    const j = JSON.parse(r.content[0].text);
    assert.equal(j, null);
  });

  it('analysis_validate validates a minimal doc', async () => {
    const doc = {
      schemaVersion: 1,
      machine: 'pc8801',
      romHash: { n88main: 'fnv1a:abcdef01234567' },
      labels: {},
    };
    const r = await client.callTool({ name: 'analysis_validate', arguments: { doc } });
    const j = JSON.parse(r.content[0].text);
    assert.equal(j.ok, true);
  });

  it('analysis_merge merges two docs', async () => {
    const docA = {
      schemaVersion: 1,
      machine: 'pc8801',
      romHash: { n88main: 'fnv1a:abcdef01234567' },
      labels: { '0000': { name: 'RESET', confidence: 'observed', evidence: { samples: 1 } } },
    };
    const docB = {
      schemaVersion: 1,
      machine: 'pc8801',
      romHash: { n88main: 'fnv1a:abcdef01234567' },
      labels: { '0006': { name: 'ENTRY', confidence: 'observed', evidence: { samples: 1 } } },
    };
    const r = await client.callTool({ name: 'analysis_merge', arguments: { docA, docB } });
    const j = JSON.parse(r.content[0].text);
    assert.equal(j.ok, true);
    assert.ok('0000' in j.doc.labels);
    assert.ok('0006' in j.doc.labels);
  });

  it('d88_info parses a minimal D88', async () => {
    const { buildD88 } = await import('../d88.js');
    const d88 = buildD88({
      name: 'TEST', media: 0x00,
      tracks: [[{ c: 0, h: 0, r: 1, n: 1, density: 0x00, deleted: false, status: 0, data: new Uint8Array(128) }]],
    });
    const hex = Array.from(d88).map((b) => b.toString(16).padStart(2, '0')).join('');
    const r = await client.callTool({ name: 'd88_info', arguments: { bytes: hex } });
    const j = JSON.parse(r.content[0].text);
    assert.ok(Array.isArray(j));
    assert.ok(j.length >= 1);
    assert.equal(j[0].name, 'TEST');
    assert.equal(j[0].media, '2D');
  });

  it('crt_render renders a small indexed frame', async () => {
    // 4x2 indexed: all white (7) — need exactly 8 bytes (width*height)
    const pixels = '07' .repeat(8);
    const r = await client.callTool({
      name: 'crt_render',
      arguments: { pixels, width: 4, height: 2, mode: 'indexed' },
    });
    const j = JSON.parse(r.content[0].text);
    assert.ok(j.rgba.length > 0);
    assert.equal(j.width, 4);
    assert.equal(j.height, 4); // outHeight = srcHeight * 2
  });

  it('resource upd3301://spec is retrievable', async () => {
    const resources = await client.listResources();
    const specUri = resources.resources.find((r) => r.uri === 'upd3301://spec');
    assert.ok(specUri, 'spec resource not found');
  });

  it('resource upd3301://guide is retrievable', async () => {
    const resources = await client.listResources();
    const guideUri = resources.resources.find((r) => r.uri === 'upd3301://guide');
    assert.ok(guideUri, 'guide resource not found');
  });
});
