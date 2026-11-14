import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { observeMacNativeRanges, verifyMacLoaderClosure, type MacNativeRanges } from './macos-native-range';
import type { NativeFile } from '../physical-module-native';

const fail = (reason: string): never => { throw Error('macOS native runtime originals: ' + reason); };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const safe = (name: unknown): name is string => typeof name === 'string' && name.length > 0 && !name.startsWith('/')
  && !/[\\\u0000-\u001f\u007f]/u.test(name) && !name.split('/').some(part => !part || part === '.' || part === '..');
const version = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/u.test(value)) return fail('observed platform version missing');
  const [major, minor, patch = 0] = value.split('.').map(Number);
  if (major > 65535 || minor > 255 || patch > 255) return fail('observed platform version out of range');
  return major * 65536 + minor * 256 + patch;
};

export interface MacRuntimeOriginalInput {
  readonly target: string;
  readonly final: Buffer;
  readonly metadata: Buffer;
  readonly manifest: Buffer;
  /** Must be supplied by the surrounding private immutable Git source view. */
  readonly physicalAbiHeader: Buffer;
  readonly qleverLock: Buffer;
  readonly reviewedSmokeVerifier: Buffer;
  readonly nativeSmokeVerifier: Buffer;
  readonly members: ReadonlyMap<string, MacNativeRanges & { reference: Readonly<NativeFile> }>;
  /** Mechanical callbacks alone never confer origin or product custody. */
  readonly originalInventory: readonly Readonly<NativeFile>[];
  readOriginal(reference: Readonly<NativeFile>, maximumBytes: number): Buffer;
  readonly jobWindow: { startedUTC: string; closedUTC: string };
}

/** Check exact owned stage originals and a real canonical protocol verifier's
 * output. This is one runtime axis, not source/SDK completeness or an issuer. */
