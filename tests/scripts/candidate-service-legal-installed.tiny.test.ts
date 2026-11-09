/** Narrow installed-projection legal slice. No genuine registry capability can
 * be minted here (live registry acquisition + private pack selected binding are
 * production-only), so the dispatch is exercised for fail-closed behavior and
 * the extracted scoped-grant mechanism is exercised directly. This claims no
 * installed-axis or whole-service qualification. */
import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inspectPhysicalOriginalMemberGrant } from '../../scripts/lib/independent-admission/legal-material-inventory';
import { inspectCandidateServiceLegalOrigins } from '../../scripts/lib/independent-admission/legal-admission';
import { LegalCoverageLedger } from '../../scripts/lib/independent-admission/legal-coverage';

const standard = readFileSync(new URL('../../packages/xpod-cli/licenses/native/declarations/objects/b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5.txt', import.meta.url));
const normative = standard.toString().slice(standard.toString().indexOf('Permission is hereby granted'));
const mit = Buffer.from('MIT License\n\nCopyright (c) 2025 Example Authors\n\n' + normative);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/* A plain byte fixture, deliberately NOT a private original capability: the
 * helper is a pure mechanism, and the registry issuer still owns authority. */
function plainOriginal(files: Record<string, Buffer>, license = 'MIT') {
  const members = Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes), mode: 0o644 }));
  const manifest = Buffer.from(JSON.stringify({ name: 'x', version: '1.0.0', license }));
  members.push({ path: 'package.json', bytes: manifest.length, sha256: sha(manifest), mode: 0o644 });
  const all = new Map([...Object.entries(files), ['package.json', manifest]]);
  return { members, readMember: (name: string) => Buffer.from(all.get(name)!),
    readMemberRange: (name: string, offset: number, length: number) => Buffer.from(all.get(name)!.subarray(offset, offset + length)) };
}

test('extracted scoped-grant mechanism accepts a genuine complete MIT original with retained notice', () => {
  const files = { 'index.js': Buffer.from('module.exports = 1;\n'), 'LICENSE': mit, 'NOTICE': Buffer.from('Example Authors\n') };
  const original = plainOriginal(files);
  const placement = 'app/node_modules/x';
  const archiveMembers = Object.entries(files).map(([path, bytes]) => ({ path: placement + '/' + path, bytes: bytes.length, sha256: sha(bytes), mode: 0o644 }));
  const manifest = Buffer.from(JSON.stringify({ name: 'x', version: '1.0.0', license: 'MIT' }));
  archiveMembers.push({ path: placement + '/package.json', bytes: manifest.length, sha256: sha(manifest), mode: 0o644 });
  const members = new Map(archiveMembers.map(row => [row.path, row]));
  const member = members.get(placement + '/index.js')!;
  const originalMembers = new Map(original.members.map(row => [row.path, row]));
  const declared = 'MIT';
  const pending = inspectPhysicalOriginalMemberGrant({ original, originalMembers, member, relative: 'index.js', placement, members,
    declaredLicense: declared, verifyGrant: (bytes, license) => (license === undefined || license === 'MIT') && require('../../scripts/lib/independent-admission/legal-admission').verifyMitGrantText(bytes, standard),
    declarations: (bytes) => require('../../scripts/lib/independent-admission/legal-admission').explicitLicenseConflicts(bytes) });
  expect(pending).toEqual([]);
});

test('mechanism reports modified, native, changed notice and mode members specifically', () => {
  const files = { 'index.js': Buffer.from('module.exports = 1;\n'), 'LICENSE': mit, 'NOTICE': Buffer.from('Example Authors\n') };
  const original = plainOriginal(files);
  const placement = 'app/node_modules/x';
  const build = (mutate: (rows: any[], map: Map<string, any>) => void) => {
    const rows = Object.entries(files).map(([path, bytes]) => ({ path: placement + '/' + path, bytes: bytes.length, sha256: sha(bytes), mode: 0o644 }));
    const manifest = Buffer.from(JSON.stringify({ name: 'x', version: '1.0.0', license: 'MIT' }));
    rows.push({ path: placement + '/package.json', bytes: manifest.length, sha256: sha(manifest), mode: 0o644 });
    const map = new Map(rows.map(row => [row.path, row])); mutate(rows, map);
    return { rows, map };
  };
  const originalMembers = new Map(original.members.map(row => [row.path, row]));
  const declarations = (bytes: Buffer) => require('../../scripts/lib/independent-admission/legal-admission').explicitLicenseConflicts(bytes);
  const verifyGrant = (bytes: Buffer) => require('../../scripts/lib/independent-admission/legal-admission').verifyMitGrantText(bytes, standard);
  const run = (mutate: (rows: any[], map: Map<string, any>) => void, mode?: number) => {
    const { map } = build(mutate);
    return inspectPhysicalOriginalMemberGrant({ original, originalMembers, member: map.get(placement + '/index.js')!, relative: 'index.js',
      placement, members: map, declaredLicense: 'MIT', verifyGrant, declarations, ...(mode !== undefined ? { mode } : {}) });
  };
  expect(run((_rows, map) => { map.get(placement + '/index.js')!.sha256 = 'f'.repeat(64); })).toEqual(['Modified dependency member requires source derivation: ' + placement + '/index.js']);
  expect(run(() => {}, 0o755)).toEqual(['Runtime member mode differs from official original: ' + placement + '/index.js']);
  expect(run((_rows, map) => { map.get(placement + '/NOTICE')!.sha256 = 'e'.repeat(64); })).toEqual(['Applicable original notice is not retained: ' + placement + '/NOTICE']);
  const native = plainOriginal({ 'index.js': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2]), 'LICENSE': mit });
  expect(inspectPhysicalOriginalMemberGrant({ original: native, originalMembers: new Map(native.members.map(row => [row.path, row])),
    member: { path: placement + '/index.js', bytes: 6, sha256: sha(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2])), mode: 0o644 },
    relative: 'index.js', placement, members: new Map([[placement + '/index.js', { path: placement + '/index.js', bytes: 6, sha256: sha(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2])), mode: 0o644 }]]),
    declaredLicense: 'MIT', verifyGrant, declarations })).toEqual(['Native original requires native grant scope: ' + placement + '/index.js']);
});

