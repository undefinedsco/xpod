import {selectSdkControllerHelperGroup} from './sdk-controller-helper-groups';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import limits from '../module-artifact-limits.json';
import {qleverSdkOriginalsView} from './qlever-sdk-originals';
import {derivedSourceView, assertDerivedSourceCurrent} from './source-context';
import {sdkVerifiedInputOriginalView} from './qlever-sdk-source';
import {qleverSdkDebianIndexObservation} from './qlever-sdk-debian-index';
import {qleverSdkDebianSignatureObservation} from './qlever-sdk-debian-signature';
import {hashSignatureControllerFile} from './qlever-signature-original-custody';
import {assertLegalFileIdentity,resolveExecutableIdentityPath} from './legal-file-custody';
import {moduleSourcePhasePolicy} from './module-source-phases';

type Ref = Readonly<{path: string; bytes: number; sha256: string}>;
export interface DebianInstalledBinaryFile {
  readonly installedPath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mode: number;
  readonly binary: Readonly<{name: string; version: string; architecture: string}>;
  readonly source: Readonly<{name: string; version: string}>;
  readonly deb: Ref;
  readonly packages: Ref & Readonly<{signedIndexPath: string; inReleaseSha256: string}>;
  readonly dataMemberPath: string;
}
interface BinaryObservation {
  readonly files: readonly DebianInstalledBinaryFile[];
  readonly unresolved: readonly Readonly<{installedPath: string; reason: string}>[];
  readonly scope: 'same-SDK installed file bytes equal signed-Packages official deb data members; no build/toolchain closure';
  assertCurrent(): void;
}
const issued = new WeakMap<object, BinaryObservation>();
function need(value: unknown, reason: string): asserts value {if (!value) throw Error('SDK Debian binary: ' + reason);}
function record(value: unknown): Record<string, unknown> {need(value && typeof value === 'object' && !Array.isArray(value), 'metadata object required'); return value as Record<string, unknown>;}
function array(value: unknown): unknown[] {need(Array.isArray(value), 'metadata array required'); return value;}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function freeze(value: unknown): void {if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);}}
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  const row = record(value);
  if (typeof row.path === 'string' && Number.isSafeInteger(row.bytes) && typeof row.sha256 === 'string') return {...row, path: 'inner/' + row.path};
  return Object.fromEntries(Object.entries(row).map(([key, child]) => [key, normalize(child)]));
}
/** Same SDK capability only; serialized facts cannot restore this private map. */
export function qleverSdkDebianBinaryObservation(capability: unknown): BinaryObservation | undefined {
  if (!capability || typeof capability !== 'object') return undefined;
  const value = issued.get(capability); value?.assertCurrent(); return value;
}

/** This observes existing retained originals only. Network acquisition and
 * producer return codes cannot authorize a signature or file provenance. */
/** Structural reader view supplied by a genuine private collector. Core does
 * not authenticate it, write SDK caches, or issue any capability. */
export type DebianBinaryReader = Readonly<{
  members: readonly Readonly<{path: string; bytes: number; sha256: string}>[];
  readOriginal(path: string, maximum: number): Buffer;
  masterReference: Ref;
  originFacts: Readonly<{sourceSha: string; target: string}>;
  archive: Readonly<{bytes: number; sha256: string}>;
  withArchiveFile<T>(operation: (input: Readonly<{path: string; identity: Readonly<{bytes: number; sha256: string}>}>) => Promise<T>, budget?: Readonly<{check(): void; remainingMs(): number}>): Promise<T>;
  materialRoot?: string;
}>;
export type DebianBinaryPrerequisites = Readonly<{
  inputs: Readonly<{rows: readonly Readonly<{originalPath: string; bytes: number; sha256: string; mode: number}>[]; afterReference?: Ref}>;
  signatureVerified: true;
  signatureInRelease: readonly Ref[];
  indexInRelease: readonly Readonly<{sha256: string}>[];
  sourceSha: string;
  target: string;
}>;
export type DebianBinaryCoreResult = Readonly<{
  facts: Readonly<Record<string, unknown>>;
  pending: readonly string[];
  files?: readonly DebianInstalledBinaryFile[];
  unresolved?: readonly Readonly<{installedPath: string; reason: string}>[];
  scope?: BinaryObservation['scope'];
  assertCurrent?: () => void;
}>;
/** Required private context validator. The core supplies only readers and the
 * parsed master; each caller's genuine collector owns its own sealed context. */
