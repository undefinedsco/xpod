/** Focused executable slice: absolute runtime union adapter, private issuer
 * bridging, forged-origin refusal and existing evaluator behavior. This does
 * not claim whole service legal qualification. */
import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { candidateServiceRuntimeArtifactPath, candidateServiceRuntimeLinkTargetPath } from '../../scripts/lib/independent-admission/artifact-collector';
import { inspectCandidateServiceLegalOrigins } from '../../scripts/lib/independent-admission/legal-admission';
import { candidateServiceOriginSnapshot, candidateServiceMaterialSnapshot } from '../../scripts/lib/independent-admission/candidate-service-legal';
import { LegalCoverageLedger } from '../../scripts/lib/independent-admission/legal-coverage';
import { readFileSync } from 'node:fs';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const standard = readFileSync(new URL('../../packages/xpod-cli/licenses/native/declarations/objects/b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5.txt', import.meta.url));
const normative = standard.toString().slice(standard.toString().indexOf('Permission is hereby granted'));
const template = Buffer.from('MIT License\n\nCopyright (c) 2025 Example Authors\n\n' + normative);

test('absolute app/Qlever runtime paths map injectively with no stripping or collision', () => {
  expect(candidateServiceRuntimeArtifactPath('/app/package.json')).toBe('app/package.json');
  expect(candidateServiceRuntimeArtifactPath('/app/src/index.js')).toBe('app/src/index.js');
  expect(candidateServiceRuntimeArtifactPath('/opt/xpod/qlever/package.json')).toBe('opt/xpod/qlever/package.json');
  expect(candidateServiceRuntimeArtifactPath('/opt/xpod/qlever/qlever')).toBe('opt/xpod/qlever/qlever');
  expect(candidateServiceRuntimeArtifactPath('/app/app/package.json')).not.toBe(candidateServiceRuntimeArtifactPath('/app/package.json'));
  for (const bad of ['/srv/other', '/app/../etc/passwd', 'app/package.json', '/app//package.json', '/opt/xpod/qlever/../../x']) {
    expect(() => candidateServiceRuntimeArtifactPath(bad)).toThrow();
  }
});

test('raw symlink targets preserve relative/absolute semantics inside their declared root', () => {
  expect(candidateServiceRuntimeArtifactPath('/app/x') + '|' + candidateServiceRuntimeLinkTargetPath('/app/x', '/app/y')).toBe('app/x|app/y');
  expect(candidateServiceRuntimeLinkTargetPath('/app/src/link', '../shared/file')).toBe('app/shared/file');
  expect(candidateServiceRuntimeLinkTargetPath('/opt/xpod/qlever/bin/link', '../../qlever/x')).toContain('opt/xpod/qlever');
  for (const bad of ['../../etc/passwd', '/opt/xpod/qlever-other/x', '/app/../x', 'a\u0000b', 'a\\b']) {
    expect(() => candidateServiceRuntimeLinkTargetPath('/app/dir/link', bad)).toThrow();
  }
});

test('existing exact-source evaluator covers a real runtime member and reports missing grant/notice', () => {
  const licenseBytes = readFileSync(new URL('../../LICENSE', import.meta.url)), sourceFile = Buffer.from('export const answer = 42;\n');
  const tracked: Record<string, Buffer> = { 'packages/xpod-api/LICENSE': licenseBytes, 'packages/xpod-api/src/entry.ts': sourceFile };
  const source: any = { sourceSha: 'a'.repeat(40), trackedPaths: Object.keys(tracked), readTracked: (name: string) => tracked[name]! };
  const members = [{ path: 'app/package.json', bytes: 2, sha256: hash(Buffer.from('{}')) }, { path: 'app/LICENSE', bytes: licenseBytes.length, sha256: hash(licenseBytes) },
    { path: 'app/src/entry.ts', bytes: sourceFile.length, sha256: hash(sourceFile) }, { path: 'app/src/unmapped.js', bytes: 1, sha256: hash(Buffer.from('x')) }];
  const artifact: any = { members, readMember: (name: string) => Buffer.from('{}') };
  const pending: string[] = [];
  const memberPaths = new Map([['/app/src/entry.ts', 'app/src/entry.ts']]);
  const coverage = inspectCandidateServiceLegalOrigins(artifact, source, [
    { path: '/app/src/entry.ts', kind: 'exact-source', sourcePath: 'packages/xpod-api/src/entry.ts' },
  ], memberPaths, pending, standard);
  expect(coverage.complete).toBe(false);
  expect(coverage.uncovered.map(row => row.path)).toEqual(['app/package.json', 'app/LICENSE', 'app/src/unmapped.js']);
  expect(pending.join(' ')).toContain('Whole app/SDK runtime grant coverage unresolved');
  const covered = new LegalCoverageLedger(members.map(row => ({ ...row, mode: 0o644 })));
  covered.cover('app/src/entry.ts', 'exact-source', 'packages/xpod-api/src/entry.ts');
  expect(covered.report().uncovered.map(row => row.path)).toEqual(['app/package.json', 'app/LICENSE', 'app/src/unmapped.js']);
});