function serviceFixture(kind: 'installed-projection' | 'workspace-transform' | 'native-runtime') {
  const licenseBytes = readFileSync(new URL('../../LICENSE', import.meta.url)), sourceFile = Buffer.from('export const x = 1;\n');
  const tracked: Record<string, Buffer> = { LICENSE: licenseBytes, 'packages/xpod-api/src/entry.ts': sourceFile };
  const source: any = { sourceSha: 'a'.repeat(40), trackedPaths: Object.keys(tracked), readTracked: (name: string) => tracked[name]! };
  const members = [{ path: 'app/package.json', bytes: 2, sha256: sha(Buffer.from('{}')) },
    { path: 'app/LICENSE', bytes: licenseBytes.length, sha256: sha(licenseBytes) },
    { path: 'app/node_modules/x/index.js', bytes: 19, sha256: sha(Buffer.from('module.exports = 1;\n')) },
    { path: 'opt/xpod/qlever/lib/runtime.so', bytes: 6, sha256: sha(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2])) }];
  const artifact: any = { members, readMember: () => Buffer.from('{}') };
  const memberPaths = new Map([['/app/node_modules/x/index.js', 'app/node_modules/x/index.js'], ['/opt/xpod/qlever/lib/runtime.so', 'opt/xpod/qlever/lib/runtime.so']]);
  return { source, artifact, memberPaths };
}

