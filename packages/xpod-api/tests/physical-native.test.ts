import { apiTestRepoRoot } from './repo-root';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, copyFileSync, renameSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { verifyPhysicalNativeMaterials, verifyNativeMaterialTarget, physicalNativeInventory, type NativeFile, type NativeMaterialBinding } from '../../../scripts/lib/physical-module-native';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function elf(arm = false) { const b = Buffer.alloc(64); b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]); b.writeUInt16LE(2, 16); b.writeUInt32LE(1, 20); b.writeUInt16LE(arm ? 183 : 62, 18); b.writeUInt16LE(64, 52); return b; }
function mach(arm = false) { const b = Buffer.alloc(32); b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(arm ? 0x0100000c : 0x01000007, 4); b.writeUInt32LE(2, 12); return b; }
function pe(arm = false) { const b = Buffer.alloc(160); b.write('MZ'); b.writeUInt32LE(64, 60); b.write('PE\0\0', 64); b.writeUInt16LE(arm ? 0xaa64 : 0x8664, 68); b.writeUInt16LE(1, 70); b.writeUInt16LE(2, 84); b.writeUInt16LE(0x20b, 88); return b; }
function fat() { const b = Buffer.alloc(112); b.writeUInt32BE(0xcafebabe, 0); b.writeUInt32BE(2, 4); for (let i = 0; i < 2; i++) { const at = 8 + i * 20; b.writeUInt32BE(i ? 0x0100000c : 0x01000007, at); b.writeUInt32BE(48 + i * 32, at + 8); b.writeUInt32BE(32, at + 12); mach(Boolean(i)).copy(b, 48 + i * 32); } return b; }
function fixture() {
  const base = path.resolve('.test-data/api-native-material-tests'); mkdirSync(base, { recursive: true }); const owned = mkdtempSync(path.join(base, 'owned-')); const root = path.join(owned, 'product'), materialsRoot = path.join(owned, 'materials'); mkdirSync(root); mkdirSync(materialsRoot);
  const put = (relative: string, value: string | Buffer | object): NativeFile => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)); const dest = path.join(relative.startsWith('node_modules/') ? root : materialsRoot, relative); mkdirSync(path.dirname(dest), { recursive: true }); writeFileSync(dest, bytes); return { path: relative, sha256: hash(bytes), sizeBytes: bytes.length }; };
  const sourceRoot = 'provenance/native/fixture/source';
  const source = put(sourceRoot + '/source.c', 'controlled source, no native compilation'), terms = put(sourceRoot + '/LICENSE', 'controlled original fixture terms'), compiler = put(sourceRoot + '/compiler.txt', 'controlled compiler evidence, not actual compiler'), patch = put(sourceRoot + '/change.patch', 'controlled patch');
  const relative = (f: NativeFile) => ({ ...f, path: f.path.slice(sourceRoot.length + 1) }); const files = [source, terms, compiler, patch].map(relative);
  const engine = { repository: 'https://example.invalid/controlled-fixture', commit: '1'.repeat(40) }, binary = put('node_modules/fixture/bin/native', elf());
  const kit = put('provenance/native/fixture/source-kit.json', { schemaVersion: 1, status: 'native-source-materials', engine, toolchain: 'controlled-fixture', files });
  const nativeReceipt = put('provenance/native/fixture/native-receipt.json', { schemaVersion: 1, target: 'linux-x64', engine, sourceKitSha256: kit.sha256, helperSha256: binary.sha256, compiler: { toolchain: 'controlled-fixture', compilerSha256: compiler.sha256 }, buildArguments: ['controlled-fixture-not-a-build'], testsPassed: true, stagedVerifiedFilesOnly: true, sourceFiles: files.length });
  const observation = put('provenance/native/fixture/input-observation.json', { schemaVersion: 1, target: 'linux-x64', sourceKitSha256: kit.sha256, helperSha256: binary.sha256, filesBefore: files, filesAfter: files });
  // Actual short subprocesses use the existing native supervisor. Their stdout
  // is controlled evidence; this fixture does not pretend to compile the header.
  const code = `import sys, pathlib\nsys.path.insert(0,sys.argv[1])\nfrom supervise import run_checked_stage\nr=pathlib.Path(sys.argv[2])\nfor name,command in [('observe',[sys.executable,'-c','import pathlib,sys;sys.stdout.buffer.write(pathlib.Path(sys.argv[1]).read_bytes())',str(r/'provenance/native/fixture/input-observation.json')]),('build',[sys.executable,'-c','print("controlled build fixture only")']),('test',[sys.executable,'-c','print("controlled test fixture only")'])]:\n run_checked_stage(name,command,r/'provenance/native/fixture/stages',r,timeout=10,poll_seconds=.01,fresh_bytes=1048576,stop_bytes=524288)\n`;
  const child = spawnSync('python3', ['-c', code, path.join(apiTestRepoRoot,'scripts/agentfs-native-ci'), materialsRoot], { encoding: 'utf8', timeout: 30000 }); assert.equal(child.status, 0, child.stderr);
  const ref = (relative: string): NativeFile => { const bytes = readFileSync(path.join(materialsRoot, relative)); return { path: relative, sha256: hash(bytes), sizeBytes: bytes.length }; };
  const retained = path.join(base, 'closed-receipts', path.basename(owned)); mkdirSync(retained, { recursive: true }); for (const name of ['observe', 'build', 'test']) for (const suffix of ['receipt.json', 'raw.log']) copyFileSync(path.join(materialsRoot, 'provenance/native/fixture/stages', name + '.' + suffix), path.join(retained, name + '.' + suffix));
  const stage = (name: string) => ({ kind: 'local' as const, receipt: ref(`provenance/native/fixture/stages/${name}.receipt.json`), raw: ref(`provenance/native/fixture/stages/${name}.raw.log`) });
  const binding: NativeMaterialBinding = { binary, target: 'linux-x64', sourceRoot, sourceKit: kit, nativeReceipt, terms: [relative(terms)], patches: [relative(patch)], toolchainInputs: [relative(compiler)], compilerBindings: [{ field: 'compilerSha256', file: relative(compiler) }], inputObservation: observation, observationStage: stage('observe'), buildStage: stage('build'), testStage: stage('test') };
  const index = (bindings: NativeMaterialBinding[] = [binding]) => { const ref = put('provenance/native/index.json', { schemaVersion: 1, status: 'native-build-materials', bindings }); const target = path.join(root, ref.path); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, readFileSync(path.join(materialsRoot, ref.path))); return ref; }; index();
  return { owned, root, materialsRoot, put, ref, binding, index }; 
}
test('native format headers validate thin/fat MachO, ELF, PE and portable WASM without execution', () => {
  for (const [bytes, target] of [[elf(), 'linux-x64'], [elf(true), 'linux-arm64'], [mach(), 'darwin-x64'], [mach(true), 'darwin-arm64'], [fat(), 'darwin-universal'], [pe(), 'win32-x64'], [pe(true), 'win32-arm64'], [Buffer.from('0061736d01000000', 'hex'), 'portable-wasm']] as const) { verifyNativeMaterialTarget(bytes, target); assert.throws(() => verifyNativeMaterialTarget(bytes, 'wrong-target'), /target mismatch/u); assert.throws(() => verifyNativeMaterialTarget(bytes.subarray(0, 7), target), /target mismatch|bounds|offset/u); }
  const overlap = fat(); overlap.writeUInt32BE(48, 36); assert.throws(() => verifyNativeMaterialTarget(overlap, 'darwin-universal'), /target mismatch/u);
  const badPE = pe(); badPE.writeUInt32LE(1000, 60); assert.throws(() => verifyNativeMaterialTarget(badPE, 'win32-x64'), /target mismatch/u);
});
test('controlled actual closed raw observations bind binary/source/patch/terms/toolchain, not release readiness', () => {
  const f = fixture(); try { const result = verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }); assert.equal(result.binaries.length, 1); assert.equal(result.status, 'material-integrity-verified'); assert.equal(result.externalAdmission, 'pending'); assert.equal('publishReady' in result, false); const reorder = (ref: NativeFile): NativeFile => ({ sizeBytes: ref.sizeBytes, sha256: ref.sha256, path: ref.path }); f.binding.binary = reorder(f.binding.binary); f.binding.sourceKit = reorder(f.binding.sourceKit); f.binding.terms = f.binding.terms.map(reorder); f.binding.compilerBindings[0].file = reorder(f.binding.compilerBindings[0].file); const receipt = JSON.parse(readFileSync(path.join(f.materialsRoot, f.binding.nativeReceipt.path), 'utf8')); receipt.engine = { commit: receipt.engine.commit, repository: receipt.engine.repository }; f.binding.nativeReceipt = f.put(f.binding.nativeReceipt.path, receipt); f.index(); assert.equal(verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }).binaries.length, 1); } finally { rmSync(f.owned, { recursive: true, force: true }); }
});
test('native inventory rejects omitted/duplicate/unsafe material and actual source mutation', () => {
  const f = fixture(); try {
    f.index([]); assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /uncovered/u);
    f.index([f.binding, f.binding]); assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /Duplicate/u);
    const unsafe = structuredClone(f.binding); unsafe.binary.path = '../outside'; f.index([unsafe]); assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /Unsafe source/u);
    f.index(); f.put(f.binding.sourceRoot + '/extra.c', 'unindexed source'); assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /inventory is incomplete/u); rmSync(path.join(f.materialsRoot, f.binding.sourceRoot, 'extra.c'));
    f.put(f.binding.sourceRoot + '/source.c', 'changed'); assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /bytes\/hash mismatch/u);
  } finally { rmSync(f.owned, { recursive: true, force: true }); }
});
test('native material refuses symlink ancestors including sourceRoot and runtime/index', () => {
  const f = fixture(); try {
    const original = path.join(f.materialsRoot, f.binding.sourceRoot); const moved = path.join(f.materialsRoot, 'preserved-source'); renameSync(original, moved); symlinkSync(moved, original); assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /symlink/u);
    rmSync(original); symlinkSync(moved, path.join(f.materialsRoot, 'provenance/native/alias')); f.binding.sourceRoot = 'provenance/native/alias/subdir'; mkdirSync(path.join(moved, 'subdir')); f.index(); assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /symlink/u);
    symlinkSync(moved, path.join(f.root, 'node_modules/escape')); assert.throws(() => physicalNativeInventory(f.root), /Unsafe native runtime/u);
  } finally { rmSync(f.owned, { recursive: true, force: true }); }
});
test('passed claims fail without original closed raw/build/test/compiler/source observations', () => {
  const f = fixture(); try {
    for (const key of ['actualWait', 'rawClosedBeforeHash', 'ownedGroupAbsentAfterWait'] as const) {
      const original = JSON.parse(readFileSync(path.join(f.materialsRoot, f.binding.buildStage.kind === 'local' ? f.binding.buildStage.receipt.path : ''), 'utf8'));
      const mutated = { ...original, [key]: false }; const ref = f.put('provenance/native/fixture/stages/bad.receipt.json', mutated); const binding = structuredClone(f.binding); binding.buildStage = { kind: 'local', receipt: ref, raw: f.binding.buildStage.raw }; f.index([binding]); assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /not successfully closed/u);
    }
    const binding = structuredClone(f.binding); binding.terms = []; f.index([binding]); assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /role missing/u);
    binding.terms = f.binding.terms; binding.compilerBindings[0].field = 'missingSha256'; f.index([binding]); assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /toolchain binding/u);
    const absent = structuredClone(f.binding); if (absent.buildStage.kind !== 'local') throw new Error('Fixture local stage required'); absent.buildStage.receipt.path = 'provenance/native/fixture/no-receipt.json'; f.index([absent]); assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /ENOENT/u);
    const missingTest = structuredClone(f.binding); missingTest.testStage = missingTest.buildStage; f.index([missingTest]); assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /Distinct native/u);
    const rawTamper = structuredClone(f.binding); const replacedRaw = f.put('provenance/native/fixture/stages/claim.raw.log', 'passed'); rawTamper.buildStage.raw = replacedRaw; f.index([rawTamper]); assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /not successfully closed/u);
    const wrongObservation = structuredClone(f.binding); const value = JSON.parse(readFileSync(path.join(f.materialsRoot, f.binding.inputObservation.path), 'utf8')); value.filesAfter = []; wrongObservation.inputObservation = f.put('provenance/native/fixture/wrong-observation.json', value); f.index([wrongObservation]); assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /before\/after observation/u);
    f.index(); f.put(f.binding.buildStage.raw.path, 'replaced raw'); assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /bytes\/hash mismatch/u);
  } finally { rmSync(f.owned, { recursive: true, force: true }); }
});
test('official immutable run/job/artifact material branch does not require invented local PID fields', () => {
  const f = fixture(); try {
    const sourceCommit = '2'.repeat(40); const archive = f.put('provenance/native/fixture/official.zip', 'controlled ZIP bytes, not an official download');
    const run = f.put('provenance/native/fixture/run.json', { id: 123, status: 'completed', conclusion: 'success', head_sha: sourceCommit });
    const job = f.put('provenance/native/fixture/job.json', { id: 456, run_id: 123, status: 'completed', conclusion: 'success' });
    const artifact = f.put('provenance/native/fixture/artifact.json', { id: 789, expired: false, digest: 'sha256:' + archive.sha256, workflow_run: { id: 123, head_sha: sourceCommit } });
    const binding = structuredClone(f.binding); binding.buildStage = { kind: 'github', sourceCommit, archive, run, job, artifact, raw: f.binding.buildStage.raw }; f.index([binding]); assert.equal(verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }).externalAdmission, 'pending');
    const wrongHead = structuredClone(binding); if (wrongHead.buildStage.kind !== 'github') throw new Error('Fixture official stage required'); wrongHead.buildStage.sourceCommit = '3'.repeat(40); f.index([wrongHead]); assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /Official native/u);
    const wrongArtifact = structuredClone(binding); if (wrongArtifact.buildStage.kind !== 'github') throw new Error('Fixture official stage required'); wrongArtifact.buildStage.artifact = f.put('provenance/native/fixture/wrong-artifact.json', { id: 789, expired: false, digest: 'sha256:' + '0'.repeat(64), workflow_run: { id: 123, head_sha: sourceCommit } }); f.index([wrongArtifact]); assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /Official native/u);
    const badJob = f.put('provenance/native/fixture/failed-job.json', { id: 456, run_id: 123, status: 'completed', conclusion: 'failure' }); binding.buildStage.job = badJob; f.index([binding]); assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /Official native/u);
  } finally { rmSync(f.owned, { recursive: true, force: true }); }
});

