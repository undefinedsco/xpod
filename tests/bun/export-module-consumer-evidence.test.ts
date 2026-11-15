import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { exportModuleConsumerEvidence } from '../../scripts/export-module-consumer-evidence';
mkdirSync(path.resolve('.test-data'), { recursive: true });
const suite = mkdtempSync(path.resolve('.test-data/consumer-evidence-tests-'));
afterAll(() => rmSync(suite, { recursive: true, force: true }));
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
function files(root: string, prefix = ''): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(row => row.isDirectory()
    ? files(path.join(root, row.name), prefix + row.name + '/') : [prefix + row.name]);
}
function fixture(unknown = false, tamper = false) {
  const root = mkdtempSync(path.join(suite, 'case-')), output = path.join(root, 'safe-evidence');
  const results = path.join(root, 'consumer-results'); mkdirSync(results);
  const raw = Buffer.from('closed fixture stdout\n');
  writeFileSync(path.join(results, 'node-cli-install.stdout.raw.log'), tamper ? 'tampered bytes' : raw);
  writeFileSync(path.join(results, 'consumer.stdout.raw.log'), 'private diagnostic stream');
  const record = { label: 'node-cli-install', waitStatus: 'known', rawClosed: true, rawClosedBeforeHash: true, rawEligible: true, ownedGroupAbsent: true,
    raw: [{ path: 'node-cli-install.stdout.raw.log', bytes: raw.length, sha256: hash(raw), sizeIsFinal: true }] };
  writeFileSync(path.join(results, 'result.json'), JSON.stringify({ schemaVersion: 1, processGroupsUnknown: unknown, records: [record], installedVerification: { node: { producerProvenanceVerified: true } } }));
  writeFileSync(path.join(root, 'unlisted.json'), '{"private":"unlisted"}');
  writeFileSync(path.join(root, 'product.tgz'), 'large archive marker');
  writeFileSync(path.join(root, 'artifact.zip'), 'large zip marker');
  mkdirSync(path.join(results, 'node-data')); writeFileSync(path.join(results, 'node-data', 'private.json'), '{}');
  mkdirSync(path.join(results, 'node-provenance')); writeFileSync(path.join(results, 'node-provenance', 'publication.json'), '{}');
  const projection = path.join(root, 'projection-product'); mkdirSync(projection);
  const publication = Buffer.from('{}');
  const materials: Record<string, { archiveMember: string; sha256: string; bytes: number }> = {
    publication: { archiveMember: 'package/provenance/publication.json', sha256: hash(publication), bytes: publication.length },
  };
  function bind(module: 'css' | 'api' = 'css') {
    const producerBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, materials }));
    writeFileSync(path.join(projection, 'producer.receipt.json'), producerBytes);
    const projectionBytes = Buffer.from(JSON.stringify({ producerReceipt: { path: 'producer.receipt.json',
      sha256: hash(producerBytes), bytes: producerBytes.length } }));
    const projectionPath = path.join(projection, 'projection.receipt.json'); writeFileSync(projectionPath, projectionBytes);
    writeFileSync(path.join(root, 'consumer-plan.json'), JSON.stringify({ schemaVersion: 1, sourceSha: 'a'.repeat(40),
      [module + 'Receipt']: { path: projectionPath, sha256: hash(projectionBytes) } }));
  }
  bind();
  return { root, output, raw, materials, bind };

}
test('only explicit bounded evidence is exported, never archives/data/consumer stdout', async () => {
  const f = fixture(); await exportModuleConsumerEvidence(f.root, f.output);
  const names = files(f.output);
  expect(names.some(name => name.endsWith('consumer-plan.json'))).toBe(true);
  expect(names.some(name => name.endsWith('result.json'))).toBe(true);
  expect(names.some(name => name.endsWith('node-cli-install.stdout.raw.log'))).toBe(true);
  expect(names.some(name => /artifact\.zip|product\.tgz|node-data|consumer\.stdout|unlisted\.json/u.test(name))).toBe(false);
});
test('unknown process groups globally suppress raw evidence', async () => {
  const f = fixture(true); await exportModuleConsumerEvidence(f.root, f.output);
  expect(files(f.output).some(name => name.endsWith('.raw.log'))).toBe(false);
  expect(files(f.output).some(name => name.includes('-provenance/'))).toBe(false);
  expect(files(f.output).some(name => name.endsWith('result.json'))).toBe(true);
});
test('tampered raw is never copied or assigned a fabricated matching hash', async () => {
  const f = fixture(false, true);
  try { await exportModuleConsumerEvidence(f.root, f.output); } catch { /* Rejecting the export is also safe. */ }
  if (existsSync(f.output)) {
    const names = files(f.output);
    expect(names.some(name => name.endsWith('node-cli-install.stdout.raw.log'))).toBe(false);
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const text = readFileSync(path.join(f.output, name), 'utf8');
      expect(text.includes(hash(Buffer.from('tampered bytes')))).toBe(false);
    }
  } else expect(existsSync(f.output)).toBe(false);
});

