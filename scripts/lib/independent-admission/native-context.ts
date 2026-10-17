import { CSS_SOURCE_PARENT_VERSIONS } from './module-source-phases';
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
  readonly nativeIndex?: Readonly<import('../physical-module-native').NativeMaterialIndex>;
  readonly nativeOriginVerified: boolean;
  readonly originalStageBindingsVerified: boolean;
  readonly binaryFormatsVerified: boolean;
  readonly qleverRuntimeAbiVerified: boolean;
  readonly agentfsRuntimeAbiVerified: boolean;
  readonly selectedNativeBinaryFormatsVerified: true;
  readonly runtimeAbiScope: 'css-qlever-bundle' | 'afs-agentfs-helper' | 'api-inngest-cli';
  readonly uncoveredNativeImages: readonly Readonly<import('../physical-module-native').NativeFile>[];
  readonly runtimeAbiVerified: boolean;
  readonly sdkSourceFacts?: Readonly<Record<string, unknown>>;
  readonly officialReleaseFacts?: Readonly<Record<string, unknown>>;
  readonly sourceMaterialsVerified: boolean;
  readonly nativeSourceClosureVerified: boolean;
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
    || !['.github/workflows/build-qlever-macos-runtime.yml', '.github/workflows/css-module-product.yml', '.github/workflows/css-native-products.yml'].includes(native.originFacts.workflowPath)
    || native.originFacts.workflowPath === '.github/workflows/css-native-products.yml' && !CSS_SOURCE_PARENT_VERSIONS.some(row => row.workflowSha256 === hash(source.readTracked('.github/workflows/css-native-products.yml')))) return fail('independent observed macOS originals and exact product/Git capabilities required');
  const { modulePackageName } = await import('../../../packages/xpod-cli/src/module-catalog');
  const [productPlatform, productArch] = product.identity.target.split('-');
  if (modulePackageName('css', productPlatform, productArch) !== product.identity.package) return fail('fixed CSS native adapter required');
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
  if (native.originFacts.workflowPath === '.github/workflows/css-native-products.yml' && job.name !== `targets (${product.identity.target}) / native / macos / build`) return fail('reviewed CSS parent macOS native job required');
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
  const { uncoveredNativeImages, inventoryObserved } = await observeOtherProductNativeImages(input.artifact, new Set(actualRuntime.map(row => row.path)));
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
    qleverRuntimeAbiVerified: true as const, agentfsRuntimeAbiVerified: false, selectedNativeBinaryFormatsVerified: true as const, runtimeAbiScope: 'css-qlever-bundle' as const, uncoveredNativeImages: Object.freeze(uncoveredNativeImages),
    runtimeAbiVerified: inventoryObserved && uncoveredNativeImages.length === 0, sourceMaterialsVerified: true as const, nativeSourceClosureVerified: false as const, pending });
  runtimeIssued.set(capability, { view, validate });
  issued.set(capability, () => { validate(); return Object.freeze({ identity: product.identity, custodyKind: 'collected-native-originals' as const,
    indexPath: proposalName, indexSha256: hash(proposalBytes), status: 'material-integrity-verified' as const, externalAdmission: 'pending' as const }); });
  return capability;
}

/** Linux uses the same independently issued original custody as macOS. Only
 * the reviewed CSS parent archive job is supported; SDK/source remains pending. */
