import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AFS_VERIFIER_PATCH_ORIGINALS, applyVerifierUnifiedPatch, inspectAfsVerifierPatchedPackages, projectReviewedInstalledPackage } from '../../scripts/lib/independent-admission/afs-verifier-patch-originals';
import { inspectRegistryLegalArchive, registryLegalLockEntries, VERIFIER_REGISTRY_ORIGINAL_SRI } from '../../scripts/lib/independent-admission/legal-registry-originals';
const { inspectTarballBuffer } = createRequire(import.meta.url)('../../scripts/workspace-package-payload.cjs');

it('projects the real reviewed oidc patch once and rejects duplicate or changed upstream bytes', () => {
  const patch = readFileSync(path.resolve(__dirname, '../../patches/oidc-provider@9.5.1.patch'));
  const lines = patch.toString().trimEnd().split('\n'), header = lines.findIndex(line => line.startsWith('@@'));
  const oldStart = Number(/^@@ -(\d+)/u.exec(lines[header]!)![1]);
  const before = lines.slice(header + 1).filter(line => !line.startsWith('+')).map(line => line.slice(1));
  const original = Buffer.from([...Array.from({length: oldStart - 1}, (_, index) => '// upstream line ' + index), ...before].join('\n') + '\n');
  const name = 'lib/shared/session.js', projected = applyVerifierUnifiedPatch(new Map([[name, original]]), patch).get(name)!;
  expect(projected.toString()).toContain("ctx.response.set('set-cookie', setCookie);");
  expect(() => applyVerifierUnifiedPatch(new Map([[name, projected]]), patch)).toThrow('exact upstream preimage differs');
  expect(() => applyVerifierUnifiedPatch(new Map([[name, Buffer.from(original.toString().replace('/* eslint-enable */', '/* changed upstream */'))]]), patch)).toThrow('exact upstream preimage differs');
});

it('rejects escaping paths, fuzzy coordinates, and binary or unsupported records', () => {
  const source = new Map([['file', Buffer.from('one\ntwo\n')]]);
  const patch = '--- a/file\n+++ b/file\n@@ -1,1 +1,1 @@\n-one\n+changed\n';
  expect(applyVerifierUnifiedPatch(source, Buffer.from(patch)).get('file')!.toString()).toBe('changed\ntwo\n');
  expect(() => applyVerifierUnifiedPatch(source, Buffer.from(patch.replaceAll('a/file', 'a/../file').replaceAll('b/file', 'b/../file')))).toThrow('canonical unique');
  expect(() => applyVerifierUnifiedPatch(source, Buffer.from(patch.replace('-1,1', '-2,1')))).toThrow('exact upstream preimage');
  expect(() => applyVerifierUnifiedPatch(source, Buffer.from(patch + 'GIT binary patch\n'))).toThrow('unsupported patch record');
});

it('never accepts serialized source or registry approvals as patch authority', () => {
  const actual = inspectAfsVerifierPatchedPackages({source: {sourceSha: 'a'.repeat(40), readTracked: () => Buffer.from('fabricated')}, originals: [{name: 'jose', version: '5.0.0', verified: true}], packages: [{name: 'jose', version: '5.0.0', path: 'node_modules/jose', logicalPaths: ['node_modules/jose']}], files: []});
  expect(actual.verified).toBe(false);
  expect(actual.pending).toContain('AFS verifier patch: immutable private source required');
});

it('supports every hunk and file in all three real Bun patch originals', () => {
  for (const filename of ['oidc-provider@9.5.1.patch', '@undefineds.co%2Fdrizzle-solid@0.3.25.patch', '@solid%2Fcommunity-server@8.0.0-alpha.1.patch']) {
    const patch = readFileSync(path.resolve(__dirname, '../../patches', filename)), files = new Map<string, string[]>();
    let name = '', at = 0, inHunk = false, previous = ''; const noNewline = new Set<string>();
    for (const line of patch.toString().split('\n')) {
      if (line.startsWith('--- a/')) {name = line.slice(6); files.set(name, []); inHunk = false;}
      else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++ ')) inHunk = false;
      else if (line.startsWith('@@ ')) {at = Number(/^@@ -(\d+)/u.exec(line)![1]) - 1; inHunk = true;}
      else if (line === '\\ No newline at end of file') {if (previous !== '+') noNewline.add(name);}
      else if (inHunk && (line.startsWith(' ') || line.startsWith('-'))) {previous = line[0]!;const lines = files.get(name)!; if (lines[at] !== undefined) expect(lines[at]).toBe(line.slice(1)); lines[at++] = line.slice(1);}
      else if (inHunk && line.startsWith('+')) previous = '+';
    }
    const originals = new Map([...files].map(([name, lines]) => [name, Buffer.from(Array.from({length: lines.length}, (_, index) => lines[index] ?? '// unchanged upstream ' + index).join('\n') + (noNewline.has(name) ? '' : '\n'))]));
    const actual = applyVerifierUnifiedPatch(originals, patch);
    expect(actual.size).toBe(files.size);
    expect(() => applyVerifierUnifiedPatch(actual, patch)).toThrow();
  }
});