test('independent material root is mandatory, disjoint and cannot use a foreign index/root or symlink parent', () => {
  const f = fixture(); try {
    assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: '' }), /Explicit external/u);
    assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.root }), /disjoint/u);
    assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: path.join(f.root, 'provenance') }), /disjoint/u);
    assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.owned }), /disjoint/u);
    const foreign = path.join(f.owned, 'foreign'); mkdirSync(path.join(foreign, 'provenance/native'), { recursive: true }); writeFileSync(path.join(foreign, 'provenance/native/index.json'), '{}');
    assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: foreign }), /bytes\/hash mismatch/u);
    symlinkSync(f.materialsRoot, path.join(f.owned, 'alias'));
    assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: path.join(f.owned, 'alias/provenance') }), /ancestor symlink/u);
    const cross = structuredClone(f.binding); cross.sourceKit = cross.binary; f.index([cross]); assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /outside product/u); cross.sourceKit.path = '../product/node_modules/fixture/bin/native'; f.index([cross]); assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /Unsafe source/u);
  } finally { rmSync(f.owned, { recursive: true, force: true }); }
});
test('inner source-kit digest is exact original JSON bytes, not reserialized content or outer archive digest', () => {
  const f = fixture(); try {
    const indexPath = path.join(f.materialsRoot, 'provenance/native/index.json'); const index = JSON.parse(readFileSync(indexPath, 'utf8')); writeFileSync(indexPath, JSON.stringify(index, null, 2)); assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /bytes\/hash mismatch/u); f.index();
    const original = JSON.parse(readFileSync(path.join(f.materialsRoot, f.binding.sourceKit.path), 'utf8'));
    const changed = f.put(f.binding.sourceKit.path, JSON.stringify(original, null, 2));
    assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /bytes\/hash mismatch/u);
    f.binding.sourceKit = changed; f.index(); assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /receipt source\/input\/binary mismatch/u);
  } finally { rmSync(f.owned, { recursive: true, force: true }); }
});
test('expanded source, raw receipts and independent artifacts do not enter runtime member inventory', () => {
  const f = fixture(); try {
    const originals = readdirSync(path.join(f.root, 'provenance/native')); assert.deepEqual(originals, ['index.json']);
    assert.equal(physicalNativeInventory(f.root).length, 1); assert.equal(verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }).externalAdmission, 'pending');
    const accidental = path.join(f.root, f.binding.sourceRoot); mkdirSync(accidental, { recursive: true }); writeFileSync(path.join(accidental, 'source.c'), 'accidental expanded source');
    assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /Expanded native/u); rmSync(path.join(f.root, 'provenance/native/fixture'), { recursive: true });
    const rawPath = 'provenance/raw-copy.log'; const copyBinding = structuredClone(f.binding); const raw = f.put(rawPath, 'controlled closed raw'); if (copyBinding.buildStage.kind !== 'local') throw new Error('Fixture local stage required'); copyBinding.buildStage.raw = raw; f.index([copyBinding]); writeFileSync(path.join(f.root, rawPath), 'controlled closed raw');
    assert.throws(() => verifyPhysicalNativeMaterials(f.root, { materialsRoot: f.materialsRoot }), /outside product/u);
  } finally { rmSync(f.owned, { recursive: true, force: true }); }
});