export async function collectLinuxNativeRuntimeContext(input: {
  artifact: CollectedArtifactCapability; nativeOriginals: unknown; source: unknown; sdkOriginals?: unknown;
}): Promise<NativeMaterialCapability> {
  const { nativeOriginalsView } = await import('./native-original-collector');
  const { derivedSourceView } = await import('./source-context');
  const { collectedProductOriginal, collectedProductOriginalBinding } = await import('./product-original');
  const { observeRegisteredNativeTar } = await import('./native-tar-observation');
  const { verifyLinuxQleverRuntimeOriginals, LINUX_QLEVER_REVIEWED_FILES } = await import('./native-linux-runtime');
  const { modulePackageName } = await import('../../../packages/xpod-cli/src/module-catalog');
  const { qleverSdkOriginalsView } = await import('./qlever-sdk-originals');
  const { observeQleverSdkSourceAdmission } = await import('./qlever-sdk-source');
  const product = collectedArtifactView(input.artifact), native = nativeOriginalsView(input.nativeOriginals), source = derivedSourceView(input.source);
  if (!product || !native || !source || !product.identity.target || !['linux-x64', 'linux-arm64'].includes(product.identity.target)
    || source.sourceSha !== product.identity.sourceSha || native.originFacts.sourceSha !== product.identity.sourceSha
    || native.originFacts.target !== product.identity.target || native.originFacts.workflowPath !== '.github/workflows/css-native-products.yml'
    || !CSS_SOURCE_PARENT_VERSIONS.some(row => row.workflowSha256 === hash(source.readTracked('.github/workflows/css-native-products.yml')))
    || modulePackageName('css', ...product.identity.target.split('-') as [string, string]) !== product.identity.package) return fail('independent reviewed Linux CSS parent/product/Git custody required');
  const refs = new Map(native.members.map(row => [row.path, { path: row.path, sha256: row.sha256, sizeBytes: row.bytes }]));
  const read = (name: string, maximum = 8 * 1024 ** 2): Buffer => {
    const ref = refs.get(name);
    if (!ref || ref.sizeBytes > maximum) return fail('bounded Linux native original required');
    const bytes = native.readOriginal(name, maximum);
    if (bytes.length !== ref.sizeBytes || hash(bytes) !== ref.sha256) return fail('Linux native original changed');
    return bytes;
  };
  const finalPath = 'native-build-materials.json', finalBytes = read(finalPath), final = JSON.parse(finalBytes.toString());
  if (final.sourceSha !== native.originFacts.sourceSha || final.target !== product.identity.target
    || String(final.runId) !== String(native.originFacts.runId) || String(final.runAttempt) !== String(native.originFacts.runAttempt)) return fail('Linux native final actual source/run/target differs');
  const archive = refs.get(final.archive?.path);
  if (!archive || archive.sha256 !== final.archive.sha256 || archive.sizeBytes !== final.archive.bytes) return fail('Linux native runtime archive original differs');
  const rows = await observeRegisteredNativeTar(native, archive.path, 'runtime'), prefix = 'native/qlever/';
  const runtime = new Map(rows.map(row => [row.path, row])), actual = product.members.filter(row => row.path.startsWith(prefix));
  if (actual.length !== runtime.size) return fail('Linux runtime tar/product complete member set differs');
  for (const row of actual) {
    const original = runtime.get(row.path.slice(prefix.length));
    if (!original || original.type === 'symlink' || original.sha256 !== row.sha256 || original.sizeBytes !== row.bytes) return fail('Linux runtime tar/product bytes differ');
  }
  const manifestBytes = product.readMember(prefix + 'manifest.json', 1024 ** 2), manifest = JSON.parse(manifestBytes.toString());
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length > 1024) return fail('bounded Linux runtime manifest required');
  const members = new Map<string, import('./native-linux-runtime').LinuxNativeRanges>();
  for (const item of manifest.artifacts) {
    const original = collectedProductOriginal(input.artifact, { path: prefix + item.path, sha256: item.sha256, sizeBytes: item.size });
    if (collectedProductOriginalBinding(original)?.artifact !== input.artifact) return fail('Linux product original private binding required');
    members.set(item.path, { reference: { path: item.path, sha256: item.sha256, sizeBytes: item.size }, readRange: original.readRange });
  }
  const jobs = native.metadataOriginals.find(row => row.name === 'jobs.original.json'), expected = native.originFacts.originals.find(row => row.name === 'jobs.original.json');
  if (!jobs || !expected || jobs.data.length !== expected.bytes || hash(jobs.data) !== expected.sha256) return fail('Linux archive job API original changed');
  const job = JSON.parse(jobs.data.toString()).jobs.find((row: any) => row.id === native.originFacts.producerJobId);
  if (job?.name !== `targets (${product.identity.target}) / native / linux / module_runtime_materials / archive`) return fail('reviewed Linux archive producer job required');
  const observed = verifyLinuxQleverRuntimeOriginals({ target: product.identity.target, final: finalBytes, manifest: manifestBytes,
    qleverLock: source.readTracked('qlever/qlever.lock.json'), physicalAbiHeader: source.readTracked('qlever/rdf_protocol/include/xpod_rdf_physical_backend.h'),
    reviewedFiles: new Map(LINUX_QLEVER_REVIEWED_FILES.map(row => [row.path, source.readTracked(row.path)])), members,
    originalInventory: [...refs.values()], readOriginal: (ref, maximum) => {
      const actual = refs.get(ref.path);
      if (!actual || actual.sha256 !== ref.sha256 || actual.sizeBytes !== ref.sizeBytes) return fail('Linux original reference not privately bound');
      return read(ref.path, maximum);
    }, jobWindow: { startedUTC: job.started_at, closedUTC: job.completed_at } });
  const { uncoveredNativeImages, inventoryObserved } = await observeOtherProductNativeImages(input.artifact, new Set(actual.map(row => row.path)));
  const sdk = qleverSdkOriginalsView(input.sdkOriginals);
  if (input.sdkOriginals !== undefined && (!sdk || sdk.originFacts.sourceSha !== native.originFacts.sourceSha || sdk.originFacts.target !== native.originFacts.target
    || sdk.originFacts.runId !== native.originFacts.runId || sdk.originFacts.runAttempt !== native.originFacts.runAttempt)) return fail('SDK source originals must bind the same actual runtime producer tuple');
  const sdkSource = await observeQleverSdkSourceAdmission({sdkOriginals: input.sdkOriginals, source: input.source});
  const capability = Object.freeze({}) as NativeMaterialCapability;
  const validate = () => {
    if (collectedArtifactView(input.artifact) !== product || derivedSourceView(input.source) !== source || nativeOriginalsView(input.nativeOriginals) !== native
      || (sdk && qleverSdkOriginalsView(input.sdkOriginals) !== sdk)) return fail('Linux native/SDK custody revoked');
    sdkSource.assertCurrent();
  };
  const pending = Object.freeze([...observed.pending, ...sdkSource.pending, ...(!inventoryObserved ? ['whole-product-native-image-inventory-budget-exceeded'] : []), ...uncoveredNativeImages.map(row => 'uncovered-product-native-image:' + row.path)]);
  const view: ControlledNativeRuntimeView = Object.freeze({ identity: product.identity, nativeSourceSha: native.originFacts.sourceSha,
    nativeOriginVerified: true, originalStageBindingsVerified: true, binaryFormatsVerified: inventoryObserved && uncoveredNativeImages.length === 0,
    qleverRuntimeAbiVerified: true, agentfsRuntimeAbiVerified: false, selectedNativeBinaryFormatsVerified: true,
    runtimeAbiScope: 'css-qlever-bundle', uncoveredNativeImages, runtimeAbiVerified: inventoryObserved && uncoveredNativeImages.length === 0,
    sdkSourceFacts: sdkSource.facts, sourceMaterialsVerified: sdkSource.verified, nativeSourceClosureVerified: sdkSource.verified, pending });
  runtimeIssued.set(capability, { view, validate });
  issued.set(capability, () => { validate(); return Object.freeze({ identity: product.identity, custodyKind: 'collected-native-originals' as const,
    indexPath: finalPath, indexSha256: hash(finalBytes), status: 'material-integrity-verified' as const, externalAdmission: 'pending' as const }); });
  return capability;
}