it('shared selected projection still requires actual private source and sole registry capability',()=>{
 expect(()=>projectReviewedInstalledPackage({source:{sourceSha:'a'.repeat(40)},original:{name:'negotiate',version:'1.0.1',verified:true},logicalPaths:['node_modules/negotiate']})).toThrow('immutable private source required');
});

const DRIZZLE_25 = 'patches/@undefineds.co%2Fdrizzle-solid@0.3.25.patch';
const DRIZZLE_26 = 'patches/@undefineds.co%2Fdrizzle-solid@0.3.26.patch';
const DRIZZLE_26_SRI = 'sha512-x51lhiVpNmLcky4G66pF32WdR9vRfSse9ZufKe3CmD+5/Fi4L7f6x75E8V4SokR9AHUNTYCbccldeTtxHRSkqw==';
const INSTALLED_ROOT = path.resolve(__dirname, '../../node_modules/@undefineds.co/drizzle-solid');
// Actual published 0.3.26 preimage, copied byte-for-byte from the publication
// worktree (.test-data is gitignored, so absence skips rather than asserts).
const PUBLISHED = path.resolve(__dirname, '../../.test-data/orm26-publication');
const REPORTED_TAR = path.join(PUBLISHED, 'published-0.3.26.tgz');
const receiptPath = path.join(PUBLISHED, 'publication-receipt-0.3.26.json');
const receipt = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : undefined;
const archive = existsSync(REPORTED_TAR) ? readFileSync(REPORTED_TAR) : undefined;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

it('keeps 0.3.25 historical while registering 0.3.26 at its own path', () => {
  expect(AFS_VERIFIER_PATCH_ORIGINALS['@undefineds.co/drizzle-solid@0.3.25']).toEqual([DRIZZLE_25, '15917daa88260327bb30d5da25d9db7efb0fd3386c7f0494102fa780ac870789']);
  expect(AFS_VERIFIER_PATCH_ORIGINALS['@undefineds.co/drizzle-solid@0.3.26']).toEqual([DRIZZLE_26, '15917daa88260327bb30d5da25d9db7efb0fd3386c7f0494102fa780ac870789']);
  expect(sha256(readFileSync(path.resolve(__dirname, '../../', DRIZZLE_25)))).toBe('15917daa88260327bb30d5da25d9db7efb0fd3386c7f0494102fa780ac870789');
  expect(sha256(readFileSync(path.resolve(__dirname, '../../', DRIZZLE_26)))).toBe('15917daa88260327bb30d5da25d9db7efb0fd3386c7f0494102fa780ac870789');
  // 25 stays a distinct historical SRI; 26 is never a relabelled 25 payload.
  expect(VERIFIER_REGISTRY_ORIGINAL_SRI['@undefineds.co/drizzle-solid@0.3.25']).not.toBe(VERIFIER_REGISTRY_ORIGINAL_SRI['@undefineds.co/drizzle-solid@0.3.26']);
  expect(VERIFIER_REGISTRY_ORIGINAL_SRI['@undefineds.co/drizzle-solid@0.3.26']).toBe(DRIZZLE_26_SRI);
});

// Parsed lazily, inside each test: a skipped suite still executes this callback.
let publication: {tar: Buffer; published: Record<string, any>; members: Map<string, Buffer>; patch: Buffer} | undefined;
const actualPublication = () => publication ??= {
  tar: readFileSync(REPORTED_TAR), published: JSON.parse(readFileSync(receiptPath, 'utf8')),
  members: new Map<string, Buffer>(inspectTarballBuffer(readFileSync(REPORTED_TAR), {expandedBytes: 64 * 1024 ** 2, members: 20000, gnuLongNames: true})
    .entries.filter((row: any) => row.type === 'file').map((row: any) => [row.path.slice(8), Buffer.from(row.content)])),
  patch: readFileSync(path.resolve(__dirname, '../../', DRIZZLE_26)),
};

