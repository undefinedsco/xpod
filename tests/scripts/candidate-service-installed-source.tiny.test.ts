import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  inspectCandidateServiceInstalledSource,
  compareCandidateServiceInstalledPackage,
  candidateServiceInstalledSourceView,
  observeCandidateServiceInstalledSource,
} from '../../scripts/lib/independent-admission/candidate-service-installed-source';
import { observeCandidateServiceInstalledOriginal, observeCandidateServiceRegistryOriginal, serviceRegistrySelectedInputView } from '../../scripts/lib/independent-admission/legal-registry-originals';

/**
 * The private runtime artifact capability cannot be forged here: the runtime
 * module's WeakMap issuer requires a full real image/source custody chain. The
 * mechanical inventory below is tested on actual held bytes, and every private
 * lookup/issuance path is proven to refuse fake, copied and caller-supplied
 * shapes before any budget or transport side effect.
 */
const sha = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
const mode = 0o644;

function packageScene() {
  const files = new Map<string, Buffer>([
    ['/app/node_modules/negotiate/package.json', Buffer.from(JSON.stringify({ name: 'negotiate', version: '1.0.1' }))],
    ['/app/node_modules/negotiate/negotiate.js', Buffer.from('module.exports = 1;\n')],
    ['/app/node_modules/@scope.co/pkg/package.json', Buffer.from(JSON.stringify({ name: '@scope.co/pkg', version: '2.0.0' }))],
    ['/app/node_modules/@scope.co/pkg/dist/index.js', Buffer.from('export const inner = 1;\n')],
    ['/app/node_modules/@scope.co/pkg/node_modules/inner/package.json', Buffer.from(JSON.stringify({ name: 'inner', version: '0.1.0' }))],
    ['/app/node_modules/@scope.co/pkg/node_modules/inner/index.js', Buffer.from('module.exports = 2;\n')],
    ['/app/node_modules/orphan/readme.md', Buffer.from('# orphan\n')],
    ['/app/dist/main.js', Buffer.from('export const app = 1;\n')],
  ]);
  const members = [
    ...[...files].map(([path, bytes]) => Object.freeze({ path, type: 'file' as const, mode, bytes: bytes.length, sha256: sha(bytes) })),
    Object.freeze({ path: '/app/node_modules/@scope.co/pkg/node_modules/inner/link', type: 'symlink' as const, mode: 0o777, bytes: 0 }),
    Object.freeze({ path: '/app/node_modules/@scope.co/pkg/dist', type: 'directory' as const, mode: 0o755, bytes: 0 }),
  ];
  const reader = (path: string, offset: number, length: number) => Buffer.from(files.get(path)!.subarray(offset, offset + length));
  return { members, reader, files };
}

test('actual /app/node_modules inventory enumerates scoped and nested package roots and excludes descendant package files', () => {
  const { members, reader } = packageScene();
  let checks = 0;
  const inventory = inspectCandidateServiceInstalledSource({ members, readMemberRange: reader, check: () => checks++ });
  expect(checks).toBeGreaterThan(0);
  const names = inventory.packages.map(row => row.name + '@' + row.version).sort();
  expect(names).toEqual(['@scope.co/pkg@2.0.0', 'inner@0.1.0', 'negotiate@1.0.1']);
  const outer = inventory.packages.find(row => row.name === '@scope.co/pkg')!;
  expect(outer.sourceRoot).toBe('/app/node_modules/@scope.co/pkg');
  expect(outer.logicalPath).toBe('node_modules/@scope.co/pkg');
  expect(outer.members.map(row => row.path)).toEqual(['dist/index.js', 'package.json']);
  const inner = inventory.packages.find(row => row.name === 'inner')!;
  expect(inner.sourceRoot).toBe('/app/node_modules/@scope.co/pkg/node_modules/inner');
  expect(inner.members.map(row => row.path)).toEqual(['index.js', 'package.json']);
  expect(inventory.missing.map(row => row.path + ':' + row.reason)).toEqual([
    '/app/node_modules/@scope.co/pkg/node_modules/inner/link:generated-or-unmapped',
    '/app/node_modules/orphan/readme.md:unowned-node-modules-file',
  ]);
  const bytes = outer.readMemberRange('dist/index.js', 0, 8);
  expect(bytes.equals(Buffer.from('export c'))).toBe(true);
  bytes.fill(0);
  expect(() => outer.readMemberRange('dist/index.js', 0, 65537)).toThrow();
  expect(() => outer.readMemberRange('../escape', 0, 1)).toThrow();
  inventory.assertCurrent();
});

