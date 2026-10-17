import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { LINUX_QLEVER_REVIEWED_FILES, observeLinuxElfRanges, verifyLinuxQleverRuntimeOriginals, type LinuxQleverRuntimeOriginalInput } from '../../scripts/lib/independent-admission/native-linux-runtime';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function reviewedRecipes(): Map<string, Buffer> {
  // Preserve the exact historical policy under test as production recipes evolve.
  // These bytes do not qualify the current checkout or any real producer run.
  const original = readFileSync(new URL('../fixtures/independent-admission/linux-qlever-reviewed-37b5.json.gz', import.meta.url));
  expect(hash(original)).toBe('e13970add44a5cc96a8c44cc22b51a601795e6b246a44b5fd4edb4f43d48d094');
  const fixture = JSON.parse(gunzipSync(original, { maxOutputLength: 1024 * 1024 }).toString());
  expect(fixture.sourceSha).toBe('37b5f904338af72d5b73f4551a6bf1ebc165af73');
  expect(fixture.files.length).toBe(LINUX_QLEVER_REVIEWED_FILES.length);
  return new Map(LINUX_QLEVER_REVIEWED_FILES.map(row => {
    const matches = fixture.files.filter((file: { path: string }) => file.path === row.path);
    expect(matches.length).toBe(1);
    const bytes = Buffer.from(matches[0].base64, 'base64');
    expect(hash(bytes)).toBe(row.sha256);
    return [row.path, bytes];
  }));
}
function elf(target: string, needed = 'libc.so.6') {
  const bytes = Buffer.alloc(1024), base = 0x400000;
  bytes.set(Buffer.from('7f454c46020101', 'hex')); bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(target === 'linux-x64' ? 62 : 183, 18); bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(64n, 32); bytes.writeUInt16LE(64, 52); bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(3, 56);
  const segment = (i: number, type: number, offset: number, size: number) => { const p = 64 + i * 56; bytes.writeUInt32LE(type, p); bytes.writeBigUInt64LE(BigInt(offset), p + 8); bytes.writeBigUInt64LE(BigInt(base + offset), p + 16); bytes.writeBigUInt64LE(BigInt(size), p + 32); };
  segment(0, 1, 0, bytes.length); segment(1, 2, 0x200, 80);
  const interpreter = target === 'linux-x64' ? '/lib64/ld-linux-x86-64.so.2' : '/lib/ld-linux-aarch64.so.1';
  segment(2, 3, 0x300, interpreter.length + 1); bytes.write(interpreter, 0x300);
  const strings = Buffer.from('\0' + needed + '\0$ORIGIN/../lib\0'); strings.copy(bytes, 0x380);
  for (const [i, [tag, value]] of [[5, base + 0x380], [10, strings.length], [1, 1], [29, needed.length + 2], [0, 0]].entries()) { bytes.writeBigUInt64LE(BigInt(tag!), 0x200 + i * 16); bytes.writeBigUInt64LE(BigInt(value!), 0x208 + i * 16); }
  return bytes;
}
function range(bytes: Buffer) { return { reference: { path: 'bin/xpod_qlever_local_runtime', sizeBytes: bytes.length, sha256: hash(bytes) }, readRange(offset: number, length: number) { if (length > 65536) throw Error('range'); return bytes.subarray(offset, offset + length); } }; }
function fixture(target: string) {
  const files = new Map<string, Buffer>(), put = (name: string, value: unknown) => files.set(name, Buffer.isBuffer(value) ? value : typeof value === 'string' ? Buffer.from(value) : Buffer.from(JSON.stringify(value)));
  const ref = (path: string) => ({ path, bytes: files.get(path)!.length, sha256: hash(files.get(path)!) });
  const reviewedFiles = reviewedRecipes();
  const qleverLock = readFileSync(new URL('../../qlever/qlever.lock.json', import.meta.url)), lock = JSON.parse(qleverLock.toString());
  const physicalAbiHeader = readFileSync(new URL('../../qlever/rdf_protocol/include/xpod_rdf_physical_backend.h', import.meta.url));
  const abi = Number(/#define XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION (\d+)/u.exec(physicalAbiHeader.toString())![1]);
  const binary = elf(target), member = range(binary), suffix = target === 'linux-arm64' ? '-arm64' : '';
  const sdkImage = 'ghcr.io/undefinedsco/xpod-qlever-sdk-module-bookworm' + suffix + '@sha256:' + 'a'.repeat(64), runtimeImage = 'ghcr.io/undefinedsco/xpod-qlever-local-runtime-module-bookworm' + suffix + '@sha256:' + 'b'.repeat(64);
  const images = { sdk: { id: 'sha256:' + 'c'.repeat(64), os: 'linux', architecture: target === 'linux-x64' ? 'amd64' : 'arm64', repoDigests: [sdkImage] }, runtime: { id: 'sha256:' + 'd'.repeat(64), os: 'linux', architecture: target === 'linux-x64' ? 'amd64' : 'arm64', repoDigests: [runtimeImage] } };
  const manifest = { schemaVersion: 1, adapterAbiVersion: abi, physicalBackendAbiVersion: abi, qlever: { repository: lock.repository, commit: lock.commit, patchSeriesSha256: lock.patchSeriesSha256 }, build: { source: 'native-platform-build', platform: target, entrypoint: 'qlever/scripts/prepare-linux-physical-runtime.py' }, artifacts: [{ path: member.reference.path, size: binary.length, sha256: hash(binary) }] };
  put('physical/runtime/bin/xpod_qlever_local_runtime', binary); put('physical/runtime/manifest.json', manifest); put('original/bin/xpod_qlever_local_runtime', binary); put('original/manifest.json', { ...manifest, build: { priorSdkImage: sdkImage } });
  const sdkNames = ['.xpod-build-contract.json', '.xpod-source-manifest', '.xpod-toolchain-identity', 'compile_commands.json', 'CMakeCache.txt'];
  for (const name of sdkNames) put('sdk-build/' + name, 'inert SDK original ' + name);
  put('sdk-profile/dpkg-packages.txt', 'inert actual-package ledger'); put('sdk-profile/Dockerfile', reviewedFiles.get('docker/qlever-runtime-sdk/Dockerfile.module-bookworm')!); put('sdk-profile/runtime.Dockerfile', reviewedFiles.get('docker/qlever-local-runtime/Dockerfile.module-bookworm')!);
  const recipeHashes = Object.fromEntries(['build-module-runtime-sdk.sh', 'build-qlever-runtime-sdk.sh', 'qlever_compiler_profile.py', 'validate-prior-sdk.py', 'run-focused-native-build.sh'].map(name => [name, hash(reviewedFiles.get('qlever/scripts/' + name)!)]));
  const profile = { profile: 'module-bookworm-gcc12', baseImage: 'debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587', glibc: '2.36', machine: target === 'linux-x64' ? 'x86_64' : 'aarch64', lockSha256: hash(qleverLock), recipeHashes, packageLedgerSha256: ref('sdk-profile/dpkg-packages.txt').sha256 };
  put('sdk-build/.xpod-build-contract.json', { schemaVersion: 1, component: 'qlever-runtime-sdk', toolchain: { profile: profile.profile, machine: profile.machine, profileInputs: profile, gcc: 'gcc-12 (Debian) 12.2.0', gxx: 'g++-12 (Debian) 12.2.0', compilerFiles: { c: '1'.repeat(64), cxx: '2'.repeat(64) }, linkerSha256: '3'.repeat(64) }, cmake: { buildType: 'Release', positionIndependentCode: 'ON', flags: { RANGES_NATIVE: 'OFF' } } });
  put('sdk-build/CMakeCache.txt', 'CMAKE_C_COMPILER:FILEPATH=/usr/bin/gcc-12\nCMAKE_CXX_COMPILER:FILEPATH=/usr/bin/g++-12\n');
  put('sdk-profile/inputs.json', profile); put(`qlever-local-runtime-${target}.tar.gz`, 'inert archive parser custody belongs to outer wrapper');
  const tools = { ldd: { path: '/usr/bin/ldd', sha256: '1'.repeat(64) }, patchelf: { path: '/usr/bin/patchelf', sha256: '2'.repeat(64) }, python3: { path: '/usr/bin/python3', sha256: '3'.repeat(64) } };
  const interpreter = target === 'linux-x64' ? '/lib64/ld-linux-x86-64.so.2' : '/lib/ld-linux-aarch64.so.1', glibc = 'ldd (Debian GLIBC 2.36) 2.36';
  const commands = [
    { command: [tools.patchelf.path, '--set-rpath', '$ORIGIN/../lib', '/out/runtime/bin/xpod_qlever_local_runtime'], stdout: '' },
    { command: [tools.ldd.path, '/out/runtime/bin/xpod_qlever_local_runtime'], stdout: `libc.so.6 => /lib/libc.so.6 (0x123)\n${interpreter} (0x456)\n` },
    { command: [tools.ldd.path, '--version'], stdout: glibc + '\n' },
    { command: [tools.python3.path, '/workspace/qlever/scripts/verify-local-runtime-artifacts.py', '--prefix', '/out/runtime', '--lock', '/workspace/qlever/qlever.lock.json', '--build-source', target, '--smoke-database', '/out/abi/runtime-smoke.sqlite'], stdout: JSON.stringify({ manifestSha256: ref('physical/runtime/manifest.json').sha256, adapterAbiVersion: abi }) },
  ].map((row, i) => { put(`physical/abi/${i}.stdout.raw`, row.stdout); put(`physical/abi/${i}.stderr.raw`, ''); return { command: row.command, actualExit: 0, actualWait: true, rawClosed: true, stdoutSHA256: ref(`physical/abi/${i}.stdout.raw`).sha256, stderrSHA256: ref(`physical/abi/${i}.stderr.raw`).sha256 }; });
  put('physical/abi/physical-runtime.receipt.safe.json', { schemaVersion: 1, target, ok: true, failure: null, releaseAccepted: false, originalManifestSHA256: ref('original/manifest.json').sha256, toolInputs: tools, commands, originalBindings: [{ original: '/original/bin/xpod_qlever_local_runtime', path: member.reference.path, originalSHA256: hash(binary), originalBytes: binary.length }], files: [ref('physical/runtime/bin/xpod_qlever_local_runtime'), ref('physical/runtime/manifest.json')].map(row => ({ ...row, path: row.path.slice('physical/runtime/'.length) })) });
  put('physical/abi/system-abi.safe.json', { target, glibc, systemLibraries: [{ name: 'libc.so.6', sha256: '4'.repeat(64) }, { name: interpreter.split('/').pop(), sha256: '5'.repeat(64) }] });
  const sourceSha = 'e'.repeat(40), stages: Record<string, { receiptSha256: string; rawSha256: string }> = {}; let tick = 0;
  const stage = (name: string, command: string[], raw = '') => { put(`stages/${name}.raw.log`, raw); const start = new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(); put(`stages/${name}.receipt.json`, { command, actualWait: true, exit: 0, signal: null, ownedGroupAbsentAfterWait: true, rawClosedBeforeHash: true, resourceStop: null, supervisorError: null, ownedGroupMembers: [], cleanupErrors: [], rawSHA256: ref(`stages/${name}.raw.log`).sha256, startedUTC: start, closedUTC: start }); stages[name] = { receiptSha256: ref(`stages/${name}.receipt.json`).sha256, rawSha256: ref(`stages/${name}.raw.log`).sha256 }; };
  const tracked = ['qlever','docker/qlever-runtime-sdk','docker/qlever-local-runtime','scripts/module-product-targets.ts','scripts/agentfs-native-ci','.dockerignore','.github/workflows/build-qlever-linux-runtime.yml','.github/workflows/publish-qlever-runtime-sdk.yml','.github/workflows/publish-qlever-local-runtime.yml','.github/workflows/resolve-qlever-native-target.yml'];
  stage('source-head', ['git', 'rev-parse', 'HEAD'], sourceSha + '\n');
  for (const name of ['source-clean', 'source-clean-after']) stage(name, ['git','status','--porcelain','--untracked-files=all','--',...tracked]);
  for (const name of ['source-trees', 'source-trees-after']) stage(name, ['git','ls-tree','HEAD','--',...tracked], 'identical trees\n');
  stage('cpu-observation', ['lscpu', '--json'], JSON.stringify({ lscpu: [{ field: 'Architecture:', data: target === 'linux-x64' ? 'x86_64' : 'aarch64' }] }));
  for (const role of ['sdk', 'runtime'] as const) {
    const image = images[role], reference = role === 'sdk' ? sdkImage : runtimeImage, cid = (role === 'sdk' ? '6' : '7').repeat(64);
    stage(role + '-pull', ['docker', 'pull', '--platform', 'linux/' + image.architecture, reference]); stage(role + '-inspect', ['docker','image','inspect','--format','{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}},"repoDigests":{{json .RepoDigests}}}',reference], JSON.stringify(image)); stage(role + '-create', ['docker', 'create', image.id, 'true'], cid + '\n'); stage(role + '-remove', ['docker', 'rm', '-f', cid]); stage(role + '-absent', ['docker', 'ps', '-aq', '--no-trunc', '--filter', 'id=' + cid]);
  }
  const copy = (name: string, role: string, source: string, destination: string, maximum: number) => stage(name, ['/usr/bin/python3', '/workspace/qlever/scripts/produce-linux-runtime-archive.py', '--bounded-copy', (role === 'sdk' ? '6' : '7').repeat(64), source, '/tmp/evidence' + destination, String(maximum)]);
  copy('runtime-copy', 'runtime', '/opt/xpod/qlever', '/original', 384 * 1024 ** 2); copy('sdk-profile-copy', 'sdk', '/opt/qlever-sdk/profile', '/sdk-profile', 32 * 1024 ** 2);
  for (const name of sdkNames) copy('sdk-copy-' + name.toLowerCase().replace(/[^a-z0-9-]/gu, '-').replace(/^-+|-+$/gu, ''), 'sdk', '/opt/qlever-sdk/build/' + name, '/sdk-build/' + name, 256 * 1024 ** 2);
  stage('physical-prepare', ['docker','run','--init','--cidfile','/tmp/evidence/ownership/prepare.cid','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--entrypoint','/usr/bin/python3','--env','LD_PRELOAD=','--env','LD_LIBRARY_PATH=','--env','PYTHONPATH=','--env','PYTHONHOME=','--user','1000:1000','--tmpfs','/tmp:rw,nosuid,noexec,size=128m','--mount','type=bind,src=/tmp/evidence/original,dst=/original,readonly','--mount','type=bind,src=/tmp/evidence/physical,dst=/out','--mount','type=bind,src=/workspace,dst=/workspace,readonly',images.sdk.id,'/workspace/qlever/scripts/prepare-linux-physical-runtime.py','--source','/original','--out','/out/runtime','--evidence','/out/abi','--workspace','/workspace','--target',target,'--original-manifest-sha256',ref('original/manifest.json').sha256]);
  put('ownership/prepare.cid', '8'.repeat(64) + '\n'); stage('prepare-remove', ['docker', 'rm', '-f', '8'.repeat(64)]); stage('prepare-absent', ['docker', 'ps', '-aq', '--no-trunc', '--filter', 'id=' + '8'.repeat(64)]);
  const finish = (): LinuxQleverRuntimeOriginalInput => {
    const final = { schemaVersion: 1, status: 'native-build-test-materials', releaseAccepted: false, target, sourceSha, runId: '1', runAttempt: '1', sdkImage, runtimeImage, images, archive: ref(`qlever-local-runtime-${target}.tar.gz`), files: [...files.keys()].filter(name => name !== 'native-build-materials.json').map(ref), stages, compilerProfile: profile, runtimeBinarySha256: hash(binary), physicalManifestSha256: ref('physical/runtime/manifest.json').sha256, originalManifestSha256: ref('original/manifest.json').sha256, abiReceiptSha256: ref('physical/abi/physical-runtime.receipt.safe.json').sha256 };
    put('native-build-materials.json', final);
    return { target, final: files.get('native-build-materials.json')!, manifest: files.get('physical/runtime/manifest.json')!, qleverLock, physicalAbiHeader, reviewedFiles, members: new Map([[member.reference.path, member]]), originalInventory: [...files.keys()].map(name => ({ path: name, sizeBytes: ref(name).bytes, sha256: ref(name).sha256 })), readOriginal(reference, maximum) { const bytes = files.get(reference.path)!; if (bytes.length > maximum) throw Error('budget'); return Buffer.from(bytes); }, jobWindow: { startedUTC: '2026-01-01T00:00:00Z', closedUTC: '2026-01-01T01:00:00Z' } };
  };
  return { finish, files, put, stages, images, profile, member };
}
for (const target of ['linux-arm64', 'linux-x64']) {
  test(target + ' bounded ELF and complete mechanical originals keep SDK source completeness pending', () => {
    const f = fixture(target), result = verifyLinuxQleverRuntimeOriginals(f.finish());
    expect(result.loaderClosureVerified).toBe(true); expect(result.executedCanonicalProtocolVerified).toBe(true); expect(result.sourceSdkCompletenessVerified).toBe(false); expect(result.pending.length > 0).toBe(true);
  });
  test(target + ' wrong ELF target, changed original and unresolved loader dependencies fail', () => {
    const f = fixture(target), input = f.finish();
    expect(() => observeLinuxElfRanges(range(elf(target === 'linux-x64' ? 'linux-arm64' : 'linux-x64')), target)).toThrow('ELF target');
    f.files.set('sdk-profile/Dockerfile', Buffer.from('changed original'));
    expect(() => verifyLinuxQleverRuntimeOriginals(input)).toThrow('original bytes changed');
    const unsafe = elf(target, '../outside.so'); expect(() => observeLinuxElfRanges(range(unsafe), target)).toThrow('dependency');
  });
}
test('raw protocol output, job attempt window, SDK digest and receipt booleans cannot be substituted', () => {
  const f = fixture('linux-x64'), input = f.finish();
  f.put('physical/abi/3.stdout.raw', JSON.stringify({ status: 'passed', manifestSha256: '0'.repeat(64), adapterAbiVersion: 1 }));
  expect(() => verifyLinuxQleverRuntimeOriginals(input)).toThrow('original bytes changed');
  const g = fixture('linux-x64'), original = g.finish();
  expect(() => verifyLinuxQleverRuntimeOriginals({ ...original, jobWindow: { startedUTC: '2026-02-01T00:00:00Z', closedUTC: '2026-02-01T01:00:00Z' } })).toThrow('window');
  const h = fixture('linux-x64'); h.images.sdk.architecture = 'arm64'; expect(() => verifyLinuxQleverRuntimeOriginals(h.finish())).toThrow('platform');
});

test('self-consistent receipt metadata still cannot replace failed protocol or process execution', () => {
  const f = fixture('linux-x64');
  const physical = JSON.parse(f.files.get('physical/abi/physical-runtime.receipt.safe.json')!.toString());
  f.put('physical/abi/3.stdout.raw', JSON.stringify({ manifestSha256: '0'.repeat(64), adapterAbiVersion: 1 }));
  physical.commands[3].stdoutSHA256 = hash(f.files.get('physical/abi/3.stdout.raw')!);
  f.put('physical/abi/physical-runtime.receipt.safe.json', physical);
  expect(() => verifyLinuxQleverRuntimeOriginals(f.finish())).toThrow('protocol output');
  const g = fixture('linux-arm64'), record = JSON.parse(g.files.get('physical/abi/physical-runtime.receipt.safe.json')!.toString());
  record.commands[3].actualExit = 1; g.put('physical/abi/physical-runtime.receipt.safe.json', record);
  expect(() => verifyLinuxQleverRuntimeOriginals(g.finish())).toThrow('command exit');
  const h = fixture('linux-x64'), receipt = JSON.parse(h.files.get('stages/physical-prepare.receipt.json')!.toString());
  receipt.command[6] = 'host'; h.put('stages/physical-prepare.receipt.json', receipt);
  h.stages['physical-prepare']!.receiptSha256 = hash(h.files.get('stages/physical-prepare.receipt.json')!);
  expect(() => verifyLinuxQleverRuntimeOriginals(h.finish())).toThrow('canonical stage command');
});