async function observeOtherProductNativeImages(artifact: CollectedArtifactCapability, covered: ReadonlySet<string>) {
  const product = collectedArtifactView(artifact);
  if (!product) return fail('real product custody required for native image inventory');
  const { collectedProductOriginal } = await import('./product-original');
  const uncoveredNativeImages: import('../physical-module-native').NativeFile[] = [];
  const candidates = product.members.filter(row => !covered.has(row.path) && !row.path.startsWith('source/')
    && !row.path.startsWith('sources/') && !row.path.startsWith('provenance/') && row.bytes >= 4);
  const magic = new Set(['7f454c46', '0061736d', 'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
  const inventoryObserved = candidates.length <= 10000;
  if (inventoryObserved) for (const row of candidates) {
    const original = collectedProductOriginal(artifact, { path: row.path, sha256: row.sha256, sizeBytes: row.bytes });
    const bytes = original.readRange(0, 4);
    if (magic.has(bytes.toString('hex')) || bytes.subarray(0, 2).toString() === 'MZ') uncoveredNativeImages.push(Object.freeze({ ...original.reference }));
  }
  return { uncoveredNativeImages: Object.freeze(uncoveredNativeImages), inventoryObserved };
}

/** One module dispatcher over the same private product/native capability axes.
 * API and AgentFS cannot inherit QLever's runtime protocol or SDK approval. */
export async function collectNativeAdmissionContext(input: {
  artifact: CollectedArtifactCapability; source: unknown; nativeOriginals?: unknown; sdkOriginals?: unknown;
}): Promise<NativeMaterialCapability> {
  const { derivedSourceView } = await import('./source-context');
  const { modulePackageName } = await import('../../../packages/xpod-cli/src/module-catalog');
  const { inspectModuleNativeMaterials } = await import('./native-module-materials');
  const { collectedProductOriginal, collectedProductOriginalBinding } = await import('./product-original');
  const { nativeOriginalsView } = await import('./native-original-collector');
  const { observeMacNativeRanges } = await import('./macos-native-range');
  const { verifyNativeMaterialTarget } = await import('../physical-module-native');
  const product = collectedArtifactView(input.artifact), source = derivedSourceView(input.source);
  if (!product || !source || source.sourceSha !== product.identity.sourceSha || !product.identity.target) return fail('actual platform product and immutable Git source required');
  const [platform_, arch] = product.identity.target.split('-');
  const module_ = (['css', 'api', 'afs'] as const).find(id => modulePackageName(id, platform_, arch) === product.identity.package);
  if (module_ === 'css') return (platform_ === 'linux' ? collectLinuxNativeRuntimeContext : collectMacNativeRuntimeContext)({ ...input, nativeOriginals: input.nativeOriginals });
  if (module_ !== 'api' && module_ !== 'afs') return fail('canonical supported native product identity required');
  const material = inspectModuleNativeMaterials({ module: module_, target: product.identity.target, members: product.members,
    readMember: product.readMember, sourcePins: source.readTracked(module_ === 'api' ? 'packages/xpod-api/scripts/inngest-input-pins.json' : 'scripts/agentfs-native-ci/mounted/native-authority.json'),
    ...(module_ === 'afs' ? { nativePolicySource: source.readTracked('scripts/agentfs-native-ci/accept.py') } : {}) });
  const binary = collectedProductOriginal(input.artifact, material.binary);
  if (collectedProductOriginalBinding(binary)?.artifact !== input.artifact) return fail('private actual module binary original required');
  if (platform_ === 'darwin') observeMacNativeRanges({ sizeBytes: binary.reference.sizeBytes, readRange: binary.readRange }, product.identity.target);
  else if (platform_ === 'linux') verifyNativeMaterialTarget(binary.readRange(0, 64), product.identity.target);
  else return fail('module native target format profile unavailable');
  const { officialInngestReleaseView } = await import('./inngest-release-originals');
  const official = module_ === 'api' ? officialInngestReleaseView(input.nativeOriginals) : undefined;
  const native = input.nativeOriginals === undefined || official ? undefined : nativeOriginalsView(input.nativeOriginals);
  if (input.nativeOriginals !== undefined && !native && !official) return fail('private independent native original capability required');
  if (module_ === 'api' && native) return fail('official-release native custody profile required; an Actions native origin is not an Inngest release origin');
  let originVerified = false, stagesVerified = false, runtimeAbi = false;
  const pending = new Set(material.pending);
  if (module_ === 'api' && official) {
    if (!isDeepStrictEqual(official.identity, product.identity) || official.target !== product.identity.target
      || official.sourceCommit !== material.nativeSourceSha || official.officialOriginVerified !== true || official.releaseMembersVerified !== true)
      return fail('official Inngest origin differs from exact actual product/source');
    for (const reference of [official.archive, official.sourceArchive, official.binary, official.license]) {
      const actual = product.members.find(row => row.path === reference.path);
      if (!actual || actual.bytes !== reference.bytes || actual.sha256 !== reference.sha256) return fail('official Inngest release member differs from exact product');
    }
    if (official.binary.path !== material.binary.path || official.binary.sha256 !== material.binary.sha256 || official.binary.bytes !== material.binary.sizeBytes
      || official.sourceArchive.path !== material.sourceArchive.path || official.sourceArchive.sha256 !== material.sourceArchive.sha256
      || official.sourceArchive.bytes !== material.sourceArchive.sizeBytes) return fail('official Inngest source/binary scope differs');
    originVerified = true;
    pending.delete('inngest-official-release-origin-capability-unavailable');
    pending.delete('inngest-release-binary-member-correspondence-unverified');
  }

  if (module_ === 'afs' && native) {
    const data = material.data as { kit: any; receipt: any; reuse: any; authority: any };
    const facts = native.originFacts;
    const authority = JSON.parse(source.readTracked('scripts/agentfs-native-ci/mounted/native-authority.json').toString());
    if (facts.workflowPath !== '.github/workflows/agentfs-native-acceptance.yml' || facts.target !== product.identity.target
      || facts.sourceSha !== material.nativeSourceSha || String(facts.runId) !== String(authority.run)
      || String(facts.artifactId) !== String(data.authority.id) || facts.artifactSha256 !== data.authority.zip) return fail('independent AgentFS origin differs from exact retained native authority');
    const refs = new Map(native.members.map(row => [row.path, row]));
    const read = (name: string, maximum = 8 * 1024 ** 2) => {
      const reference = refs.get(name); if (!reference || reference.bytes > maximum) return fail('registered bounded AgentFS original required');
      const bytes = native.readOriginal(name, maximum);
      if (bytes.length !== reference.bytes || hash(bytes) !== reference.sha256) return fail('AgentFS native original changed');
      return bytes;
    };
    if (refs.get('source-kit.json')?.sha256 !== material.index.sha256
      || refs.get('native-receipt.json')?.sha256 !== product.members.find(row => row.path === 'provenance/native-build.receipt.json')?.sha256) return fail('AgentFS source/build originals differ from actual product copies');
    const final = JSON.parse(read('final.json').toString());
    if (final.head !== facts.sourceSha || final.target !== product.identity.target || final.sourceBefore?.head !== facts.sourceSha
      || final.sourceBefore?.status !== '' || !isDeepStrictEqual(final.sourceBefore, final.sourceAfter)
      || !isDeepStrictEqual(final.nativeReceipt, data.receipt) || !isDeepStrictEqual(final.sdkBefore, final.sdkAfter)) return fail('actual AgentFS source/SDK before/after differs');
    const expectedInputs = data.reuse.nativeInputFiles;
    if (!Array.isArray(expectedInputs) || !expectedInputs.length || expectedInputs.length > 4096) return fail('actual retained native module source inputs required');
    for (const row of expectedInputs) {
      const bytes = source.readTracked(row.path);
      if (hash(bytes) !== row.sha256) return fail('AgentFS helper input differs from current immutable module source');
    }
    const packageRows = native.members.filter(row => row.path.endsWith('-' + product.identity.target + '.tar.gz'));
    if (packageRows.length !== 1 || packageRows[0].sha256 !== data.authority.archive || final.archiveSHA256 !== data.authority.archive) return fail('actual AgentFS native package differs from retained product authority');
    const { observeRegisteredNativeTar, observeRegisteredAfsLinuxRuntime } = await import('./native-tar-observation');
    const packageInventory = await observeRegisteredNativeTar(native, packageRows[0].path, 'afs-package');
    const packaged = new Map(packageInventory.map((row: any) => [row.path, row]));
    for (const original of [material.binary, material.sourceArchive]) {
      const actual = packaged.get(original.path);
      if (!actual || actual.sha256 !== original.sha256 || actual.sizeBytes !== original.sizeBytes) return fail('actual AgentFS helper/source archive differs from native package member');
    }
    const jobs = native.metadataOriginals.find(row => row.name === 'jobs.original.json'), expectedJobs = facts.originals.find(row => row.name === 'jobs.original.json');
    if (!jobs || !expectedJobs || jobs.data.length !== expectedJobs.bytes || hash(jobs.data) !== expectedJobs.sha256) return fail('actual AgentFS job API original unavailable');
    const job = JSON.parse(jobs.data.toString()).jobs.find((row: any) => row.id === facts.producerJobId);
    const began = Date.parse(job?.started_at), ended = Date.parse(job?.completed_at);
    if (!Number.isFinite(began) || !Number.isFinite(ended) || ended < began) return fail('actual AgentFS producer job window unavailable');
    const receipts = native.members.filter(row => row.path.endsWith('.receipt.json'));
    if (!receipts.length || receipts.length > 64) return fail('complete bounded AgentFS stage originals required');
    for (const row of receipts) {
      const receipt = JSON.parse(read(row.path, 1024 ** 2).toString()), raw = refs.get(row.path.replace(/\.receipt\.json$/u, '.raw.log'));
      const started = Date.parse(receipt.startedUTC), closed = Date.parse(receipt.closedUTC);
      if (!raw || receipt.rawSHA256 !== raw.sha256 || receipt.actualWait !== true || receipt.exit !== 0 || receipt.signal !== null
        || receipt.rawClosedBeforeHash !== true || receipt.ownedGroupAbsentAfterWait !== true || receipt.resourceStop !== null || receipt.supervisorError !== null
        || !Array.isArray(receipt.cleanupErrors) || receipt.cleanupErrors.length || !Array.isArray(receipt.ownedGroupMembers) || receipt.ownedGroupMembers.length
        || !Array.isArray(receipt.command) || !receipt.command.length || !Number.isFinite(started) || !Number.isFinite(closed)
        || started < began || closed < started || closed > ended) return fail('AgentFS original stage closure/raw/job window mismatch');
    }
    originVerified = true; stagesVerified = true; pending.delete('agentfs-original-native-producer-custody-unavailable');
    if (platform_ === 'linux') {
      const observed = await observeRegisteredAfsLinuxRuntime(native, product.identity.target, binary);
      runtimeAbi = observed.status === 'mechanical-agentfs-linux-runtime-verified';
      if (runtimeAbi) pending.delete('agentfs-executed-runtime-ABI-originals-unavailable');
    } else pending.add('agentfs-macos-executed-loader-sdk-runtime-originals-unavailable');
  }
  const capability = Object.freeze({}) as NativeMaterialCapability;
  const validate = () => {
    if (collectedArtifactView(input.artifact) !== product || derivedSourceView(input.source) !== source
      || (native && nativeOriginalsView(input.nativeOriginals) !== native)
      || (official && officialInngestReleaseView(input.nativeOriginals) !== official)) return fail('module native custody/source capability revoked');
  };
  const { uncoveredNativeImages, inventoryObserved } = await observeOtherProductNativeImages(input.artifact, new Set([material.binary.path]));
  const view: ControlledNativeRuntimeView = Object.freeze({ identity: product.identity, nativeSourceSha: material.nativeSourceSha,
    ...(official ? {officialReleaseFacts: Object.freeze({repository: 'inngest/inngest', releaseID: official.releaseID, releaseTag: official.releaseTag,
      target: official.target, sourceCommit: official.sourceCommit, officialOriginVerified: true, releaseMembersVerified: true,
      sourceArchiveScope: official.sourceArchiveScope})} : {}),
    nativeOriginVerified: originVerified, originalStageBindingsVerified: stagesVerified, binaryFormatsVerified: inventoryObserved && uncoveredNativeImages.length === 0,
    selectedNativeBinaryFormatsVerified: true, agentfsRuntimeAbiVerified: module_ === 'afs' && runtimeAbi, qleverRuntimeAbiVerified: false, runtimeAbiScope: module_ === 'api' ? 'api-inngest-cli' : 'afs-agentfs-helper',
    uncoveredNativeImages, runtimeAbiVerified: runtimeAbi && inventoryObserved && uncoveredNativeImages.length === 0, sourceMaterialsVerified: true, nativeSourceClosureVerified: false,
    pending: Object.freeze([...pending, ...(!inventoryObserved ? ['whole-product-native-image-inventory-budget-exceeded'] : []), ...uncoveredNativeImages.map(row => 'uncovered-product-native-image:' + row.path)]) });
  runtimeIssued.set(capability, { view, validate });
  issued.set(capability, () => { validate(); return Object.freeze({ identity: product.identity, custodyKind: official ? 'official-release-originals' as const : 'collected-native-originals' as const,
    indexPath: material.index.path, indexSha256: material.index.sha256, status: 'material-integrity-verified' as const, externalAdmission: 'pending' as const }); });
  return capability;
}