describe.skipIf(!receipt || !archive)('ORM 0.3.26 narrow registration (actual published tar)', () => {
  const tar = () => actualPublication().tar, published = () => actualPublication().published;
  const members = () => actualPublication().members, patch = () => actualPublication().patch;

  it('resolves the actual tar to the exact published bytes and version', () => {
    expect(tar().length).toBe(610919);
    expect(inspectTarballBuffer(tar(), {expandedBytes: 64 * 1024 ** 2, members: 20000, gnuLongNames: true}).manifest).toMatchObject({
      name: '@undefineds.co/drizzle-solid', version: '0.3.26',
    });
  });

  it('binds the official 0.3.26 publication receipt, SRI and gitHead to the tar bytes', () => {
    expect(published().version).toBe('0.3.26');
    expect(published().integrity).toBe(DRIZZLE_26_SRI);
    expect(VERIFIER_REGISTRY_ORIGINAL_SRI['@undefineds.co/drizzle-solid@0.3.26']).toBe(DRIZZLE_26_SRI);
    expect(published().tarballSha256).toBe(sha256(tar()));
    expect(published().tarballBytes).toBe(tar().length);
    const inspected = inspectRegistryLegalArchive({name: '@undefineds.co/drizzle-solid', version: '0.3.26', integrity: DRIZZLE_26_SRI}, Buffer.from(JSON.stringify({
      name: '@undefineds.co/drizzle-solid', version: '0.3.26', gitHead: published().gitHead, dist: {integrity: DRIZZLE_26_SRI, tarball: 'https://registry.npmjs.org/@undefineds.co/drizzle-solid/-/drizzle-solid-0.3.26.tgz'},
    })), tar());
    expect(inspected.manifest.version).toBe('0.3.26');
    expect(published().gitHead).toBe('a4fa33cdb827b72ec41c2a7fb1807f3992567e92');
  });

  it('projects the tar preimage exactly once onto the actual installed patched bytes', () => {
    const targets = new Map<string, Buffer>();
    for (const line of patch().toString().split('\n').filter(row => row.startsWith('--- a/'))) targets.set(line.slice(6), members().get(line.slice(6))!);
    expect(targets.size).toBe(24);
    const projected = applyVerifierUnifiedPatch(targets, patch());
    for (const [name, bytes] of projected) {
      expect(bytes.equals(readFileSync(path.join(INSTALLED_ROOT, name)))).toBe(true);
      expect(bytes.equals(targets.get(name)!)).toBe(false);
    }
    // Second application must be rejected: never a fuzzy re-application.
    expect(() => applyVerifierUnifiedPatch(new Map(projected), patch())).toThrow();
    // One changed byte inside a reviewed hunk preimage is an exact-preimage
    // failure; every other target stays genuine so this cannot pass by omission.
    const exactName = 'dist/core/execution/ldp-executor.js', exactText = targets.get(exactName)!.toString();
    const header = /^@@ -(\d+)/mu.exec(patch().toString().slice(patch().toString().indexOf('--- a/' + exactName))!)![1];
    const lineIndex = Number(header) - 1, lines = exactText.split('\n');
    lines[lineIndex] = (lines[lineIndex]![0] === 'x' ? 'y' : 'x') + lines[lineIndex]!.slice(1);
    const drifted = new Map(targets); drifted.set(exactName, Buffer.from(lines.join('\n')));
    expect(() => applyVerifierUnifiedPatch(drifted, patch())).toThrow('exact upstream preimage differs');
    // Whole installed universe: patched targets equal their projection, the rest
    // must still equal the official tar bytes (no unregistered extra changes).
    for (const [name, bytes] of members()) {
      const installed = readFileSync(path.join(INSTALLED_ROOT, name));
      expect(installed.equals(projected.get(name) ?? bytes)).toBe(true);
    }
  });

  it('rejects version, SRI and member tamper instead of accepting an approved original', () => {
    const metadata = (over: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({name: '@undefineds.co/drizzle-solid', version: '0.3.26', dist: {integrity: DRIZZLE_26_SRI}, ...over}));
    const DRIZZLE_25_SRI = 'sha512-hwcEOHJhzyQ+0l9G0lqUxkeTJNeC5Y/Q72S+cF7fkKidCxxX79o9WB9L3Hzk6UvtUfBjxtINyQ1yDv6d3pv1aw==';
    expect(() => inspectRegistryLegalArchive({name: '@undefineds.co/drizzle-solid', version: '0.3.25', integrity: DRIZZLE_26_SRI},
      metadata(), tar())).toThrow('original metadata identity differs');
    expect(() => inspectRegistryLegalArchive({name: '@undefineds.co/drizzle-solid', version: '0.3.26', integrity: DRIZZLE_26_SRI},
      metadata({version: '0.3.25'}), tar())).toThrow('original metadata identity differs');
    expect(() => inspectRegistryLegalArchive({name: '@undefineds.co/drizzle-solid', version: '0.3.26', integrity: DRIZZLE_25_SRI},
      metadata({dist: {integrity: DRIZZLE_25_SRI}}), tar())).toThrow('original archive SRI differs');
    const tampered = Buffer.from(tar()); tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    expect(() => inspectRegistryLegalArchive({name: '@undefineds.co/drizzle-solid', version: '0.3.26', integrity: DRIZZLE_26_SRI}, metadata(), tampered)).toThrow();
    // The live lock binds 0.3.26 to its own published SRI, never the 25 payload.
    const lock = registryLegalLockEntries(readFileSync(path.resolve(__dirname, '../../bun.lock')));
    expect(lock.get('@undefineds.co/drizzle-solid@0.3.26')).toBe(DRIZZLE_26_SRI);
  });

  it('never lets an approval or bypass stand in for the patched projection', () => {
    const actual = projectReviewedInstalledPackage as unknown as (input: any) => any;
    expect(() => actual({source: {sourceSha: 'a'.repeat(40)}, original: {name: '@undefineds.co/drizzle-solid', version: '0.3.26', verified: true}, logicalPaths: ['node_modules/@undefineds.co/drizzle-solid']})).toThrow('immutable private source required');
  });
});