test('symlink raw and symlink provenance are skipped without following', async () => {
  const f = fixture(); const raw = path.join(f.root, 'consumer-results', 'node-cli-install.stdout.raw.log');
  rmSync(raw); symlinkSync(path.join(f.root, 'product.tgz'), raw);
  f.materials.linked = { archiveMember: 'package/provenance/linked.json', sha256: hash(Buffer.from('{}')), bytes: 2 }; f.bind();
  symlinkSync(path.join(f.root, 'consumer-plan.json'), path.join(f.root, 'consumer-results', 'node-provenance', 'linked.json'));
  const manifest = await exportModuleConsumerEvidence(f.root, f.output);
  expect(files(f.output).some(name => name.endsWith('node-cli-install.stdout.raw.log'))).toBe(false);
  expect(files(f.output).some(name => name.endsWith('linked.json'))).toBe(false);
  expect(manifest.skipped.some(row => row.path.endsWith('linked.json') && row.reason === 'unsafe-invalid-or-unbound')).toBe(true);
});
test('verified closed raw and explicitly verified provenance have byte-exact manifest hashes', async () => {
  const f = fixture(); const manifest = await exportModuleConsumerEvidence(f.root, f.output);
  const raw = manifest.files.find(row => row.path.endsWith('node-cli-install.stdout.raw.log'))!;
  expect(raw.sha256).toBe(hash(f.raw)); expect(raw.bytes).toBe(f.raw.length);
  expect(manifest.files.some(row => row.path.endsWith('node-provenance/publication.json'))).toBe(true);
  expect(manifest.originalArchivesExported).toBe(false); expect(manifest.releaseQualified).toBe(false);
});

test('tampered publication is rejected without a newly trusted hash', () => {
  const f = fixture(); const bytes = Buffer.from('{"tampered":true}');
  writeFileSync(path.join(f.root, 'consumer-results/node-provenance/publication.json'), bytes);
  const manifest = exportModuleConsumerEvidence(f.root, f.output);
  expect(manifest.files.some(row => row.path.endsWith('node-provenance/publication.json'))).toBe(false);
  expect(readFileSync(path.join(f.output, 'export.json'), 'utf8').includes(hash(bytes))).toBe(false);
  expect(manifest.skipped.some(row => row.path.endsWith('publication.json') && row.reason === 'unsafe-invalid-or-unbound')).toBe(true);
});
test('API nested terms and native provenance retain exact producer-bound bytes', () => {
  const f = fixture();
  for (const relative of ['terms/index.json', 'native/inngest/index.json']) {
    const bytes = Buffer.from(JSON.stringify({ relative }));
    const target = path.join(f.root, 'consumer-results/node-provenance', relative);
    mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes);
    f.materials[relative] = { archiveMember: 'package/provenance/' + relative, sha256: hash(bytes), bytes: bytes.length };
  }
  f.bind('api'); const manifest = exportModuleConsumerEvidence(f.root, f.output);
  for (const relative of ['terms/index.json', 'native/inngest/index.json']) {
    const row = manifest.files.find(row => row.path === 'consumer-results/node-provenance/' + relative)!;
    expect(row.sha256).toBe(f.materials[relative].sha256); expect(row.bytes).toBe(f.materials[relative].bytes);
  }
});
test('duplicate and escaping producer material references are rejected', () => {
  const f = fixture(); f.materials.duplicate = { ...f.materials.publication };
  f.materials.escape = { ...f.materials.publication, archiveMember: 'package/provenance/../private.json' };
  f.bind(); const manifest = exportModuleConsumerEvidence(f.root, f.output);
  expect(manifest.files.some(row => row.path.includes('-provenance/'))).toBe(false);
  expect(manifest.skipped.filter(row => row.reason === 'material-reference-unverified').length).toBe(3);
});
test('broken producer hash suppresses all provenance', () => {
  const f = fixture(); writeFileSync(path.join(f.root, 'projection-product/producer.receipt.json'), JSON.stringify({ materials: f.materials, changed: true }));
  const manifest = exportModuleConsumerEvidence(f.root, f.output);
  expect(manifest.files.some(row => row.path.includes('-provenance/'))).toBe(false);
  expect(manifest.files.some(row => row.path.endsWith('producer.receipt.json'))).toBe(false);
});
test('broken plan projection hash suppresses all provenance', () => {
  const f = fixture(); writeFileSync(path.join(f.root, 'projection-product/projection.receipt.json'), '{}');
  const manifest = exportModuleConsumerEvidence(f.root, f.output);
  expect(manifest.files.some(row => row.path.includes('-provenance/'))).toBe(false);
});

