import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyClosedModulePhaseReceipts } from '../../scripts/lib/independent-admission/module-source-phases';
import { collectModulePhaseOriginals } from '../../scripts/lib/independent-admission/module-phase-originals';
const require = createRequire(import.meta.url);
const { inspectArtifact } = require('../../scripts/lib/product-artifact-command.cjs');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture(alter: (producer: any) => void = () => {}, receipt?: string) {
  mkdirSync('.test-data/module-phase-originals', { recursive: true });
  const root = mkdtempSync(path.resolve('.test-data/module-phase-originals/case-')); roots.push(root);
  const raw = Buffer.from('original raw bytes\n');
  const original = Buffer.from(receipt ?? JSON.stringify({ command: ['fixture'], actualWait: true, exit: 0, signal: null,
    ownedGroupAbsentAfterWait: true, rawClosedBeforeHash: true, resourceStop: null, supervisorError: null, cleanupErrors: [],
    ownedGroupMembers: [], rawSHA256: hash(raw), startedUTC: '2026-10-17T00:00:00Z', closedUTC: '2026-10-17T00:00:00Z', elapsedSeconds: 0 }));
  const producer: any = { phases: ['build', 'pack'].map(name => ({ name,
    receipt: { path: `evidence/${name}.receipt.json`, bytes: original.length, sha256: hash(original) },
    raw: { path: `evidence/${name}.raw.log`, bytes: raw.length, sha256: hash(raw) } })) };
  alter(producer);
  const files = [{ name: 'producer.receipt.json', body: Buffer.from(JSON.stringify(producer)).toString('base64') },
    ...['build', 'pack'].flatMap(name => [ { name: `evidence/${name}.receipt.json`, body: original.toString('base64') },
      { name: `evidence/${name}.raw.log`, body: raw.toString('base64') } ]),
    { name: 'unselected.tgz', body: Buffer.from('unexpanded archive').toString('base64') }];
  const archivePath = path.join(root, 'artifact.zip');
  const made = spawnSync('python3', ['-c', "import json,zipfile,base64,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for r in json.loads(sys.argv[2]):z.writestr(r['name'],base64.b64decode(r['body']))", archivePath, JSON.stringify(files)]);
  if (made.status !== 0) throw Error('tiny ZIP fixture');
  const archiveSha256 = hash(readFileSync(archivePath));
  const inspected = inspectArtifact([path.resolve('scripts/lib/inspect-product-artifact.py'), archivePath, archiveSha256,
    String(512 * 1024 ** 2), String(1024 ** 3), '50000'], { timeout: 30_000, maxBuffer: 16 * 1024 ** 2 });
  if (inspected.status !== 0) throw Error('fixture full inventory');
  return { archivePath, archiveSha256, inventory: JSON.parse(inspected.stdout), producer, original };
}
test('phase originals bind complete real ZIP, select only JSON and return isolated original copies', async () => {
  const f = fixture(); const view = await collectModulePhaseOriginals(f);
  expect(view.members).toHaveLength(6);
  expect(verifyClosedModulePhaseReceipts(f.producer.phases.map((phase: any) => ({ name: phase.name, command: ['fixture'] })),
    f.producer, view.members, view.readSmallReceipt)).toEqual({ phases: 2, rawBytes: 38 });
  expect(view.members.some(row => row.path === 'unselected.tgz')).toBe(true);
  const bytes = view.readSmallReceipt('evidence/build.receipt.json', 1024);
  expect(bytes.equals(f.original)).toBe(true); bytes.fill(0);
  expect(view.readSmallReceipt('evidence/build.receipt.json', 1024).equals(f.original)).toBe(true);
  expect(() => view.readSmallReceipt('evidence/build.raw.log', 1024)).toThrow('selected bounded');
  expect(() => view.readSmallReceipt('unselected.tgz', 1024)).toThrow('selected bounded');
  expect(() => view.readSmallReceipt('evidence/build.receipt.json', 1)).toThrow('selected bounded');
  expect(() => view.readSmallReceipt('evidence/build.receipt.json', 1024 ** 2 + 1)).toThrow('selected bounded');
});
test('rejects fake unselected inventory even when every selected original still matches', async () => {
  const f = fixture(); f.inventory.members.find((row: any) => row.path === 'unselected.tgz').sha256 = 'f'.repeat(64);
  await expect(collectModulePhaseOriginals(f)).rejects.toThrow('complete actual inventory');
});
test('rejects incorrect raw SHA reference without copying raw', async () => {
  const f = fixture(producer => { producer.phases[0].raw.sha256 = 'f'.repeat(64); });
  await expect(collectModulePhaseOriginals(f)).rejects.toThrow('reference mismatch');
});
test('rejects missing member, unknown receipt layout and duplicate phases', async () => {
  const missing = fixture(); missing.inventory.members = missing.inventory.members.filter((row: any) => row.path !== 'evidence/build.receipt.json');
  await expect(collectModulePhaseOriginals(missing)).rejects.toThrow('unique ordinary');
  const unknown = fixture(producer => { producer.phases[0].receipt.path = 'unselected.tgz'; });
  await expect(collectModulePhaseOriginals(unknown)).rejects.toThrow('reference mismatch');
  const duplicate = fixture(producer => { producer.phases.push(producer.phases[0]); });
  await expect(collectModulePhaseOriginals(duplicate)).rejects.toThrow('unique fixed phase');
});
test('rejects malformed JSON, ZIP hash changes and caller producer substitutions', async () => {
  const bad = fixture(() => {}, 'not JSON'); await expect(collectModulePhaseOriginals(bad)).rejects.toThrow();
  const changed = fixture(); changed.archiveSha256 = 'f'.repeat(64); await expect(collectModulePhaseOriginals(changed)).rejects.toThrow('inspection failed');
  const fake = fixture(); fake.producer.unobserved = true; await expect(collectModulePhaseOriginals(fake)).rejects.toThrow('producer differs');
});

test('rejects receipt and phase-count budgets before projecting claimed originals', async () => {
  const oversized = fixture(); oversized.inventory.members.find((row: any) => row.path === 'producer.receipt.json').bytes = 1024 ** 2 + 1;
  await expect(collectModulePhaseOriginals(oversized)).rejects.toThrow('projection bound');
  const empty = fixture(producer => { producer.phases = []; });
  await expect(collectModulePhaseOriginals(empty)).rejects.toThrow('bounded nonempty');
  const tooMany = fixture(producer => { producer.phases = Array.from({ length: 65 }, (_, i) => ({ name: 'phase-' + i })); });
  await expect(collectModulePhaseOriginals(tooMany)).rejects.toThrow('bounded nonempty');
  const total = fixture(); total.producer.phases = [];
  for (let i = 0; i < 8; i++) {
    const name = 'extra-' + i;
    const receipt = { path: `evidence/${name}.receipt.json`, bytes: 1024 ** 2, sha256: 'f'.repeat(64), kind: 'file', mode: 0o600 };
    const raw = { path: `evidence/${name}.raw.log`, bytes: 0, sha256: hash(Buffer.alloc(0)), kind: 'file', mode: 0o600 };
    total.inventory.members.push(receipt, raw); total.producer.phases.push({ name, receipt, raw });
  }
  await expect(collectModulePhaseOriginals(total)).rejects.toThrow('projection bound');
});