test('installed dispatch refuses a structural original object and stays pending', () => {
  const { source, artifact, memberPaths } = serviceFixture('installed-projection');
  const pending: string[] = [];
  const coverage = inspectCandidateServiceLegalOrigins(artifact, source, [{ path: '/app/node_modules/x/index.js', kind: 'installed-projection', originalPath: 'index.js',
    dependency: { original: { readMember: () => mit, members: [] }, name: 'x', version: '1.0.0', sourceRoot: '/app/node_modules/x',
      archive: { url: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', bytes: 1, sha256: 'a'.repeat(64) } } }], memberPaths, pending, mit);
  expect(coverage.complete).toBe(false);
  expect(pending).toContain('Private registry original capability required for installed projection: /app/node_modules/x/index.js');
  expect(pending.join(' ')).not.toContain('verified');
});

test('workspace/native kinds remain specific missing adapters and never gain file coverage', () => {
  const { source, artifact, memberPaths } = serviceFixture('workspace-transform');
  for (const origin of [
    { path: '/app/node_modules/x/index.js', kind: 'workspace-transform' as const, sourcePath: 'packages/xpod-api/src/entry.ts' },
    { path: '/opt/xpod/qlever/lib/runtime.so', kind: 'native-runtime' as const, runtimePath: 'lib/runtime.so' },
  ]) {
    const pending: string[] = [];
    const coverage = inspectCandidateServiceLegalOrigins(artifact, source, [origin], memberPaths, pending, mit);
    expect(coverage.complete).toBe(false);
    expect(pending.join(' ')).toContain(origin.kind === 'workspace-transform' ? 'workspace-transform grant mapping not delivered' : 'Exact private native context and output binding required');
    expect(coverage.entries).toEqual([]);
  }
});

test('installed evaluator keeps absolute app/ vs opt/ mapping distinct and cover requires all files', () => {
  const { source, artifact, memberPaths } = serviceFixture('installed-projection');
  const pending: string[] = [];
  const coverage = inspectCandidateServiceLegalOrigins(artifact, source, [], memberPaths, pending, mit);
  expect(coverage.complete).toBe(false);
  expect(coverage.uncovered.map(row => row.path).sort()).toEqual(['app/LICENSE', 'app/node_modules/x/index.js', 'app/package.json', 'opt/xpod/qlever/lib/runtime.so']);
  // A duplicated absolute origin is rejected, not collapsed across roots.
  expect(() => inspectCandidateServiceLegalOrigins(artifact, source, [
    { path: '/app/node_modules/x/index.js', kind: 'installed-projection', originalPath: 'index.js' },
    { path: '/app/node_modules/x/index.js', kind: 'installed-projection', originalPath: 'index.js' },
  ], memberPaths, [], mit)).toThrow('duplicate absolute service origin');
});

test('pure installed provenance helper enforces canonical metadata URL, archive identity and placement', () => {
  const { inspectCandidateServiceInstalledProvenance } = require('../../scripts/lib/independent-admission/legal-admission');
  const { canonicalServiceRegistryTarball } = require('../../scripts/lib/independent-admission/legal-registry-originals');
  const source = { sourceSha: 'a'.repeat(40) };
  const url = canonicalServiceRegistryTarball('x', '1.0.0');
  const bytes = Buffer.from(JSON.stringify({ name: 'x', version: '1.0.0', dist: { tarball: url, integrity: 'sha512-' + 'A'.repeat(86) + '==' } }));
  const view = { sourceSha: source.sourceSha, name: 'x', version: '1.0.0', archiveBytes: 11, archiveSha256: 'b'.repeat(64), readMetadata: () => bytes };
  const member = { bytes: 19, sha256: sha(Buffer.from('module.exports = 1;\n')), mode: 0o644 };
  const origin: any = { path: '/app/node_modules/x/index.js', kind: 'installed-projection', originalPath: 'index.js',
    dependency: { original: {}, name: 'x', version: '1.0.0', sourceRoot: '/app/node_modules/x', archive: { url, bytes: 11, sha256: 'b'.repeat(64) } } };
  expect(inspectCandidateServiceInstalledProvenance(origin, source, view, member, 0o644, 'app/node_modules/x/index.js')).toEqual([]);
  const changed = (mutate: (value: any) => void) => { const copy = JSON.parse(JSON.stringify(origin)); mutate(copy); return copy; };
  expect(inspectCandidateServiceInstalledProvenance(changed(value => { value.dependency.archive.url = 'https://example.invalid/x.tgz'; }), source, view, member, 0o644, 'app/node_modules/x/index.js'))
    .toContain('Installed archive URL differs from canonical registry metadata: /app/node_modules/x/index.js');
  expect(inspectCandidateServiceInstalledProvenance(origin, { sourceSha: 'c'.repeat(40) }, view, member, 0o644, 'app/node_modules/x/index.js'))
    .toContain('Installed original source/name/version differs from provenance: /app/node_modules/x/index.js');
  expect(inspectCandidateServiceInstalledProvenance(changed(value => { value.dependency.archive.sha256 = 'd'.repeat(64); }), source, view, member, 0o644, 'app/node_modules/x/index.js'))
    .toContain('Installed archive identity differs from official original: /app/node_modules/x/index.js');
  expect(inspectCandidateServiceInstalledProvenance(changed(value => { value.originalPath = 'other.js'; }), source, view, member, 0o644, 'app/node_modules/x/index.js'))
    .toContain('Runtime member/sourceRoot placement differs from provenance: /app/node_modules/x/index.js');
  expect(inspectCandidateServiceInstalledProvenance(origin, source, view, member, undefined, 'app/node_modules/x/index.js'))
    .toContain('Official registry archive mode missing: /app/node_modules/x/index.js');
  expect(inspectCandidateServiceInstalledProvenance(origin, source, { ...view, readMetadata: () => Buffer.from('{}') }, member, 0o644, 'app/node_modules/x/index.js'))
    .toContain('Installed archive URL differs from canonical registry metadata: /app/node_modules/x/index.js');
});
test('whole-service exact source scope uses staged original reader for source and notices',()=>{
 const code=Buffer.from('export const value = 1;\n'),files=new Map([['src/a.ts',code],['LICENSE',mit]]);let reads=0;
 const artifact={members:[{path:'app/a.ts',bytes:code.length,sha256:sha(code)},{path:'app/LICENSE',bytes:mit.length,sha256:sha(mit)}]}as any;
 const source={trackedPaths:[...files.keys()],readTracked(){throw Error('old unbounded Git reader must not run');}}as any,pending:string[]=[];
 const result=inspectCandidateServiceLegalOrigins(artifact,source,[{path:'/app/a.ts',kind:'exact-source',sourcePath:'src/a.ts'},{path:'/app/LICENSE',kind:'exact-source',sourcePath:'LICENSE'}],new Map([['/app/a.ts','app/a.ts'],['/app/LICENSE','app/LICENSE']]),pending,standard,{nativeReadTracked:name=>{reads++;return files.get(name)!;}});
 expect(result.complete).toBe(true);expect(pending).toEqual([]);expect(reads).toBeGreaterThan(2);
});