test('service evaluator refuses absent runtime members and reports undelivered private adapters honestly', () => {
  const source: any = { sourceSha: 'a'.repeat(40), trackedPaths: ['LICENSE'], readTracked: () => template };
  const members = [{ path: 'app/index.js', bytes: 1, sha256: hash(Buffer.from('x')) }];
  const artifact: any = { members, readMember: () => Buffer.from('x') };
  expect(() => inspectCandidateServiceLegalOrigins(artifact, source, [{ path: '/app/absent.js', kind: 'exact-source', sourcePath: 'LICENSE' }], new Map([['/app/index.js', 'app/index.js']]), [], standard)).toThrow('not an actual runtime member');
  expect(() => inspectCandidateServiceLegalOrigins(artifact, source, [{ path: 'app/index.js', kind: 'exact-source', sourcePath: 'LICENSE' }], new Map([['app/index.js', 'app/index.js']]), [], standard)).toThrow('absolute service origin');
  const pending: string[] = [];
  const coverage = inspectCandidateServiceLegalOrigins({ ...artifact, members: [...members, { path: 'app/other.js', bytes: 1, sha256: hash(Buffer.from('y')) }] }, source, [
    { path: '/app/index.js', kind: 'installed-projection', originalPath: 'index.js' },
    { path: '/app/other.js', kind: 'workspace-transform', sourcePath: 'LICENSE' },
  ], new Map([['/app/index.js', 'app/index.js'], ['/app/other.js', 'app/other.js']]), pending, standard);
  expect(coverage.complete).toBe(false);
  expect(pending.length).toBeGreaterThan(0);
  expect(pending.join(' ')).not.toContain('verified');
});

