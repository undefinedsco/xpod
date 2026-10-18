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
import {assertLegalFileIdentity} from './legal-file-custody';
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
export async function observeQleverSdkDebianBinaryOriginals(capability: unknown, sourceCapability: unknown, remainingMilliseconds = limits.timeoutMs) {
  if (capability && typeof capability === 'object') issued.delete(capability);
  const pending: string[] = [], facts: Record<string, unknown> = {sdkWholeToolchainVerified: false};
  try {
    need(Number.isFinite(remainingMilliseconds) && remainingMilliseconds >= 1, 'remaining binary observation deadline required');
    const deadline = performance.now() + Math.min(limits.timeoutMs, remainingMilliseconds);
    const check = () => need(performance.now() < deadline, 'shared binary observation deadline exhausted');
    check(); const sdk = qleverSdkOriginalsView(capability), source = derivedSourceView(sourceCapability);
    const inputs = sdkVerifiedInputOriginalView(capability), signature = qleverSdkDebianSignatureObservation(capability), sourceIndex = qleverSdkDebianIndexObservation(capability);
    check(); need(sdk && source && inputs && signature?.sdkDebianOfficialSignatureAndSuiteVerified === true && sourceIndex?.length
      && source.sourceSha === sdk.originFacts.sourceSha, 'same live SDK/source/installed-shard/signature/index private observations required');
    const members = new Map(sdk.members.map(row => [row.path, row]));
    const reference = (value: unknown): Ref => {check(); const input = record(value), row = typeof input.path === 'string' ? members.get(input.path) : undefined;
      need(row && row.bytes === input.bytes && row.sha256 === input.sha256, 'same SDK full original reference required'); return {path: row.path, bytes: row.bytes, sha256: row.sha256};};
    const json = (value: unknown, maximum: number = limits.metadataBytes): Record<string, unknown> => {
      const row = reference(value); need(row.bytes <= maximum, 'bounded binary metadata required');
      const bytes = sdk.readOriginal(row.path, maximum); need(bytes.length === row.bytes && hash(bytes) === row.sha256, 'full binary metadata original differs'); return record(JSON.parse(bytes.toString()));
    };
    const master = json(sdk.masterReference, 8 * 1024 ** 2);
    const identity = record(master.identity);
    need(identity.sourceSha === source.sourceSha && identity.target === sdk.originFacts.target, 'same SDK source/target identity required');
    if (!master.debianBinaries) return Object.freeze({facts: Object.freeze(facts), pending: Object.freeze(['qlever-sdk-Debian-binary-originals-unavailable'])});
    const contextArchive = reference(json(master.sourceContext).archive);
    let retainedSourceBytes = contextArchive.bytes;
    for (const row of sdk.members) {check(); if (row.path.startsWith('inner/')) retainedSourceBytes += row.bytes;
      need(Number.isSafeInteger(retainedSourceBytes) && retainedSourceBytes <= limits.sourceMaterialBytes, 'whole retained inner/context/binary shared source byte budget');}
    need(reference(master.debianBinaries).path === 'debian-binary-collection.json', 'fixed root binary collection role');
    const collection = json(master.debianBinaries);
    need(collection.schemaVersion === 1 && collection.kind === 'qlever-sdk-exact-debian-binary-originals' && collection.target === sdk.originFacts.target, 'binary collection target/schema differs');
    need(reference(collection.innerMaterials).path === 'inner/debian-binary/materials.json', 'fixed inner binary collection role');
    const inner = json(collection.innerMaterials), {innerMaterials: _innerMaterials, ...root} = collection;
    need(isDeepStrictEqual(root, normalize(inner)), 'whole root/inner binary collection seal differs');
    const after = record(master.inputs);
    need(isDeepStrictEqual(after.after, inputs.afterReference), 'same verified full-shard installed inventory required');
    const sources = json(master.debianSources);
    need(sources.kind === 'qlever-sdk-exact-debian-source-originals' && sources.schemaVersion === 1, 'same signed Sources collection required');
    const coordinates = array(sources.packages).map(value => {const row = record(value); reference(row.dsc); need(typeof row.name === 'string' && typeof row.version === 'string', 'exact signed source tuple'); return {name: row.name, version: row.version};});
    const signatureRows = array(record(signature.sdkDebianSignatureOriginals).observations).map(value => reference(record(value).inRelease));
    need(signatureRows.length > 0 && array(collection.indexOriginals).every(value => {const row = reference(record(value).inRelease); return signatureRows.some(signed => signed.bytes === row.bytes && signed.sha256 === row.sha256);}), 'binary InRelease not in the same private signature observation');
    // Fix all controller bytes before reading any candidate ZIP. No public
    // callback or caller-selected executable/helper can issue this fact.
    const helperDigests=new Map<string,string>();
    const helpers = HELPERS.map(([name]) => {
      const file = fileURLToPath(new URL('../../../qlever/scripts/' + name, import.meta.url)), observed = hashSignatureControllerFile(file, check);
      helperDigests.set(name,observed.sha256);return observed.identity;
    });
    selectSdkControllerHelperGroup(REVIEWED_HELPER_GROUPS,helperDigests);helpers.forEach(assertLegalFileIdentity);
    const python = realpathSync('/usr/bin/python3'), pythonOriginal = hashSignatureControllerFile(python, check);
    const limitsOriginal = hashSignatureControllerFile(fileURLToPath(new URL('../module-artifact-limits.json', import.meta.url)), check);
    need(limitsOriginal.sha256 === moduleSourcePhasePolicy.limits, 'reviewed shared limit authority differs');
    const assertCurrent = () => {
      need(qleverSdkOriginalsView(capability) === sdk && derivedSourceView(sourceCapability) === source
        && qleverSdkDebianSignatureObservation(capability) === signature && qleverSdkDebianIndexObservation(capability) === sourceIndex, 'SDK binary source/signature custody revoked');
      const currentInputs = sdkVerifiedInputOriginalView(capability);
      need(currentInputs?.rows === inputs.rows && currentInputs.afterReference === inputs.afterReference, 'SDK installed full-shard custody changed');
      assertDerivedSourceCurrent(sourceCapability); for (const guard of [...helpers, pythonOriginal.identity, limitsOriginal.identity]) assertLegalFileIdentity(guard);
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
    // These fields have been parsed by the fixed helper after the same-SDK
    // original and private installed-input joins. Freeze copies before issuance.
    freeze(observed);
    if (!files.length) {
      facts.sdkSelectedDebianBinaryFilesVerified = false;
      facts.sdkDebianBinaryUnresolved = unresolved;
      for (const row of unresolved) {const item = record(row); pending.push('qlever-sdk-Debian-binary-file-unresolved:' + String(item.installedPath) + ':' + String(item.reason));}
      if (!pending.length) pending.push('qlever-sdk-Debian-binary-file-observations-unavailable');
      return Object.freeze({facts: Object.freeze(facts), pending: Object.freeze(pending)});
    }
    const view: BinaryObservation = Object.freeze({files: files as unknown as readonly DebianInstalledBinaryFile[],
      unresolved: unresolved as unknown as BinaryObservation['unresolved'],
      scope: 'same-SDK installed file bytes equal signed-Packages official deb data members; no build/toolchain closure', assertCurrent});
    issued.set(capability as object, view);
    facts.sdkSelectedDebianBinaryFilesVerified = true; facts.sdkDebianBinaryFiles = view.files; facts.sdkDebianBinaryScope = view.scope;
    for (const row of view.unresolved) pending.push('qlever-sdk-Debian-binary-file-unresolved:' + row.installedPath + ':' + row.reason);
    return Object.freeze({facts: Object.freeze(facts), pending: Object.freeze(pending), assertCurrent});
  } catch (error) {pending.push('qlever-sdk-Debian-binary-originals-unverified: ' + String(error instanceof Error ? error.message : error).slice(0, 1024));}
  return Object.freeze({facts: Object.freeze(facts), pending: Object.freeze(pending)});
}

// Frozen only after the final helper and shared ZIP-domain delta are reviewed.
const HELPERS: readonly (readonly [string, string])[] = [["sdk-debian-binary-originals.py", "6db9772344afe812f3a58fc04296b63c13bbd4be1d46ae2ad7fcff181111c63c"], ["sdk-debian-index-bindings.py", "ad87a17bdb781f34a6a78a5e970d1f9c69d0750a1fcc4ba3f711db317bd75e13"], ["sdk-zip-originals.py", "304a8d26c8a124af31f2b240f1b2af52312520982cd6e1f4cba70fde2602bcb8"]];

const REVIEWED_HELPER_GROUPS=Object.freeze([HELPERS,Object.freeze(HELPERS.map(([name,sha])=>Object.freeze([name,name==='sdk-zip-originals.py'?'86cca59ac6a30eb719fe10dbaf6939c4e7c50328e757f22d3d4d34ea90fe6c10':name==='sdk-debian-binary-originals.py'?'099959565f355566b9a1f6f20870e2de20a5ef20ff37fc0042a9943238a4e86f':sha] as const)))])
