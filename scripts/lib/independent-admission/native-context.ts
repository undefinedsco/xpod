import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { verifyPhysicalNativeMaterials } from '../physical-module-native';
import { collectedArtifactView } from './artifact-collector';
import type { CollectedArtifactCapability, NativeMaterialCapability, NativeMaterialView } from './artifact-contract';

const issued = new WeakMap<object, () => NativeMaterialView>();
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const hashFile = (file: string): string => {
  const fd = openSync(file, 'r'), digest = createHash('sha256'), buffer = Buffer.alloc(65536);
  try { let count: number; while ((count = readSync(fd, buffer, 0, buffer.length, null)) !== 0) digest.update(buffer.subarray(0, count)); }
  finally { closeSync(fd); }
  return digest.digest('hex');
};
const fail = (message: string): never => { throw new Error('Independent native context: ' + message); };

/** Revalidates roots on every lookup; a stale path-bearing capability cannot
 * bless subsequent filesystem changes. This is material integrity only. */
export function nativeMaterialView(value: unknown): NativeMaterialView | undefined {
  return value !== null && typeof value === 'object' ? issued.get(value)?.() : undefined;
}

export function collectNativeMaterialContext(artifact: CollectedArtifactCapability, input: {
  productRoot: string; materialsRoot: string; indexPath?: string;
}): NativeMaterialCapability {
  const view = collectedArtifactView(artifact);
  if (!view) return fail('collected artifact capability required');
  if (!view.identity.target) return fail('collected platform artifact required');
  const productRoot = realpathSync(input.productRoot), materialsRoot = realpathSync(input.materialsRoot);
  if (productRoot !== path.resolve(input.productRoot) || materialsRoot !== path.resolve(input.materialsRoot)) fail('canonical native roots required');
  const indexPath = input.indexPath ?? 'provenance/native/index.json';
  const indexed = view.members.find(row => row.path === indexPath);
  if (!indexed) return fail('native index absent from collected product');
  const verify = (): NativeMaterialView => {
    const expected = new Map(view.members.map(row => [row.path, row]));
    const directories = new Set<string>();
    for (const name of expected.keys()) {
      let parent = path.posix.dirname(name);
      while (parent !== '.') { directories.add(parent); parent = path.posix.dirname(parent); }
    }
    const seen = new Set<string>();
    const walk = (relative = ''): void => {
      const directory = path.join(productRoot, relative);
      if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) fail('product root/link changed');
      for (const name of readdirSync(directory)) {
        const item = relative ? relative + '/' + name : name, file = path.join(productRoot, item), stat = lstatSync(file);
        if (stat.isSymbolicLink()) fail('native product link rejected');
        if (stat.isDirectory()) {
          if (!directories.has(item)) fail('unbound native product directory');
          walk(item); continue;
        }
        const member = expected.get(item);
        if (!stat.isFile() || !member || stat.size !== member.bytes || (stat.mode & 0o7777) !== member.mode
          || hashFile(file) !== member.sha256) fail('native product differs from collected archive');
        seen.add(item);
      }
    };
    walk();
    if (seen.size !== expected.size) fail('native product member missing');
    const result = verifyPhysicalNativeMaterials(productRoot, { materialsRoot, indexPath });
    return Object.freeze({ identity: view.identity, productRoot, materialsRoot, indexPath,
      indexSha256: indexed.sha256, status: result.status, externalAdmission: result.externalAdmission });
  };
  verify();
  const capability = Object.freeze({}) as NativeMaterialCapability;
  issued.set(capability, verify); return capability;
}

export interface ControlledNativeRuntimeView {
  readonly identity: NativeMaterialView['identity'];
  readonly nativeSourceSha: string;
  readonly nativeIndex: Readonly<import('../physical-module-native').NativeMaterialIndex>;
  readonly nativeOriginVerified: true;
  readonly originalStageBindingsVerified: true;
  readonly binaryFormatsVerified: boolean;
  readonly qleverRuntimeAbiVerified: true;
  readonly runtimeAbiScope: 'css-qlever-bundle';
  readonly uncoveredNativeImages: readonly Readonly<import('../physical-module-native').NativeFile>[];
  readonly runtimeAbiVerified: boolean;
  readonly sourceMaterialsVerified: true;
  readonly nativeSourceClosureVerified: false;
  readonly pending: readonly string[];
}
const runtimeIssued = new WeakMap<object, { view: ControlledNativeRuntimeView; validate(): void }>();
export function controlledNativeRuntimeView(value: unknown): ControlledNativeRuntimeView | undefined {
  const entry = value && typeof value === 'object' ? runtimeIssued.get(value) : undefined;
  entry?.validate(); return entry?.view;
}

