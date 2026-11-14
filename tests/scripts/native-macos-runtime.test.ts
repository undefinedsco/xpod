import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { verifyMacRuntimeOriginals, type MacRuntimeOriginalInput } from '../../scripts/lib/independent-admission/native-macos-runtime';
import type { NativeFile } from '../../scripts/lib/physical-module-native';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture(): MacRuntimeOriginalInput {
  const bytes = Buffer.alloc(56); bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(2, 12); bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(24, 20);
  bytes.writeUInt32LE(0x32, 32); bytes.writeUInt32LE(24, 36); bytes.writeUInt32LE(1, 40);
  bytes.writeUInt32LE(15 * 65536, 44); bytes.writeUInt32LE(15 * 65536 + 2 * 256, 48);
  const binary: NativeFile = { path: 'bin/xpod_qlever_local_runtime', sha256: hash(bytes), sizeBytes: bytes.length };
  const lock = { repository: 'https://github.com/ad-freiburg/qlever', commit: 'a'.repeat(40), patchSeriesSha256: 'b'.repeat(64) };
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, adapterAbiVersion: 7, physicalBackendAbiVersion: 7,
    qlever: lock, build: { platform: 'macos-arm64' }, artifacts: [{ path: binary.path, size: binary.sizeBytes, sha256: binary.sha256 }] }));
  const originals = new Map<string, Buffer>();
  const put = (name: string, value: Buffer): NativeFile => { originals.set(name, value); return { path: name, sizeBytes: value.length, sha256: hash(value) }; };
  const commands: Record<string, string[]> = {
    'native-test': ['/usr/bin/python3', '/repo/qlever/scripts/verify-local-runtime-artifacts.py', '--prefix', '/work/artifact', '--lock', '/repo/qlever/qlever.lock.json', '--build-source', 'macos-arm64', '--smoke-database', '/work/smoke.sqlite'],
    'loader-0': ['otool', '-L', '/work/artifact/' + binary.path], 'minos-0': ['otool', '-l', '/work/artifact/' + binary.path],
    'codesign-0': ['codesign', '--verify', '--verbose=2', '/work/artifact/' + binary.path],
  };
  const stages = Object.entries(commands).map(([name, command], index) => {
    const raw = put(`stages/${name}.raw.log`, Buffer.from(name === 'native-test' ? JSON.stringify({ manifestSha256: hash(manifest), adapterAbiVersion: 7 }) : 'actual raw observation'));
    const receipt = put(`stages/${name}.receipt.json`, Buffer.from(JSON.stringify({ actualWait: true, exit: 0, signal: null,
      ownedGroupAbsentAfterWait: true, ownedGroupMembers: [], rawClosedBeforeHash: true, resourceStop: null, supervisorError: null, cleanupErrors: [],
      rawSHA256: raw.sha256, command, startedUTC: `2026-10-17T00:00:0${index}.000Z`, closedUTC: `2026-10-17T00:00:0${index}.500Z` })));
    return { name, receipt, raw };
  });
  const metadata = Buffer.from(JSON.stringify({ schemaVersion: 1, target: 'darwin-arm64', record: { sourceSha: 'c'.repeat(40), binary,
    toolchain: { minimumOS: '15.0', sdkVersion: '15.2', hostVersion: '15.7' } }, stages,
    loaderMembers: [{ member: binary, loaderStage: 'loader-0', minimumOSStage: 'minos-0', signatureStage: 'codesign-0' }] }));
  const final = Buffer.from(JSON.stringify({ schemaVersion: 1, status: 'native-build-test-materials', releaseAccepted: false,
    target: 'darwin-arm64', sourceSha: 'c'.repeat(40), binary,
    metadata: { sha256: hash(metadata), sizeBytes: metadata.length }, runtimeManifest: { sha256: hash(manifest), sizeBytes: manifest.length } }));
  return { target: 'darwin-arm64', final, metadata, manifest,
    physicalAbiHeader: Buffer.from('#define XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION 7\n'), qleverLock: Buffer.from(JSON.stringify(lock)),
    reviewedSmokeVerifier: Buffer.from('reviewed canonical protocol verifier'), nativeSmokeVerifier: Buffer.from('reviewed canonical protocol verifier'),
    members: new Map([[binary.path, { reference: binary, sizeBytes: bytes.length, readRange: (offset, length) => bytes.subarray(offset, offset + length) }]]),
    originalInventory: [...originals].map(([path, value]) => ({ path, sizeBytes: value.length, sha256: hash(value) })),
    readOriginal: reference => Buffer.from(originals.get(reference.path)!), jobWindow: { startedUTC: '2026-10-17T00:00:00Z', closedUTC: '2026-10-17T00:01:00Z' } };
}
describe('actual macOS native runtime originals, without authority issuance', () => {
  it('requires the real canonical protocol stage in addition to Mach-O loader closure', () => {
    const result = verifyMacRuntimeOriginals(fixture());
    expect(result.executedCanonicalProtocolVerified).toBe(true);
    expect(result.sourceSdkCompletenessVerified).toBe(false);
  });
  it('rejects header-only and modified canonical verifier claims', () => {
    const wrongAbi = { ...fixture(), physicalAbiHeader: Buffer.from('#define XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION 8\n') };
    expect(() => verifyMacRuntimeOriginals(wrongAbi)).toThrow('canonical physical ABI/QLever source mismatch');
    const changed = { ...fixture(), nativeSmokeVerifier: Buffer.from('prints arbitrary passed JSON') };
    expect(() => verifyMacRuntimeOriginals(changed)).toThrow('executed protocol verifier differs');
  });
  it('rejects the raw native-test stage after its bytes change', () => {
    const changed = fixture(), original = changed.readOriginal;
    changed.readOriginal = ref => ref.path === 'stages/native-test.raw.log' ? Buffer.from('{}') : original(ref, 1024 ** 2);
    expect(() => verifyMacRuntimeOriginals(changed)).toThrow('original bytes changed');
  });
});