function driverFixture(module: 'css' | 'api') {
  const f = fixture(); f.bind(module);
  const planFile = path.join(f.root, 'consumer-plan.json');
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  plan[module + 'Archive'] = { integrity: 'sha512-fixture==' }; writeFileSync(planFile, JSON.stringify(plan));
  const resultFile = path.join(f.root, 'consumer-results/result.json');
  const result = JSON.parse(readFileSync(resultFile, 'utf8'));
  const names: string[] = [];
  for (const runtime of ['node', 'bun']) {
    const phases = module === 'css' ? ['install-css', 'css-service'] : ['install-api', 'api-service', 'api-rdf'];
    for (const phase of phases) result.records.push({ label: runtime + '-' + phase, waitStatus: 'known',
      rawClosed: true, rawClosedBeforeHash: true, rawEligible: true, ownedGroupAbsent: true });
    const installed = Buffer.from(JSON.stringify({ name: '@undefineds.co/xpod-' + module + '-darwin-arm64', version: '1.0.0-preview.1' }));
    result.installedVerification[runtime] = { fullInventoryVerified: true, manifestSha256: hash(installed) };
    const jsonFiles: Record<string, Buffer> = {
      'installed-package': installed,
      pointer: Buffer.from(JSON.stringify({ manifestSha256: hash(installed), package: '@undefineds.co/xpod-' + module + '-darwin-arm64', version: '1.0.0-preview.1', integrity: 'sha512-fixture==' })),
    };
    for (const suffix of module === 'css' ? ['discovery'] : ['api-health', 'rdf-api-health']) jsonFiles[suffix] = Buffer.from(JSON.stringify({ healthy: true }));
    for (const [suffix, bytes] of Object.entries(jsonFiles)) {
      const name = runtime + '-' + suffix + '.json'; names.push('consumer-results/' + name);
      writeFileSync(path.join(f.root, 'consumer-results', name), bytes);
    }
  }
  const saveResult = () => writeFileSync(resultFile, JSON.stringify(result)); saveResult();
  return { ...f, result, saveResult, names };
}
for (const module of ['css', 'api'] as const) {
  test(module + ' exports complete exact driver evidence set for both runtimes', () => {
    const f = driverFixture(module); const manifest = exportModuleConsumerEvidence(f.root, f.output);
    for (const name of f.names) {
      const row = manifest.files.find(row => row.path === name)!;
      const bytes = readFileSync(path.join(f.root, name));
      expect(row.sha256).toBe(hash(bytes)); expect(row.bytes).toBe(bytes.length);
      expect(typeof row.phase).toBe('string');
    }
  });
  test(module + ' unknown groups suppress all dedicated driver evidence', () => {
    const f = driverFixture(module); f.result.processGroupsUnknown = true; f.saveResult();
    const manifest = exportModuleConsumerEvidence(f.root, f.output);
    expect(manifest.files.some(row => f.names.includes(row.path))).toBe(false);
  });
  test(module + ' unknown or duplicate phases suppress their dedicated evidence', () => {
    const f = driverFixture(module);
    for (const row of f.result.records) if (row.label.startsWith('node-')) row.waitStatus = 'unknown';
    for (const row of [...f.result.records]) if (row.label.startsWith('bun-')) f.result.records.push({ ...row });
    f.saveResult(); const manifest = exportModuleConsumerEvidence(f.root, f.output);
    expect(manifest.files.some(row => f.names.includes(row.path))).toBe(false);
  });
}
test('tampered installed manifest blocks both manifest and pointer evidence', () => {
  const f = driverFixture('api');
  writeFileSync(path.join(f.root, 'consumer-results/node-installed-package.json'), '{"name":"tampered"}');
  const manifest = exportModuleConsumerEvidence(f.root, f.output);
  expect(manifest.files.some(row => /node-(installed-package|pointer)\.json$/u.test(row.path))).toBe(false);
  expect(manifest.files.some(row => row.path.endsWith('bun-installed-package.json'))).toBe(true);
});
test('missing dedicated probe is recorded as absent rather than exported or implied complete', () => {
  const f = driverFixture('api');
  rmSync(path.join(f.root, 'consumer-results/node-rdf-api-health.json'));
  const manifest = exportModuleConsumerEvidence(f.root, f.output);
  expect(manifest.files.some(row => row.path.endsWith('node-rdf-api-health.json'))).toBe(false);
  expect(manifest.skipped.some(row => row.path.endsWith('node-rdf-api-health.json') && row.reason === 'absent')).toBe(true);
  expect(manifest.files.some(row => row.path.endsWith('bun-rdf-api-health.json'))).toBe(true);
});
for (const field of ['manifestSha256', 'package', 'version', 'integrity']) test('pointer ' + field + ' mismatch is rejected before export', () => {
  const f = driverFixture('css'); const file = path.join(f.root, 'consumer-results/node-pointer.json');
  const pointer = JSON.parse(readFileSync(file, 'utf8')); pointer[field] = 'tampered'; writeFileSync(file, JSON.stringify(pointer));
  const manifest = exportModuleConsumerEvidence(f.root, f.output);
  expect(manifest.files.some(row => row.path.endsWith('node-pointer.json'))).toBe(false);
  expect(manifest.files.some(row => row.path.endsWith('node-installed-package.json'))).toBe(true);
});
test('installed evidence requires full inventory verification and strong manifest hash', () => {
  const f = driverFixture('css');
  f.result.installedVerification.node.fullInventoryVerified = false;
  f.result.installedVerification.bun.manifestSha256 = 'weak'; f.saveResult();
  const manifest = exportModuleConsumerEvidence(f.root, f.output);
  expect(manifest.files.some(row => /-(installed-package|pointer)\.json$/u.test(row.path))).toBe(false);
});