export type DebianBinaryContextInput = Readonly<{
  master: Record<string, unknown>;
  reference(value: unknown): Ref;
  json(value: unknown, maximum?: number): Record<string, unknown>;
  members: DebianBinaryReader['members'];
  check(): void;
  limits: Readonly<{sourceMaterialBytes: number}>;
}>;

/** Same binary observation algorithm, bounded and cache-free. */
export async function inspectDebianBinaryCore(input: {
  reader: DebianBinaryReader;
  source: Readonly<{sourceSha: string}>;
  prerequisites: DebianBinaryPrerequisites;
  remainingMs: number;
  check(): void;
  current(): void;
  validateContext(context: DebianBinaryContextInput): void;
}): Promise<DebianBinaryCoreResult> {
  const pending: string[] = [], facts: Record<string, unknown> = {sdkWholeToolchainVerified: false};
  try {
    need(Number.isFinite(input.remainingMs) && input.remainingMs >= 1, 'remaining binary observation deadline required');
    const deadline = performance.now() + Math.min(limits.timeoutMs, input.remainingMs);
    const check = () => {input.check(); need(performance.now() < deadline, 'shared binary observation deadline exhausted');};
    input.current();
    const sdk = input.reader, source = input.source;
    const inputs = input.prerequisites.inputs;
    const signatureVerified = input.prerequisites.signatureVerified;
    const sourceIndex = input.prerequisites.indexInRelease;
    check(); need(inputs && signatureVerified === true && sourceIndex.length > 0
      && source.sourceSha === sdk.originFacts.sourceSha
      && input.prerequisites.sourceSha === source.sourceSha
      && input.prerequisites.target === sdk.originFacts.target,
      'same live SDK/source/installed-shard/signature/index private observations required');
    const members = new Map(sdk.members.map(row => [row.path, row]));
    const reference = (value: unknown): Ref => {check(); const item = record(value), row = typeof item.path === 'string' ? members.get(item.path) : undefined;
      need(row && row.bytes === item.bytes && row.sha256 === item.sha256, 'same SDK full original reference required'); return {path: row.path, bytes: row.bytes, sha256: row.sha256};};
    const json = (value: unknown, maximum: number = limits.metadataBytes): Record<string, unknown> => {
      const row = reference(value); need(row.bytes <= maximum, 'bounded binary metadata required');
      const bytes = sdk.readOriginal(row.path, maximum); need(bytes.length === row.bytes && hash(bytes) === row.sha256, 'full binary metadata original differs'); return record(JSON.parse(bytes.toString()));
    };
    const master = json(sdk.masterReference, 8 * 1024 ** 2);
    const identity = record(master.identity);
    need(identity.sourceSha === source.sourceSha && identity.target === sdk.originFacts.target, 'same SDK source/target identity required');
    need(typeof input.validateContext === 'function', 'required private context validator');
    input.validateContext({master, reference, json, members: sdk.members, check,
      limits: {sourceMaterialBytes: limits.sourceMaterialBytes}});
    if (!master.debianBinaries) return Object.freeze({facts: Object.freeze(facts), pending: Object.freeze(['qlever-sdk-Debian-binary-originals-unavailable'])});
    need(reference(master.debianBinaries).path === 'debian-binary-collection.json', 'fixed root binary collection role');
    const collection = json(master.debianBinaries);
    need(collection.schemaVersion === 1 && collection.kind === 'qlever-sdk-exact-debian-binary-originals' && collection.target === sdk.originFacts.target, 'binary collection target/schema differs');
    need(reference(collection.innerMaterials).path === 'inner/debian-binary/materials.json', 'fixed inner binary collection role');
    const inner = json(collection.innerMaterials), {innerMaterials: _innerMaterials, ...root} = collection;
    need(isDeepStrictEqual(root, normalize(inner)), 'whole root/inner binary collection seal differs');
    const sources = json(master.debianSources);
    need(sources.kind === 'qlever-sdk-exact-debian-source-originals' && sources.schemaVersion === 1, 'same signed Sources collection required');
    const coordinates = array(sources.packages).map(value => {const row = record(value); reference(row.dsc); need(typeof row.name === 'string' && typeof row.version === 'string', 'exact signed source tuple'); return {name: row.name, version: row.version};});
    const signatureRows = input.prerequisites.signatureInRelease.map(value => reference(value));
    need(signatureRows.length > 0 && array(collection.indexOriginals).every(value => {const row = reference(record(value).inRelease); return signatureRows.some(signed => signed.bytes === row.bytes && signed.sha256 === row.sha256);}), 'binary InRelease not in the same private signature observation');
    const helperDigests=new Map<string,string>();
    const helpers = HELPERS.map(([name]) => {
      const file = fileURLToPath(new URL('../../../qlever/scripts/' + name, import.meta.url)), observed = hashSignatureControllerFile(file, check);
      helperDigests.set(name,observed.sha256);return observed.identity;
    });
    selectSdkControllerHelperGroup(REVIEWED_HELPER_GROUPS,helperDigests);helpers.forEach(assertLegalFileIdentity);
    const python = resolveExecutableIdentityPath('/usr/bin/python3'), pythonOriginal = hashSignatureControllerFile(python, check);
    const limitsOriginal = hashSignatureControllerFile(fileURLToPath(new URL('../module-artifact-limits.json', import.meta.url)), check);
    need(limitsOriginal.sha256 === moduleSourcePhasePolicy.limits, 'reviewed shared limit authority differs');
    const assertCurrent = () => {
      input.current();
      for (const guard of [...helpers, pythonOriginal.identity, limitsOriginal.identity]) assertLegalFileIdentity(guard);
    };
    assertCurrent(); check();
    const observed = await sdk.withArchiveFile(async archive => {
      check(); need(archive.identity.bytes === sdk.archive.bytes && archive.identity.sha256 === sdk.archive.sha256, 'same actual SDK ZIP');
      const plan = Buffer.from(JSON.stringify({collection, verifiedRows: inputs.rows, sourceCoordinates: coordinates,
        signatureReleaseSha256: signatureRows.map(row => row.sha256), remainingMilliseconds: Math.floor(deadline - performance.now())}));
      need(plan.length <= limits.metadataBytes, 'bounded binary observer plan'); check();
      return record(JSON.parse(execFileSync(python, ['-I', '-S', '-B', helpers[0]!.path, '--observe-sdk', archive.path], {
        input: plan, maxBuffer: limits.metadataBytes, timeout: Math.max(1, Math.floor(deadline - performance.now())), env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'},
      }).toString()));
    }, {check, remainingMs: () => deadline - performance.now()});
    assertCurrent(); check();
    need(observed.schemaVersion === 1 && observed.kind === 'qlever-sdk-Debian-binary-installed-byte-mechanics'
      && observed.officialAuthorityIssued === false && observed.wholeToolchainVerified === false, 'fixed binary mechanics result required');
    const files = array(observed.files), unresolved = array(observed.unresolved);
    need(files.length <= limits.sourceMembers && unresolved.length <= limits.sourceMembers, 'bounded actual binary file observations');
    freeze(observed);
    if (!files.length) {
      facts.sdkSelectedDebianBinaryFilesVerified = false;
      facts.sdkDebianBinaryUnresolved = unresolved;
      for (const row of unresolved) {const item = record(row); pending.push('qlever-sdk-Debian-binary-file-unresolved:' + String(item.installedPath) + ':' + String(item.reason));}
      if (!pending.length) pending.push('qlever-sdk-Debian-binary-file-observations-unavailable');
      return Object.freeze({facts: Object.freeze(facts), pending: Object.freeze(pending)});
    }
    const scope = 'same-SDK installed file bytes equal signed-Packages official deb data members; no build/toolchain closure' as const;
    facts.sdkSelectedDebianBinaryFilesVerified = true; facts.sdkDebianBinaryFiles = files; facts.sdkDebianBinaryScope = scope;
    for (const row of unresolved) pending.push('qlever-sdk-Debian-binary-file-unresolved:' + String(record(row).installedPath) + ':' + String(record(row).reason));
    return Object.freeze({facts: Object.freeze(facts), pending: Object.freeze(pending),
      files: files as unknown as readonly DebianInstalledBinaryFile[],
      unresolved: unresolved as unknown as BinaryObservation['unresolved'], scope, assertCurrent});
  } catch (error) {pending.push('qlever-sdk-Debian-binary-originals-unverified: ' + String(error instanceof Error ? error.message : error).slice(0, 1024));}
  return Object.freeze({facts: Object.freeze(facts), pending: Object.freeze(pending)});
}

