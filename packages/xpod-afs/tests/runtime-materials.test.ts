import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveProducerMaterials } from '../scripts/producer-materials';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const parent = path.resolve(import.meta.dir, '../../../.test-data/runtime-materials');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'case-'));
  const cli = path.join(root, 'cli'); const runtime = path.join(root, 'client');
  const materials = path.join(cli, 'dist/producer-materials');
  const put = (filename: string, content: string) => { mkdirSync(path.dirname(filename), { recursive: true }); writeFileSync(filename, content); };
  put(path.join(cli, 'package.json'), JSON.stringify({ name: '@undefineds.co/xpod-cli', version: '0.0.1' }));
  for (const filename of ['client.cjs', 'client.mjs', 'output.mjs']) put(path.join(cli, 'dist', filename), '// fixture payload\n');
  put(path.join(runtime, 'package.json'), JSON.stringify({ name: '@undefineds.co/xpod-client', version: '0.0.1', exports: { '.': './dist/index.mjs' } }));
  for (const filename of ['LICENSE', 'README.md', 'dist/index.mjs']) put(path.join(runtime, filename), 'fixture runtime\n');
  const sourceFiles = ['src/index.ts', 'workspace/xpod-client/src/index.ts'].map(filename => {
    put(path.join(materials, 'source', filename), '// fixture source\n');
    const bytes = readFileSync(path.join(materials, 'source', filename));
    return { path: filename, bytes: bytes.length, sha256: hash(bytes) };
  });
  put(path.join(materials, 'source-inventory.json'), JSON.stringify({ schemaVersion: 1, files: sourceFiles }));
  const packed = spawnSync('tar', ['-czf', path.join(materials, 'client-source.tar.gz'), '-C', path.join(materials, 'source'), '.']);
  if (packed.error || packed.status !== 0) throw new Error('Fixture source archive failed');
  for (const filename of ['client-inputs.json', 'output-inputs.json', 'javascript/notices.txt', 'javascript/generated/index.json']) put(path.join(materials, filename), '{}\n');
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const walk = (directory: string, inventory: typeof files, base: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filename, inventory, base);
      else { const bytes = readFileSync(filename); inventory.push({ path: path.relative(base, filename), bytes: bytes.length, sha256: hash(bytes) }); }
    }
  };
  walk(materials, files, materials);
  const runtimeFiles: typeof files = []; walk(runtime, runtimeFiles, runtime);
  const index = { schemaVersion: 1, status: 'producer-materials-only', producer: { name: '@undefineds.co/xpod-cli', version: '0.0.1', bunVersion: '1.4.2' },
    sourceAuthority: { sourceCommit: null, dirty: null, scope: 'Synthetic contract fixture', snapshotSHA256: hash(Buffer.from(JSON.stringify(sourceFiles))) },
    clientPayloads: { cjsSHA256: hash(readFileSync(path.join(cli, 'dist/client.cjs'))), esmSHA256: hash(readFileSync(path.join(cli, 'dist/client.mjs'))) },
    workspaceSources: [{ name: '@undefineds.co/xpod-client', version: '0.0.1', directory: 'workspace/xpod-client', role: 'declared-runtime-dependency' }],
    runtimeClients: [{ name: '@undefineds.co/xpod-client', version: '0.0.1', sourceDirectory: 'workspace/xpod-client', files: runtimeFiles }],
    outputMetafile: 'output-inputs.json', outputPayloads: { esmSHA256: hash(readFileSync(path.join(cli, 'dist/output.mjs'))) },
    supplements: 'javascript', generatedRoot: 'javascript/generated', clientMetafile: 'client-inputs.json', clientSource: 'client-source.tar.gz', sourceDirectory: 'source', sourceInventory: 'source-inventory.json', files };
  const filename = path.join(materials, 'index.json');
  const save = () => writeFileSync(filename, JSON.stringify(index)); save();
  return { root, runtime, filename, index, save };
}

test('runtime client public payload bytes and source mapping bind the producer authority', async () => {
  const f = fixture();
  try {
    const result = await resolveProducerMaterials(f.filename, f.runtime);
    expect(result.runtimeClient?.files.length).toBe(4);
    writeFileSync(path.join(f.runtime, 'dist/index.mjs'), 'modified runtime');
    await expect(resolveProducerMaterials(f.filename, f.runtime)).rejects.toThrow('payload mismatch');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('runtime authority rejects omitted files, wrong source mappings and unbound command output', async () => {
  for (const kind of ['missing', 'mapping', 'output'] as const) {
    const f = fixture();
    try {
      if (kind === 'missing') f.index.runtimeClients[0].files.pop();
      if (kind === 'mapping') f.index.runtimeClients[0].sourceDirectory = 'workspace/foreign';
      if (kind === 'output') f.index.outputPayloads.esmSHA256 = '0'.repeat(64);
      f.save();
      await expect(resolveProducerMaterials(f.filename, f.runtime)).rejects.toThrow();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});