test('unowned nested files, symlinked and unrecognized manifests are explicit and never silently dropped', () => {
  const { members, reader } = packageScene();
  const extra = [
    ...members,
    Object.freeze({ path: '/app/node_modules/@scope.co/pkg/node_modules/loose.js', type: 'file' as const, mode, bytes: 2, sha256: sha(Buffer.from('lo')) }),
    Object.freeze({ path: '/app/node_modules/linked/package.json', type: 'symlink' as const, mode: 0o777, bytes: 0 }),
    Object.freeze({ path: '/app/node_modules/weird/package.json', type: 'file' as const, mode, bytes: 2, sha256: sha(Buffer.from('{}')) }),
    Object.freeze({ path: '/app/node_modules/triple/a/b/package.json', type: 'file' as const, mode, bytes: 2, sha256: sha(Buffer.from('{}')) }),
  ];
  const blanks = new Map([['/app/node_modules/@scope.co/pkg/node_modules/loose.js', Buffer.from('lo')], ['/app/node_modules/weird/package.json', Buffer.from('{}')], ['/app/node_modules/triple/a/b/package.json', Buffer.from('{}')]]);
  const inventory = inspectCandidateServiceInstalledSource({ members: extra, readMemberRange: (path, offset, length) => Buffer.from((blanks.get(path) ?? reader(path, 0, 4096)).subarray(offset, offset + length)) });
  const reasons = new Map(inventory.missing.map(row => [row.path, row.reason]));
  expect(reasons.get('/app/node_modules/@scope.co/pkg/node_modules/loose.js')).toBe('unowned-nested-file');
  expect(reasons.get('/app/node_modules/linked/package.json')).toBe('symlinked-package-root');
  expect(reasons.get('/app/node_modules/weird/package.json')).toBe('unrecognized-package-manifest');
  expect(reasons.get('/app/node_modules/triple/a/b/package.json')).toBe('unrecognized-package-manifest');
  expect(inventory.packages.some(row => row.name === 'linked')).toBe(false);
});

test('every mapped runtime file is compared to the official projection; extras are explicit native/generated', () => {
  const { members, reader } = packageScene();
  const inventory = inspectCandidateServiceInstalledSource({ members, readMemberRange: reader });
  const pkg = inventory.packages.find(row => row.name === 'negotiate')!;
  const expected = new Map(pkg.members.map(row => [row.path, { bytes: row.bytes, sha256: row.sha256 }]));
  const modes = new Map(pkg.members.map(row => [row.path, row.mode]));
  const compared = compareCandidateServiceInstalledPackage({ pkg, expected, modes });
  expect(compared.matched).toBe(2);
  expect(compared.missing).toEqual([]);

  const extraMembers = [...members, Object.freeze({ path: '/app/node_modules/negotiate/build/negotiate.node', type: 'file' as const, mode, bytes: 3, sha256: sha(Buffer.from('abc')) })];
  const withNative = inspectCandidateServiceInstalledSource({ members: extraMembers, readMemberRange: (path, offset, length) => path === '/app/node_modules/negotiate/build/negotiate.node' ? Buffer.from('abc').subarray(offset, offset + length) : reader(path, offset, length) });
  const native = compareCandidateServiceInstalledPackage({ pkg: withNative.packages.find(row => row.name === 'negotiate')!, expected, modes });
  expect(native.missing.map(row => row.reason)).toEqual(['native-artifact-unmapped']);
  expect(native.missing[0]!.path).toBe('/app/node_modules/negotiate/build/negotiate.node');

  const changed = new Map(expected);
  changed.set('negotiate.js', { bytes: expected.get('negotiate.js')!.bytes, sha256: 'f'.repeat(64) });
  expect(() => compareCandidateServiceInstalledPackage({ pkg, expected: changed, modes })).toThrow('official projection');
  changed.set('negotiate.js', expected.get('negotiate.js')!);
  changed.set('missing.js', { bytes: 1, sha256: 'a'.repeat(64) });
  expect(() => compareCandidateServiceInstalledPackage({ pkg, expected: changed, modes })).toThrow('absent from actual runtime');
});

test('private installed view and issuer refuse fake, copied and caller-supplied runtime shapes before any side effect', async () => {
  const originals = {}, source = {}, runtime = { members: [], readMemberRange() { throw Error('must not read'); }, assertCurrent() { throw Error('must not assert'); } };
  let touched = false, budget = { check() { touched = true; }, remainingMs: () => 1, reserveBytes() { touched = true; throw Error('must not reserve'); } };
  try { observeCandidateServiceInstalledSource({ originals, source, runtime, budget }); } catch (error) { expect((error as Error).message).toContain('same issued actual runtime'); }
  await expect(observeCandidateServiceInstalledOriginal({ originals, source, pack: {}, name: 'negotiate', version: '1.0.1', budget, runtime })).rejects.toThrow('same private');
  expect(touched).toBe(false);
  expect(candidateServiceInstalledSourceView({ packages: [], missing: [], assertCurrent() {} }, originals, source, runtime)).toBeUndefined();
  expect(candidateServiceInstalledSourceView({}, originals, source, runtime)).toBeUndefined();
  expect(serviceRegistrySelectedInputView({}, { pack: {}, originals, source })).toBeUndefined();
});