/** Public SDK wrapper: exact private capabilities, same core, sole publisher. */
export async function observeQleverSdkDebianBinaryOriginals(capability: unknown, sourceCapability: unknown, remainingMilliseconds = limits.timeoutMs): Promise<DebianBinaryCoreResult> {
  if (capability && typeof capability === 'object') issued.delete(capability);
  const attemptRemaining = remainingMilliseconds;
  const deadline = performance.now() + Math.min(limits.timeoutMs, attemptRemaining);
  let result: DebianBinaryCoreResult;
  try {
    const sdk = qleverSdkOriginalsView(capability), source = derivedSourceView(sourceCapability);
    const inputs = sdkVerifiedInputOriginalView(capability), signature = qleverSdkDebianSignatureObservation(capability), sourceIndex = qleverSdkDebianIndexObservation(capability);
    need(sdk && source && inputs && signature?.sdkDebianOfficialSignatureAndSuiteVerified === true && sourceIndex?.length
      && source.sourceSha === sdk.originFacts.sourceSha, 'same live SDK/source/installed-shard/signature/index private observations required');
    const signatureRecord = record(signature!.sdkDebianSignatureOriginals);
    const signatureRows = array(signatureRecord.observations)
      .map((value: unknown) => record(value).inRelease as Ref);
    const current = () => {
      need(qleverSdkOriginalsView(capability) === sdk && derivedSourceView(sourceCapability) === source
        && qleverSdkDebianSignatureObservation(capability) === signature
        && qleverSdkDebianIndexObservation(capability) === sourceIndex, 'SDK binary source/signature custody revoked');
      const currentInputs = sdkVerifiedInputOriginalView(capability);
      need(currentInputs?.rows === inputs.rows && currentInputs.afterReference === inputs.afterReference, 'SDK installed full-shard custody changed');
      assertDerivedSourceCurrent(sourceCapability);
    };
    result = await inspectDebianBinaryCore({
      reader: sdk! as unknown as DebianBinaryReader,
      source: source!,
      prerequisites: {inputs, signatureVerified: true, signatureInRelease: signatureRows as Ref[],
        indexInRelease: sourceIndex!.map(row => ({sha256: row.inReleaseSha256})),
        sourceSha: sdk!.originFacts.sourceSha, target: String(sdk!.originFacts.target)},
      remainingMs: attemptRemaining,
      check: () => need(performance.now() < deadline, 'shared binary observation deadline exhausted'),
      current,
      validateContext: ({master, reference, json, members, check}) => {
        const contextArchive = reference(json(master.sourceContext).archive);
        let retainedSourceBytes = contextArchive.bytes;
        for (const row of members) {check(); if (row.path.startsWith('inner/')) retainedSourceBytes += row.bytes;
          need(Number.isSafeInteger(retainedSourceBytes) && retainedSourceBytes <= limits.sourceMaterialBytes,
            'whole retained inner/context/binary shared source byte budget');}
        const after = record(master.inputs);
        need(isDeepStrictEqual(after.after, inputs.afterReference), 'same verified full-shard installed inventory required');
      },
    });
    const assertCurrent = () => {
      need(qleverSdkOriginalsView(capability) === sdk && derivedSourceView(sourceCapability) === source
        && qleverSdkDebianSignatureObservation(capability) === signature
        && qleverSdkDebianIndexObservation(capability) === sourceIndex, 'SDK binary source/signature custody revoked');
      const currentInputs = sdkVerifiedInputOriginalView(capability);
      need(currentInputs?.rows === inputs.rows && currentInputs.afterReference === inputs.afterReference, 'SDK installed full-shard custody changed');
      assertDerivedSourceCurrent(sourceCapability);
    };
    assertCurrent();
    if (result.files && result.files.length) {
      need(result.assertCurrent, 'binary reader custody guard required');
      const coreCurrent = result.assertCurrent;
      const completeCurrent = () => { assertCurrent(); coreCurrent(); };
      completeCurrent();
      const view: BinaryObservation = Object.freeze({files: result.files, unresolved: result.unresolved ?? Object.freeze([]),
        scope: result.scope!, assertCurrent: completeCurrent});
      issued.set(capability as object, view);
      return Object.freeze({facts: result.facts, pending: result.pending, assertCurrent: completeCurrent});
    }
    return Object.freeze({facts: result.facts, pending: result.pending});
  } catch (error) {
    return Object.freeze({facts: Object.freeze({sdkWholeToolchainVerified: false}),
      pending: Object.freeze(['qlever-sdk-Debian-binary-originals-unverified: ' + String(error instanceof Error ? error.message : error).slice(0, 1024)])});
  }
}