/** A JSON proposal cannot issue this handle. It requires two independent private
 * custody capabilities and immutable product Git inputs. Prefix translation is
 * the fixed CSS adapter mapping, never a caller supplied path/binding callback. */
export async function collectMacNativeRuntimeContext(input: {
  artifact: CollectedArtifactCapability; nativeOriginals: unknown; source: unknown;
}): Promise<NativeMaterialCapability> {
  const { nativeOriginalsView } = await import('./native-original-collector');
  const { derivedSourceView } = await import('./source-context');
  const { collectedProductOriginal, collectedProductOriginalBinding } = await import('./product-original');
  const { observeRegisteredNativeTar } = await import('./native-tar-observation');
  const { verifyMacRuntimeOriginals } = await import('./native-macos-runtime');
  const product = collectedArtifactView(input.artifact), native = nativeOriginalsView(input.nativeOriginals), source = derivedSourceView(input.source);
  if (!product || !native || !source || source.sourceSha !== product.identity.sourceSha || !product.identity.target
    || !['darwin-arm64', 'darwin-x64'].includes(product.identity.target)
    || native.originFacts.target !== product.identity.target
    || !['.github/workflows/build-qlever-macos-runtime.yml', '.github/workflows/css-module-product.yml'].includes(native.originFacts.workflowPath)) return fail('independent observed macOS originals and exact product/Git capabilities required');
  const packageJson = JSON.parse(product.readMember('package.json', 1024 ** 2).toString());
  if (packageJson.xpodModule?.id !== 'css') return fail('fixed CSS native adapter required');
  const prefix = 'native/qlever/', originalPrefix = 'native-materials/';
  const refs = new Map(native.members.map(row => [row.path, { path: row.path, sha256: row.sha256, sizeBytes: row.bytes }]));
  const read = (relative: string, maximum = 8 * 1024 ** 2): Buffer => {
    const row = refs.get(relative);
    if (!row || row.sizeBytes > maximum) return fail('registered native original required');
    const bytes = native.readOriginal(relative, maximum);
    if (bytes.length !== row.sizeBytes || hash(bytes) !== row.sha256) return fail('native original changed');
    return bytes;
  };
  const bind = (reference: any, base = originalPrefix): string => {
    if (!reference || typeof reference.path !== 'string' || reference.path.startsWith('/') || reference.path.includes('\\')
      || reference.path.split('/').some((part: string) => !part || part === '.' || part === '..')) return fail('native original path invalid');
    const name = base + reference.path, actual = refs.get(name);
    if (!actual || actual.sha256 !== reference.sha256 || actual.sizeBytes !== reference.sizeBytes) return fail('native final reference differs from acquired original');
    return name;
  };
  const finalBytes = read(originalPrefix + 'final.json'), final = JSON.parse(finalBytes.toString());
  if (final.sourceSha !== native.originFacts.sourceSha || String(final.runId) !== String(native.originFacts.runId)
    || String(final.runAttempt) !== String(native.originFacts.runAttempt)) return fail('native original producer run/source differs; cached stages need their actual original origin');
  const metadataName = bind(final.metadata), kitName = bind(final.sourceKit), proposalName = bind(final.bindingProposal);
  const metadataBytes = read(metadataName), metadata = JSON.parse(metadataBytes.toString()), kit = JSON.parse(read(kitName).toString());
  const proposalBytes = read(proposalName), proposal = JSON.parse(proposalBytes.toString());
  if (kit.schemaVersion !== 1 || kit.status !== 'native-source-materials' || !Array.isArray(kit.files) || !kit.files.length || kit.files.length > 20000
    || typeof kit.toolchain !== 'string' || !kit.toolchain || proposal.target !== product.identity.target
    || !isDeepStrictEqual(proposal.binary, final.binary) || proposal.sourceRoot !== 'source-kit'
    || !isDeepStrictEqual(proposal.sourceKit, final.sourceKit) || !isDeepStrictEqual(proposal.nativeReceipt, final.nativeReceipt)
    || !isDeepStrictEqual(proposal.inputObservation, final.inputObservation)) return fail('canonical native source-kit/binding proposal required');
  const sourceArchive = bind(final.sourceArchive), runtimeArchive = bind(final.archive, '');
  const [sourceRows, runtimeRows] = await Promise.all([
    observeRegisteredNativeTar(native, sourceArchive, 'source'), observeRegisteredNativeTar(native, runtimeArchive, 'runtime'),
  ]);
  const same = (await import('node:util')).isDeepStrictEqual;
  const sorted = (rows: readonly any[]) => [...rows].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (!same(sorted(sourceRows), sorted(kit.files))) return fail('complete source-kit tar original objects differ from native source inventory');
  for (const row of sourceRows) {
    if (!row.path.startsWith('workspace/')) continue;
    const tracked = row.path.slice('workspace/'.length);
    const bytes = source.readTracked(tracked);
    if (row.type === 'symlink' || bytes.length !== row.sizeBytes || hash(bytes) !== row.sha256) return fail('native workspace build source differs from immutable product Git source');
  }
  const runtimeMap = new Map(runtimeRows.map((row: any) => [row.path, row]));
  const actualRuntime = product.members.filter(row => row.path.startsWith(prefix));
  if (actualRuntime.length !== runtimeRows.length) return fail('native tar/product runtime member set mismatch');
  for (const row of actualRuntime) {
    const original = runtimeMap.get(row.path.slice(prefix.length));
    if (!original || original.sha256 !== row.sha256 || original.sizeBytes !== row.bytes) return fail('actual native product member differs from original runtime tar');
  }
  const manifestBytes = product.readMember(prefix + 'manifest.json', 1024 ** 2), manifest = JSON.parse(manifestBytes.toString());
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length > 1024) return fail('bounded runtime manifest required');
  const members = new Map<string, import('./macos-native-range').MacNativeRanges & { reference: import('../physical-module-native').NativeFile }>();
  for (const item of manifest.artifacts) {
    const original = collectedProductOriginal(input.artifact, { path: prefix + item.path, sha256: item.sha256, sizeBytes: item.size });
    if (collectedProductOriginalBinding(original)?.artifact !== input.artifact) return fail('private product native original binding required');
    members.set(item.path, { reference: { path: item.path, sha256: item.sha256, sizeBytes: item.size }, sizeBytes: item.size, readRange: original.readRange });
  }
  const jobsOriginal = native.metadataOriginals.find(row => row.name === 'jobs.original.json');
  const jobReference = native.originFacts.originals.find(row => row.name === 'jobs.original.json');
  if (!jobsOriginal || !jobReference || jobsOriginal.data.length !== jobReference.bytes || hash(jobsOriginal.data) !== jobReference.sha256) return fail('native producer job API original changed');
  const job = jobsOriginal && JSON.parse(jobsOriginal.data.toString()).jobs.find((row: any) => row.id === native.originFacts.producerJobId);
  if (!job) return fail('independently observed native producer job original required');
  const verifierRelative = 'qlever/scripts/verify-local-runtime-artifacts.py';
  const nativeVerifierPath = originalPrefix + 'source-kit/workspace/' + verifierRelative;
  const runtime = verifyMacRuntimeOriginals({ target: product.identity.target, final: finalBytes, metadata: metadataBytes, manifest: manifestBytes,
    physicalAbiHeader: source.readTracked('qlever/rdf_protocol/include/xpod_rdf_physical_backend.h'), qleverLock: source.readTracked('qlever/qlever.lock.json'),
    reviewedSmokeVerifier: source.readTracked(verifierRelative), nativeSmokeVerifier: read(nativeVerifierPath), members,
    originalInventory: [...refs.values()].map(row => ({ ...row, path: row.path.startsWith(originalPrefix) ? row.path.slice(originalPrefix.length) : row.path })),
    readOriginal: reference => read(bind(reference)), jobWindow: { startedUTC: job.started_at, closedUTC: job.completed_at } });
  const receipt = JSON.parse(read(bind(final.nativeReceipt)).toString()), observation = JSON.parse(read(bind(final.inputObservation)).toString());
  const before = JSON.parse(read(bind(final.inputsBefore)).toString()), after = JSON.parse(read(bind(final.inputsAfter)).toString());
  if (before.sourceSha !== native.originFacts.sourceSha || !same(observation.filesBefore, kit.files) || !same(observation.filesAfter, kit.files) || !same(before.filesBefore, kit.files)
    || !same(after.filesAfter, kit.files) || !same(before.toolchain, after.toolchain) || !same(before.toolchain, metadata.record.toolchain)
    || observation.sourceKitSha256 !== final.sourceKit.sha256 || observation.helperSha256 !== final.binary.sha256
    || receipt.sourceKitSha256 !== final.sourceKit.sha256 || receipt.helperSha256 !== final.binary.sha256 || !same(receipt.engine, kit.engine)
    || receipt.compiler?.toolchain !== kit.toolchain || receipt.sourceFiles !== kit.files.length) return fail('actual native source/toolchain before/after correspondence required');
  const expectedLock = JSON.parse(source.readTracked('qlever/qlever.lock.json').toString());
  if (kit.engine?.repository !== expectedLock.repository || kit.engine?.commit !== expectedLock.commit) return fail('native engine source authority differs from canonical QLever pin');
  for (const role of ['patches', 'terms', 'toolchainInputs']) {
    if (!Array.isArray(proposal[role]) || (role !== 'patches' && !proposal[role].length)
      || proposal[role].some((file: any) => !kit.files.some((actual: any) => same(actual, file)))) return fail('native source role outside complete original source-kit inventory');
  }
  for (const [role, name] of [['observationStage', 'native-input-observation'], ['buildStage', 'native-build'], ['testStage', 'native-test']]) {
    const roleStage = proposal[role];
    if (roleStage?.kind !== 'local' || roleStage.receipt?.path !== `stages/${name}.receipt.json` || roleStage.raw?.path !== `stages/${name}.raw.log`
      || !metadata.stages.some((stage: any) => stage.name === name && same(stage.receipt, roleStage.receipt) && same(stage.raw, roleStage.raw))) return fail('actual native input/build/test roles differ from registered stage originals');
  }
  const stageMap = new Map<string, any>(metadata.stages.map((stage: any) => [stage.name, stage]));
  const stageCommand = (name: string): string[] => JSON.parse(read(bind(stageMap.get(name)?.receipt)).toString()).command;
  const buildCommand = stageCommand('native-build'), prepareCommand = stageCommand('native-prepare');
  if (!Array.isArray(buildCommand) || buildCommand.length !== 3 || buildCommand[0] !== 'bash'
    || !buildCommand[1].startsWith('/') || !buildCommand[1].endsWith('/qlever/scripts/build-macos-local-runtime.sh') || buildCommand[2] !== 'build-prepared'
    || !same(prepareCommand, [buildCommand[0], buildCommand[1], 'prepare-only']) || !same(receipt.buildArguments, buildCommand)) return fail('actual native prepare/build command differs from canonical source recipe');
  const nativeBuilder = read(originalPrefix + 'source-kit/workspace/qlever/scripts/build-macos-local-runtime.sh');
  if (!nativeBuilder.equals(source.readTracked('qlever/scripts/build-macos-local-runtime.sh'))) return fail('actual native builder differs from reviewed immutable source');
  const observationCommand = stageCommand('native-input-observation');
  if (observationCommand.length !== 4 || !observationCommand[0].startsWith('/')
    || !observationCommand[1].endsWith('/qlever/scripts/observe-macos-native-materials.py') || observationCommand[2] !== '--verify-inputs'
    || !observationCommand[3].endsWith('/native-materials/source-snapshot.json')
    || !same(JSON.parse(read(bind(stageMap.get('native-input-observation').raw)).toString()), observation)) return fail('native input observation differs from the actual closed observer raw');
  const nativeObserver = read(originalPrefix + 'source-kit/workspace/qlever/scripts/observe-macos-native-materials.py');
  if (!nativeObserver.equals(source.readTracked('qlever/scripts/observe-macos-native-materials.py'))) return fail('actual source observer differs from reviewed immutable source');
  const sourceHead = stageMap.get('source-head');
  if (!same(stageCommand('source-head'), ['git', 'rev-parse', 'HEAD'])
    || read(bind(sourceHead.raw)).toString().trim() !== native.originFacts.sourceSha) return fail('actual native workspace source head differs from official origin');
  const engineStage = stageMap.get('engine-head'), engineCommand = stageCommand('engine-head');
  if (engineCommand.length !== 5 || engineCommand[0] !== 'git' || engineCommand[1] !== '-C' || !engineCommand[2].startsWith('/')
    || engineCommand[3] !== 'rev-parse' || engineCommand[4] !== 'HEAD'
    || read(bind(engineStage.raw)).toString().trim() !== expectedLock.commit) return fail('actual engine Git source head differs from canonical source authority');
  if (!Array.isArray(proposal.compilerBindings) || !proposal.compilerBindings.length || !Array.isArray(proposal.toolchainInputs)) return fail('actual native compiler bindings required');
  const fields = new Set<string>();
  for (const binding of proposal.compilerBindings) {
    const file = binding?.file;
    if (typeof binding?.field !== 'string' || !/^[A-Za-z][A-Za-z0-9]*Sha256$/u.test(binding.field) || fields.has(binding.field)
      || !kit.files.some((row: any) => same(row, file)) || !proposal.toolchainInputs.some((row: any) => same(row, file))
      || receipt.compiler[binding.field] !== file.sha256) return fail('compiler/source snapshot binding differs');
    fields.add(binding.field); bind(file, originalPrefix + 'source-kit/');
  }
  if (!runtime.executedCanonicalProtocolVerified) return fail('actual runtime ABI protocol observation required');
  const capability = Object.freeze({}) as NativeMaterialCapability;
  const uncoveredNativeImages: import('../physical-module-native').NativeFile[] = [];
  const candidates = product.members.filter(row => !row.path.startsWith(prefix) && !row.path.startsWith('source/') && !row.path.startsWith('provenance/') && row.bytes >= 4);
  const imageMagic = new Set(['7f454c46', '0061736d', 'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
  const inventoryObserved = candidates.length <= 10000;
  if (inventoryObserved) for (const row of candidates) {
    const original = collectedProductOriginal(input.artifact, { path: row.path, sha256: row.sha256, sizeBytes: row.bytes });
    const bytes = original.readRange(0, 4), magic = bytes.toString('hex');
    if (imageMagic.has(magic) || bytes.subarray(0, 2).toString() === 'MZ') uncoveredNativeImages.push(Object.freeze({ ...original.reference }));
  }
  const pending = Object.freeze(['native-compiler-input-closure-not-fully-bound',
    ...(manifest.artifacts.length > 1 ? ['bundled-native-library-source-bindings-unavailable'] : []),
    ...(!inventoryObserved ? ['whole-product-native-image-inventory-budget-exceeded'] : []),
    ...uncoveredNativeImages.map(row => 'uncovered-product-native-image:' + row.path)]);
  const validate = () => {
    if (collectedArtifactView(input.artifact) !== product || nativeOriginalsView(input.nativeOriginals) !== native || derivedSourceView(input.source) !== source) fail('native custody/source capability revoked');
  };
  const stageBinding = (stage: any) => ({ ...stage, receipt: { ...stage.receipt, path: bind(stage.receipt) }, raw: { ...stage.raw, path: bind(stage.raw) } });
  const nativeIndex: import('../physical-module-native').NativeMaterialIndex = { schemaVersion: 1, status: 'native-build-materials', bindings: [{ ...proposal,
    binary: { ...proposal.binary, path: prefix + proposal.binary.path }, sourceRoot: originalPrefix + proposal.sourceRoot,
    sourceKit: { ...proposal.sourceKit, path: kitName }, nativeReceipt: { ...proposal.nativeReceipt, path: bind(proposal.nativeReceipt) },
    inputObservation: { ...proposal.inputObservation, path: bind(proposal.inputObservation) },
    observationStage: stageBinding(proposal.observationStage), buildStage: stageBinding(proposal.buildStage), testStage: stageBinding(proposal.testStage) }] };
  const freeze = (value: any): any => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  freeze(nativeIndex);
  const view = Object.freeze({ identity: product.identity, nativeIndex, nativeSourceSha: native.originFacts.sourceSha,
    nativeOriginVerified: true as const, originalStageBindingsVerified: true as const, binaryFormatsVerified: inventoryObserved && uncoveredNativeImages.length === 0,
    qleverRuntimeAbiVerified: true as const, runtimeAbiScope: 'css-qlever-bundle' as const, uncoveredNativeImages: Object.freeze(uncoveredNativeImages),
    runtimeAbiVerified: inventoryObserved && uncoveredNativeImages.length === 0, sourceMaterialsVerified: true as const, nativeSourceClosureVerified: false as const, pending });
  runtimeIssued.set(capability, { view, validate });
  issued.set(capability, () => { validate(); return Object.freeze({ identity: product.identity, custodyKind: 'collected-native-originals' as const,
    indexPath: proposalName, indexSha256: hash(proposalBytes), status: 'material-integrity-verified' as const, externalAdmission: 'pending' as const }); });
  return capability;
}