export function verifyMacRuntimeOriginals(input: MacRuntimeOriginalInput) {
  const inventory = new Map(input.originalInventory.map(row => [row.path, row]));
  if (inventory.size !== input.originalInventory.length) return fail('duplicate original inventory');
  const read = (reference: Readonly<NativeFile>, maximum = 1024 ** 2): Buffer => {
    if (!reference || !safe(reference.path) || !Number.isSafeInteger(reference.sizeBytes) || reference.sizeBytes < 0
      || reference.sizeBytes > maximum || !isDeepStrictEqual(inventory.get(reference.path), reference) || !/^[a-f0-9]{64}$/u.test(reference.sha256)) return fail('bounded original reference required');
    const bytes = input.readOriginal(reference, maximum);
    if (!Buffer.isBuffer(bytes) || bytes.length !== reference.sizeBytes || hash(bytes) !== reference.sha256) return fail('original bytes changed');
    return bytes;
  };
  const final = JSON.parse(input.final.toString()), metadata = JSON.parse(input.metadata.toString()), manifest = JSON.parse(input.manifest.toString());
  if (!['darwin-arm64', 'darwin-x64'].includes(input.target) || final.schemaVersion !== 1 || final.status !== 'native-build-test-materials'
    || final.releaseAccepted !== false || final.target !== input.target || metadata.schemaVersion !== 1 || metadata.target !== input.target
    || !final.metadata || final.metadata.sha256 !== hash(input.metadata) || final.metadata.sizeBytes !== input.metadata.length
    || !final.runtimeManifest || final.runtimeManifest.sha256 !== hash(input.manifest) || final.runtimeManifest.sizeBytes !== input.manifest.length
    || metadata.record?.sourceSha !== final.sourceSha || !isDeepStrictEqual(metadata.record?.binary, final.binary)) return fail('final/metadata/runtime identity mismatch');
  const defines = [...input.physicalAbiHeader.toString().matchAll(/^\s*#define\s+XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION\s+(\d+)\b/gmu)];
  if (defines.length !== 1) return fail('canonical physical ABI source definition missing');
  const abi = Number(defines[0]![1]), lock = JSON.parse(input.qleverLock.toString());
  if (!Number.isSafeInteger(abi) || abi <= 0 || !/^[a-f0-9]{40}$/u.test(lock.commit) || !/^[a-f0-9]{64}$/u.test(lock.patchSeriesSha256)
    || manifest.schemaVersion !== 1 || manifest.adapterAbiVersion !== abi || manifest.physicalBackendAbiVersion !== abi
    || manifest.qlever?.repository !== lock.repository || manifest.qlever?.commit !== lock.commit
    || manifest.qlever?.patchSeriesSha256 !== lock.patchSeriesSha256 || manifest.build?.platform !== input.target.replace('darwin-', 'macos-')) return fail('canonical physical ABI/QLever source mismatch');
  if (!input.nativeSmokeVerifier.equals(input.reviewedSmokeVerifier)) return fail('executed protocol verifier differs from reviewed immutable source');
  const starts = Date.parse(input.jobWindow.startedUTC), closes = Date.parse(input.jobWindow.closedUTC);
  if (!Number.isFinite(starts) || !Number.isFinite(closes) || closes < starts || !Array.isArray(metadata.stages) || metadata.stages.length > 128) return fail('observed native job window invalid');
  const stages = new Map<string, { command: string[]; raw: Buffer }>();
  let previous = starts;
  for (const stage of metadata.stages) {
    if (!/^[a-z0-9-]+$/u.test(stage?.name) || stages.has(stage.name)
      || stage.receipt?.path !== `stages/${stage.name}.receipt.json` || stage.raw?.path !== `stages/${stage.name}.raw.log`) return fail('exact native stage member required');
    const receipt = JSON.parse(read(stage.receipt).toString());
    if (!stage.raw || !safe(stage.raw.path) || !isDeepStrictEqual(inventory.get(stage.raw.path), stage.raw)
      || !Number.isSafeInteger(stage.raw.sizeBytes) || stage.raw.sizeBytes < 0 || stage.raw.sizeBytes > 128 * 1024 ** 2) return fail('registered closed raw original required');
    const raw = stage.name === 'native-test' ? read(stage.raw) : Buffer.alloc(0);
    const began = Date.parse(receipt.startedUTC), ended = Date.parse(receipt.closedUTC);
    if (receipt.actualWait !== true || receipt.exit !== 0 || receipt.signal !== null || receipt.ownedGroupAbsentAfterWait !== true
      || receipt.rawClosedBeforeHash !== true || receipt.resourceStop !== null || receipt.supervisorError !== null
      || !Array.isArray(receipt.ownedGroupMembers) || receipt.ownedGroupMembers.length
      || !Array.isArray(receipt.cleanupErrors) || receipt.cleanupErrors.length || receipt.rawSHA256 !== stage.raw.sha256
      || !Array.isArray(receipt.command) || !receipt.command.length || receipt.command.some((item: unknown) => typeof item !== 'string')
      || !Number.isFinite(began) || !Number.isFinite(ended) || began < previous || ended < began || ended > closes) return fail('native owned stage command/closure/window mismatch');
    previous = ended; stages.set(stage.name, { command: receipt.command, raw });
  }
  const test = stages.get('native-test');
  if (!test || test.command.length !== 10 || !test.command[0].startsWith('/')
    || !test.command[1].endsWith('/qlever/scripts/verify-local-runtime-artifacts.py') || test.command[2] !== '--prefix'
    || !test.command[3].startsWith('/') || test.command[4] !== '--lock' || !test.command[5].endsWith('/qlever/qlever.lock.json')
    || test.command[6] !== '--build-source' || test.command[7] !== input.target.replace('darwin-', 'macos-')
    || test.command[8] !== '--smoke-database' || !test.command[9].startsWith('/')) return fail('actual canonical protocol smoke command missing');
  const smoke = JSON.parse(test!.raw.toString());
  if (!isDeepStrictEqual(smoke, { manifestSha256: hash(input.manifest), adapterAbiVersion: abi })) return fail('actual canonical protocol smoke raw mismatch');
  const prefix = test!.command[3];
  const records = metadata.loaderMembers;
  if (!Array.isArray(records) || !records.length || records.length !== input.members.size || records.length > 1024
    || !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== input.members.size) return fail('complete actual loader inventory required');
  const observed = new Map<string, ReturnType<typeof observeMacNativeRanges>>();
  for (const record of records) {
    const reference = record?.member, member = reference && input.members.get(reference.path);
    const declared = manifest.artifacts.find((row: any) => row.path === reference?.path);
    if (!member || observed.has(reference.path) || !isDeepStrictEqual(reference, member.reference)
      || !declared || declared.sha256 !== reference.sha256 || declared.size !== reference.sizeBytes) return fail('loader member differs from actual product/manifest');
    observed.set(reference.path, observeMacNativeRanges(member, input.target));
    for (const [field, command] of [['loaderStage', ['otool', '-L']], ['minimumOSStage', ['otool', '-l']], ['signatureStage', ['codesign', '--verify', '--verbose=2']]] as const) {
      const stage = stages.get(record[field]);
      if (!stage || !isDeepStrictEqual(stage.command, [...command, prefix + '/' + reference.path])) return fail('executed loader/signature command differs from actual member');
    }
  }
  const executable = final.binary?.path;
  if (executable !== 'bin/xpod_qlever_local_runtime' || !input.members.has(executable)
    || !isDeepStrictEqual(final.binary, input.members.get(executable)!.reference)) return fail('native executable binding mismatch');
  const toolchain = metadata.record.toolchain;
  const minimumOS = version(toolchain?.minimumOS), sdk = version(toolchain?.sdkVersion), host = version(toolchain?.hostVersion);
  if (host < minimumOS) return fail('observed macOS host cannot load declared minimum');
  verifyMacLoaderClosure({ executable, minimumOS, sdk, members: observed });
  return Object.freeze({ status: 'mechanical-macos-runtime-originals-verified' as const, target: input.target,
    binarySha256: final.binary.sha256, physicalBackendAbiVersion: abi, adapterAbiVersion: abi,
    loaderClosureVerified: true as const, executedCanonicalProtocolVerified: true as const,
    sourceSdkCompletenessVerified: false as const, scope: 'actual owned macOS loader/signature/protocol stages and canonical ABI; source/SDK/origin admission remains separate' as const });
}