test('origins accessor snapshots are frozen records and lookup/list mutation cannot pass', () => {
  const exact = Object.freeze({ path: '/app/src/entry.ts', kind: 'exact-source' as const, sourcePath: 'packages/xpod-api/src/entry.ts' });
  const canonical = new Map<string, typeof exact>([[exact.path, exact]]);
  const frozenList = Object.freeze([exact]);
  const accessor = Object.freeze({ lookup: (name: string) => canonical.get(name), list: () => frozenList });
  const snapshot = candidateServiceOriginSnapshot(accessor);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(snapshot[0]).toMatchObject({ path: exact.path, kind: 'exact-source', sourcePath: exact.sourcePath });
  expect(Object.isFrozen(snapshot[0])).toBe(true);
  expect(accessor.lookup('/app/src/entry.ts')).toBe(exact);
  // Object.freeze(Map) alone does not prevent internal mutation; the accessor
  // must reject a lookup/list disagreement instead of trusting a frozen object.
  const mutable = new Map([[exact.path, exact]]); Object.freeze(mutable);
  mutable.delete(exact.path);
  expect(mutable.size).toBe(0);
  const drifting = Object.freeze({ lookup: () => undefined, list: () => frozenList });
  expect(() => candidateServiceOriginSnapshot(drifting)).toThrow('lookup/list disagree');
  // Array-shaped origins are not the canonical accessor.
  expect(() => candidateServiceOriginSnapshot([exact])).toThrow('lookup/list');
  // Provenance is preserved, never normalized away.
  const installed = Object.freeze({ path: '/app/node_modules/x/index.js', kind: 'installed-projection' as const, originalPath: 'index.js',
    dependency: Object.freeze({ original: {}, name: 'x', version: '1.0.0', sourceRoot: '/app/node_modules/x', archive: Object.freeze({ url: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', bytes: 1, sha256: 'a'.repeat(64) }) }) });
  const installedAccessor = Object.freeze({ lookup: () => installed, list: () => Object.freeze([installed]) });
  expect(candidateServiceOriginSnapshot(installedAccessor)[0]).toMatchObject({ path: installed.path, kind: 'installed-projection', originalPath: 'index.js' });
  expect(() => candidateServiceOriginSnapshot(Object.freeze({ lookup: () => installed, list: () => Object.freeze([{ ...installed, dependency: undefined }]) }))).toThrow();
  // Directory/symlink records are structural and cannot acquire a file origin.
  const structural = Object.freeze({ path: '/app', kind: 'exact-source' as const, sourcePath: 'package.json' });
  expect(candidateServiceOriginSnapshot(Object.freeze({ lookup: () => structural, list: () => Object.freeze([structural]) }))).toHaveLength(1);
});

test('material snapshot requires the deep-frozen reader view, not a capability wrapper', () => {
  const reader = { sourceSha: 'a'.repeat(40), outputs: [], transpiledOutputs: [], dependencyRows: [], trackedSourcePaths: [],
    readDependencyOriginal: () => Buffer.alloc(0), readDependencyOriginalRange: () => Buffer.alloc(0),
    dependencyOriginalIdentity: () => ({ bytes: 0, sha256: 'a'.repeat(64) }), assertCurrent() {} };
  expect(candidateServiceMaterialSnapshot(reader, 'a'.repeat(40)).sourceSha).toBe('a'.repeat(40));
  expect(() => candidateServiceMaterialSnapshot({ sourceSha: 'a'.repeat(40), outputs: [] }, 'a'.repeat(40))).toThrow('reader view');
  expect(() => candidateServiceMaterialSnapshot(reader, 'b'.repeat(40))).toThrow('reader view');
  expect(() => candidateServiceMaterialSnapshot({ ...reader, assertCurrent: undefined }, 'a'.repeat(40))).toThrow('reader view');
  expect(() => candidateServiceMaterialSnapshot({ ...reader, readDependencyOriginal: undefined }, 'a'.repeat(40))).toThrow('reader view');
  let current = 0;
  expect(() => candidateServiceMaterialSnapshot({ ...reader, assertCurrent() { current++; throw Error('revoked'); } }, 'a'.repeat(40))).toThrow('revoked');
  expect(current).toBe(1);
});

test('origin snapshots copy nested archive metadata and detect each live accessor mutation', () => {
  for (const kind of ['installed-projection', 'workspace-transform'] as const) {
    for (const field of ['name', 'version', 'sourceRoot', 'archive.url', 'archive.bytes', 'archive.sha256', 'original']) {
      const original = {}, metadata: any = { original, name: 'x', version: '1.0.0', sourceRoot: '/app/node_modules/x', archive: { url: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', bytes: 7, sha256: 'a'.repeat(64) } };
      const row: any = kind === 'installed-projection'
        ? { path: '/app/x.js', kind, originalPath: 'x.js', dependency: metadata }
        : { path: '/app/x.js', kind, sourcePath: 'src/x.ts', transformation: {}, inputs: [metadata] };
      const stable = { list: () => [row], lookup: () => row };
      const snapshot: any = candidateServiceOriginSnapshot(stable)[0];
      const copied = kind === 'installed-projection' ? snapshot.dependency : snapshot.inputs[0];
      expect(copied.original).toBe(original);
      expect(copied.archive).not.toBe(metadata.archive);
      expect(Object.isFrozen(copied.archive)).toBe(true);
      const mutate = () => {
        if (field === 'original') metadata.original = {};
        else if (field === 'archive.bytes') metadata.archive.bytes++;
        else if (field === 'archive.sha256') metadata.archive.sha256 = 'b'.repeat(64);
        else if (field === 'archive.url') metadata.archive.url = 'https://registry.npmjs.org/x/-/x-2.0.0.tgz';
        else metadata[field] += '-changed';
      };
      expect(() => candidateServiceOriginSnapshot({ list: () => [row], lookup: () => { mutate(); return row; } })).toThrow('lookup/list disagree');
      expect(copied.archive).toEqual({ url: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', bytes: 7, sha256: 'a'.repeat(64) });
      expect(copied.name).toBe('x');
      expect(copied.version).toBe('1.0.0');
      expect(copied.sourceRoot).toBe('/app/node_modules/x');
    }
  }
});