// Frozen only after the final helper and shared ZIP-domain delta are reviewed.
const HELPERS: readonly (readonly [string, string])[] = [["sdk-debian-binary-originals.py", "6db9772344afe812f3a58fc04296b63c13bbd4be1d46ae2ad7fcff181111c63c"], ["sdk-debian-index-bindings.py", "ad87a17bdb781f34a6a78a5e970d1f9c69d0750a1fcc4ba3f711db317bd75e13"], ["sdk-zip-originals.py", "304a8d26c8a124af31f2b240f1b2af52312520982cd6e1f4cba70fde2602bcb8"]];

const REVIEWED_HELPER_GROUPS=Object.freeze([HELPERS,Object.freeze([["sdk-debian-binary-originals.py", "099959565f355566b9a1f6f20870e2de20a5ef20ff37fc0042a9943238a4e86f"], ["sdk-debian-index-bindings.py", "ad87a17bdb781f34a6a78a5e970d1f9c69d0750a1fcc4ba3f711db317bd75e13"], ["sdk-zip-originals.py", "86cca59ac6a30eb719fe10dbaf6939c4e7c50328e757f22d3d4d34ea90fe6c10"]] as const),Object.freeze([["sdk-debian-binary-originals.py", "099959565f355566b9a1f6f20870e2de20a5ef20ff37fc0042a9943238a4e86f"], ["sdk-debian-index-bindings.py", "ad87a17bdb781f34a6a78a5e970d1f9c69d0750a1fcc4ba3f711db317bd75e13"], ["sdk-zip-originals.py", "cf30b662bfec174a61d229811272241a945318259e9b181e8219330acf0555e6"]] as const),Object.freeze([["sdk-debian-binary-originals.py", "113b0fcd6bcae218bfc34ca091a3e731550509b8fc435d55ddc579fd17158f4b"], ["sdk-debian-index-bindings.py", "ad87a17bdb781f34a6a78a5e970d1f9c69d0750a1fcc4ba3f711db317bd75e13"], ["sdk-zip-originals.py", "cf30b662bfec174a61d229811272241a945318259e9b181e8219330acf0555e6"]] as const),Object.freeze([["sdk-debian-binary-originals.py", "f9f780094a7e0d7e530ff1f3200b1ef187587bd6e4463b4291940186f6fd5e5c"], ["sdk-debian-index-bindings.py", "ad87a17bdb781f34a6a78a5e970d1f9c69d0750a1fcc4ba3f711db317bd75e13"], ["sdk-zip-originals.py", "56f5ec76344b82b5e8242508208b5635663c037b2b915013e23b91c8ccdc3e17"]] as const)]);
