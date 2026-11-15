import { afterEach, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { collectApiReleaseInput, parseApiPackReceipt, type ApiCollectionInput } from '../../scripts/collect-api-release-input';
import { MODULE_API_VERSION } from '../../packages/xpod-cli/src/module-catalog';

// Tiny physical archives test collection only, never native/legal/release admission.
const roots: string[] = [];
const historicalSha = '25f44885'.padEnd(40, '0');
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  mkdirSync('.test-data/api-input-collector', { recursive: true });
  const root = mkdtempSync(path.resolve('.test-data/api-input-collector/case-')); roots.push(root);
  const stage = path.join(root, 'package'); mkdirSync(stage);
  const bodies: Record<string, string> = { 'entry.mjs': 'export {};\n', 'source/src/api/main.ts': 'export {};\n' };
  const sourceFiles = [{ path: 'src/api/main.ts', bytes: Buffer.byteLength(bodies['source/src/api/main.ts']), sha256: digest(Buffer.from(bodies['source/src/api/main.ts'])), tracked: true }];
  const authority = { sourceCommit: historicalSha, dirty: false, snapshotSHA256: digest(Buffer.from(JSON.stringify(sourceFiles))), scope: 'actual canonical service source closure and original producer/toolchain declarations' };
  bodies['provenance/source-inventory.json'] = JSON.stringify({ schemaVersion: 1, sourceAuthority: authority, files: sourceFiles });
  bodies['provenance/release-status.json'] = JSON.stringify({ schemaVersion: 1, publishReady: false, sourceAuthority: authority });
  bodies['provenance/publication.json'] = JSON.stringify({ schemaVersion: 1, mode: 'preview', version: '0.1.0-preview.1', sourceCommit: null });
  bodies['provenance/terms/index.json'] = JSON.stringify({ schemaVersion: 1, status: 'original-material-collection', legalClearance: false, entries: [] });
  function pack(changes: Record<string, string> = {}, staleInventory = false, options: { omit?: string; manifest?: Record<string, unknown>; receipt?: Record<string, unknown>; bunLog?: boolean } = {}): ApiCollectionInput {
    const actual = { ...bodies, ...changes };
    if (options.omit) { delete actual[options.omit]; rmSync(path.join(stage, options.omit), { force: true }); }
    const files = Object.entries(staleInventory ? bodies : actual).map(([file, body]) => ({ path: file, size: Buffer.byteLength(body), sha256: digest(Buffer.from(body)), mode: 0o644 }));
    for (const [file, body] of Object.entries(actual)) { mkdirSync(path.dirname(path.join(stage, file)), { recursive: true }); writeFileSync(path.join(stage, file), body, { mode: 0o644 }); }
    writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: '@undefineds.co/xpod-api-linux-x64', version: '0.1.0-preview.1', private: true,
      xpodModule: { schemaVersion: 1, id: 'api', cliApiVersion: MODULE_API_VERSION, platform: 'linux', arch: 'x64', entry: 'entry.mjs', files }, ...options.manifest }), { mode: 0o644 });
    const packed = spawnSync('tar', ['-czf', path.join(root, 'api.tgz'), '-C', root, 'package']); if (packed.status !== 0) throw new Error('Fixture pack failed');
    const bytes = readFileSync(path.join(root, 'api.tgz')); const sha256 = digest(bytes);
    writeFileSync(path.join(root, 'pack.json'), (options.bunLog ? '$ bun scripts/pack.ts "stage" "api.tgz"\n' : '') + JSON.stringify({ archive: 'api.tgz', sha256, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), members: files.length + 1, ...options.receipt }) + '\n');
    return { schemaVersion: 1, expectedSourceSha: historicalSha, archive: { path: 'api.tgz', sha256 },
      packReceipt: { path: 'pack.json', sha256: digest(readFileSync(path.join(root, 'pack.json'))) } };
  }
  return { root, stage, pack, bodies };
}
it('collects an archive after stage cleanup while retaining historical source identity and blockers', async () => {
  const f = fixture(); const input = f.pack(); rmSync(f.stage, { recursive: true });
  const before = readFileSync(path.join(f.root, 'api.tgz'));
  const result = await collectApiReleaseInput(input, f.root);
  expect(result.sourceSha).toBe(historicalSha); expect(result.releaseQualified).toBe(false);
  expect(result.blockers).toContain('stage-verifier-unavailable'); expect(result.blockers).toContain('preview-not-publishable');
  expect(result.plannerReceiptDocument.gates).toEqual({});
  expect(result.materials.source.member).toBe('package/provenance/source-inventory.json');
  expect(readFileSync(path.join(f.root, 'api.tgz')).equals(before)).toBe(true);
});
it('binds real stage material files without granting source verifier or legal qualification', async () => {
  const f = fixture(); const result = await collectApiReleaseInput({ ...f.pack(), stageRoot: 'package' }, f.root);
  expect(result.plannerReceiptDocument.gates.source!.path).toBe(path.join(f.stage, 'provenance/release-status.json'));
  expect(result.blockers).toContain('source-stage-verifier-unavailable'); expect(result.status).toBe('blocked');
});
it('rejects expected source substitution with a newer checkout SHA', async () => {
  const f = fixture(); await expect(collectApiReleaseInput({ ...f.pack(), expectedSourceSha: 'e9cb5b5b'.padEnd(40, '0') }, f.root)).rejects.toThrow('source identity');
});
it('rejects archive digest drift and missing original input', async () => {
  const f = fixture(); const input = f.pack(); writeFileSync(path.join(f.root, 'api.tgz'), 'drift');
  await expect(collectApiReleaseInput(input, f.root)).rejects.toThrow('hash mismatch');
  await expect(collectApiReleaseInput({ ...input, archive: { ...input.archive, path: 'missing.tgz' } }, f.root)).rejects.toThrow();
});
it('rejects packed inventory tampering and stage drift', async () => {
  const f = fixture(); await expect(collectApiReleaseInput(f.pack({ 'entry.mjs': 'changed' }, true), f.root)).rejects.toThrow('member inventory');
  const input = f.pack(); writeFileSync(path.join(f.stage, 'entry.mjs'), 'drift');
  await expect(collectApiReleaseInput({ ...input, stageRoot: 'package' }, f.root)).rejects.toThrow('stage inventory');
});
it('rejects source material drift even if outer inventory is updated', async () => {
  const f = fixture(); await expect(collectApiReleaseInput(f.pack({ 'source/src/api/main.ts': 'changed' }), f.root)).rejects.toThrow('original source inventory');
});
it('refuses a current workspace as verifier for a historical archive', async () => {
  const f = fixture(); await expect(collectApiReleaseInput({ ...f.pack(), stageRoot: 'package',
    sourceWorkspace: { root: process.cwd(), build: 'packages/xpod-api/dist' } }, f.root)).rejects.toThrow('historical source workspace');
});
it('reads original Bun command plus producer JSON output without rewriting its receipt', async () => {
  const f = fixture(); const input = f.pack({}, false, { bunLog: true });
  const original = readFileSync(path.join(f.root, 'pack.json'));
  expect((await collectApiReleaseInput(input, f.root)).packReceipt.sha256).toBe(digest(original));
  expect(() => parseApiPackReceipt(Buffer.concat([original, original]))).toThrow('ambiguous');
});
it('rejects pack result SRI and member drift even when receipt reference is rehashed', async () => {
  for (const receipt of [{ integrity: 'sha512-' + 'a'.repeat(86) + '==' }, { members: 1 }]) {
    const f = fixture(); await expect(collectApiReleaseInput(f.pack({}, false, { receipt }), f.root)).rejects.toThrow();
  }
});
it('rejects missing archived materials and terms self-clearance', async () => {
  const f = fixture(); await expect(collectApiReleaseInput(f.pack({}, false, { omit: 'provenance/terms/index.json' }), f.root)).rejects.toThrow('material missing');
  await expect(collectApiReleaseInput(f.pack({ 'provenance/terms/index.json': JSON.stringify({ schemaVersion: 1, status: 'original-material-collection', legalClearance: true, entries: [] }) }), f.root)).rejects.toThrow('terms inventory');
});
it('requires consistent source and release dirty state', async () => {
  const f = fixture(); const release = JSON.parse(f.bodies['provenance/release-status.json']); release.sourceAuthority.dirty = true;
  await expect(collectApiReleaseInput(f.pack({ 'provenance/release-status.json': JSON.stringify(release) }), f.root)).rejects.toThrow('authority mismatch');
});
for (const version of ['1.0.0-01', 'v1.0.0', '1.0.0+build']) {
  it(`uses the planner exact version validator for archived version ${version}`, async () => {
    const f = fixture(); await expect(collectApiReleaseInput(f.pack({}, false, { manifest: { version } }), f.root)).rejects.toThrow('version mismatch');
  });
}
