import {inspectNativeHostOriginals} from './candidate-service-native-host-originals';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {realpathSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {inspectDebianSourceArchiveCore, type ArchiveCoordinate} from './qlever-debian-source-archive-core';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import * as githubOrigin from './github-origin';
import {nativeOriginalsView, assertCollectedNativeOriginalCustody} from './native-original-collector';
import {derivedSourceView, assertDerivedSourceCurrent, readDerivedSourceOriginals} from './source-context';
import {qleverSdkOriginalsView} from './qlever-sdk-originals';
import {qleverSdkSourceAdmissionView, sdkVerifiedInputOriginalView} from './qlever-sdk-source';
import {inspectDebianIndexCore} from './qlever-sdk-debian-index';
import {inspectDebianSignatureCore} from './qlever-sdk-debian-signature';
import {inspectDebianBinaryCore} from './qlever-sdk-debian-binary';
import {captureLegalFileIdentity, assertLegalFileIdentity,resolveExecutableIdentityPath} from './legal-file-custody';
import {joinNativeInputSnapshots, type NativeInputSnapshot, type NativeInputCovered} from './candidate-service-native-input-join';
import {qleverSdkUpstreamGitObservation} from './qlever-sdk-upstream-source';
import normalSmokeCases from '../normal-local-runtime-smoke-cases.json';

const MAXIMUM = 128 * 1024 ** 2, META = 4 * 1024 ** 2, RANGE = 64 * 1024;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function need(value: unknown, reason: string): asserts value {if (!value) throw Error('Native runtime source: ' + reason);}
type Budget = Readonly<{check(): void; remainingMs(): number; reserveBytes(bytes: number): void; chargeReadBytes(bytes: number): void}>;
/** Local helper byte mechanics only; consumes the caller's existing ledger. */
export function readNativeRuntimeLocalHelper(file:string,budget:Pick<Budget,'check'|'remainingMs'|'chargeReadBytes'>){
  budget.check();need(budget.remainingMs()>0,'shared helper deadline expired');
  const identity=captureLegalFileIdentity(file);
  need(identity.size>=0n&&identity.size<=BigInt(META),'local helper metadata byte ceiling');
  const size=Number(identity.size);budget.chargeReadBytes(size);budget.check();
  need(budget.remainingMs()>0,'shared helper deadline expired');assertLegalFileIdentity(identity);
  const bytes=readFileSync(file);budget.check();assertLegalFileIdentity(identity);
  need(bytes.length===size,'local helper exact byte count');need(budget.remainingMs()>0,'shared helper deadline expired');
  return Object.freeze({identity,bytes});
}
type Ref = Readonly<{path: string; bytes: number; sha256: string}>;
type Input = Readonly<{originals: unknown; source: unknown; sdkOriginals: unknown; sdkAdmission: unknown; budget: Budget}>;
// Only this module can place an observation in the private map. JSON/copies are
// never interpreted as capabilities; every getter rechecks all original handles.
export type CandidateServiceNativeInputBinding=NativeInputCovered & Readonly<{sourceCoordinate?:Readonly<{name:string;version:string}>}>;
export interface CandidateServiceNativeRuntimeOriginalView {
 readonly identity: object;
 readonly members: readonly Readonly<Record<string, unknown>>[];
 readonly sourceArchives: readonly ArchiveCoordinate[];
 inputBindingsForMember(name:string): readonly CandidateServiceNativeInputBinding[];
 assertCurrent(): void;
 readSourceArchiveRange(name:string,offset:number,length:number):Buffer;
 readMemberRange(name:string,offset:number,length:number):Buffer;
}
const issued = new WeakMap<object, {input: Input; view: CandidateServiceNativeRuntimeOriginalView; current(): void}>();
function relative(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && !/[\\\x00-\x1f]/u.test(name)
    && !name.startsWith('/') && name.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {Object.values(value).forEach(immutable); Object.freeze(value);} return value;
}

/** Pending-axis bookkeeping only, never a capability issuer. Production calls
 * this only with results of the same live index/signature observations. */
export function nativeRuntimePendingAfterSignature(input: {
  mechanics: readonly string[]; index: readonly string[]; signature: readonly string[];
  signatureVerified: boolean;
}): string[] {
  const awaitingSignature = 'qlever-sdk-official-Debian-keyring-gpgv-and-suite-authority-unverified';
  return [...input.mechanics, ...input.index.filter(reason => !input.signatureVerified || reason !== awaitingSignature), ...input.signature];
}

/** Observe the actual native artifact. Partial results carry concrete pending
 * paths and are deliberately absent from the private capability map. */
export async function observeCandidateServiceNativeRuntimeOriginals(input: Input) {
  const native = nativeOriginalsView(input.originals);
  need(native, 'sole collected native originals required'); assertCollectedNativeOriginalCustody(input.originals);
  const isNative = (githubOrigin as unknown as Record<string, unknown>).isCandidateServiceNativeRuntimeGitHubOrigin;
  need(typeof isNative === 'function' && isNative(native.origin), 'actual native GitHub origin required');
  const source = derivedSourceView(input.source); need(source, 'same private source required'); assertDerivedSourceCurrent(input.source,input.budget);
  const sdk = qleverSdkOriginalsView(input.sdkOriginals);
  const admission = qleverSdkSourceAdmissionView(input.sdkAdmission, {sdkOriginals: input.sdkOriginals, source: input.source});
  if (!sdk || !admission) return immutable({verified: false, pending: ['verified-service-trixie-SDK-admission-required'], facts: {}});
  need(sdk.sdkProfile === 'service-trixie', 'actual service-trixie SDK required');
  const guards: ReturnType<typeof captureLegalFileIdentity>[] = [];
  const continuations: (() => void)[] = [];
  const current = () => {
    input.budget.check(); need(input.budget.remainingMs() > 0, 'shared deadline expired');
    assertCollectedNativeOriginalCustody(input.originals); assertDerivedSourceCurrent(input.source,input.budget);
    need(nativeOriginalsView(input.originals) === native && derivedSourceView(input.source) === source
      && qleverSdkOriginalsView(input.sdkOriginals) === sdk
      && qleverSdkSourceAdmissionView(input.sdkAdmission, {sdkOriginals: input.sdkOriginals, source: input.source}) === admission,
    'same original capabilities changed');
    guards.forEach(assertLegalFileIdentity);
  };
  current();
  const members = new Map(native.members.map(row => [row.path, row]));
  need(members.size === native.members.length, 'unique actual members');
  const reference = (value: any): Ref => {
    current(); const actual = members.get(value?.path);
    need(actual && relative(actual.path) && actual.bytes === value.bytes && actual.sha256 === value.sha256, 'exact retained original reference');
    return Object.freeze({path: actual.path, bytes: actual.bytes, sha256: actual.sha256});
  };
  const read = (value: Ref, maximum = META) => {
    const row = reference(value); need(row.bytes <= maximum, 'metadata bound');
    const data = native.readOriginal(row.path, maximum); need(data.length === row.bytes && hash(data) === row.sha256, 'retained metadata differs'); return data;
  };
  const masterRow = members.get('materials.json'); need(masterRow, 'actual materials.json required');
  const masterRef = reference(masterRow), master = JSON.parse(read(masterRef).toString());
  // PROOF-MODEL DISPATCH. A legacy master (no proofModel) keeps the original
  // controller-readonly interpretation byte-for-byte. A master that declares a
  // model MUST declare the ordinary one; adding a model field to legacy bytes
  // can never buy a different reading, and the normal observer re-derives every
  // fact from the actual held originals instead of trusting the declaration.
  if (master.proofModel !== undefined || master.kind === NORMAL_RUNTIME_KIND) {
    need(master.proofModel === NORMAL_RUNTIME_MODEL && master.kind === NORMAL_RUNTIME_KIND,
      'declared native runtime proof model differs from its retained master kind');
    return observeNormalLocalRuntime({masterRef, master, read, native, source, sdk, admission,
      current, reference, members, publish(observation, view) { issued.set(observation, {input, view, current}); }});
  }
  need(master.schemaVersion === 1 && master.kind === 'candidate-service-native-runtime-originals', 'native master schema');
  const identity = master.identity;
  need(identity?.target === 'linux-x64' || identity?.target === 'linux-arm64', 'supported native target');
  need(identity?.sourceSha === source.sourceSha && identity.sourceSha === native.originFacts.sourceSha
    && identity.runId === native.originFacts.runId && identity.runAttempt === native.originFacts.runAttempt
    && identity.target === native.originFacts.target && identity.sdkProfile === 'service-trixie', 'native original identity');
  // App-vs-SDK ORIGIN PARTITION: the SDK is acquired from its own GitHub
  // coordinates and legitimately carries a different source commit. Equality of
  // source SHAs is not a predicate. What must hold is the immutable SDK tuple
  // the native build actually compiled against: the exact SDK master original
  // the native master names, the same run/attempt/target coordinates that
  // master records, and the same SDK image digest used for the build.
  need(sdk.originFacts.runId === identity.runId && sdk.originFacts.runAttempt === identity.runAttempt
    && sdk.originFacts.target === identity.target, 'same SDK run/attempt/target');
  const sdkMasterRaw = sdk.readOriginal(sdk.masterReference.path, META);
  need(sdkMasterRaw.length===sdk.masterReference.bytes&&hash(sdkMasterRaw)===sdk.masterReference.sha256,'SDK master bytes differ');
  const sdkMaster = JSON.parse(sdkMasterRaw.toString());
  need(identity.sdkImage === sdkMaster.image?.referenceByDigest, 'native build must use actual qualified SDK image');
  need(/^ghcr\.io\/undefinedsco\/xpod-qlever-local-runtime@sha256:[a-f0-9]{64}$/u.test(identity.runtimeImage)
    && /^sha256:[a-f0-9]{64}$/u.test(identity.runtimeConfigDigest), 'immutable runtime image/config');
  need(Array.isArray(master.originals), 'native closed inventory');
  const refs = master.originals.map(reference) as Ref[], names = new Set(refs.map(row => row.path));
  const total = refs.reduce((sum, row) => sum + row.bytes, masterRef.bytes);
  need(!names.has('materials.json') && names.size === refs.length && members.size === names.size + 1
    && native.members.every(row => row.path === 'materials.json' || names.has(row.path))
    && total <= MAXIMUM && master.retainedOriginalBytes === total - masterRef.bytes, 'same 128MiB complete member domain');
  input.budget.reserveBytes(total);
  need(Array.isArray(master.hostOriginals) && master.hostOriginals.length > 0, 'actual host originals required');
  // Durable host-scope limitations from the normal producer. These are
  // observations, not grants: any recorded scope pending propagates into the
  // native pending list instead of being lost to host stdout.
  const hostPending = master.hostPending;
  need(hostPending === undefined || (Array.isArray(hostPending) && hostPending.length <= 64
    && hostPending.every((row: any) => typeof row === 'string' && row.length <= 512)),
    'bounded durable host pending required');
  const jobs = native.metadataOriginals.filter(row => /^jobs(?:-page-\d+)?\.original\.json$/u.test(row.name)).flatMap(row => {
    const expected = native.originFacts.originals.find(value => value.name === row.name);
    need(expected && expected.bytes === row.data.length && expected.sha256 === hash(row.data), 'actual job API originals');
    return JSON.parse(row.data.toString()).jobs;
  });
  const actualJobs = jobs.filter((row: any) => row.id === native.originFacts.producerJobId);
  need(actualJobs.length === 1 && actualJobs[0].name === identity.job && actualJobs[0].conclusion === 'success', 'same native producer job');
  const host = inspectNativeHostOriginals({identity, containers: master.hostIdentity,
    window: {started: Date.parse(actualJobs[0].started_at), completed: Date.parse(actualJobs[0].completed_at)},
    read(name) {const row = members.get(name); need(row && master.hostOriginals.some((item: any) => isDeepStrictEqual(reference(item), reference(row))), 'retained host original membership'); return read(reference(row));}, check: current});
  const runtimeInventory = JSON.parse(read(reference(master.runtimeInventoryOriginal)).toString());
  need(isDeepStrictEqual(runtimeInventory, master.runtimeMembers), 'complete actual runtime inventory equals replay output');

  const helper = fileURLToPath(new URL('../../../qlever/scripts/sdk-service-native-runtime-receiver.py', import.meta.url));
  const python = resolveExecutableIdentityPath('/usr/bin/python3'); guards.push(captureLegalFileIdentity(python));
  const helperNames=['sdk-service-native-runtime-receiver.py', 'sdk-zip-originals.py', 'sdk-generation-multiprocess-bindings.py',
    'sdk-raw-wire-reader.py', 'sdk-execution-originals-util.py', 'sdk-original-chunk-store.py', 'sdk-executable-memory-policy.py',
    'sdk-tool-provider-originals.py', 'sdk-generated-vma-originals.py', 'sdk-coordinated-wait.py'];
  need(Array.isArray(master.sourceInventory), 'actual retained Git inventory');
  for(const row of master.sourceInventory)need(relative(row.sourcePath)&&source.trackedPaths.includes(row.sourcePath),'actual tracked Git path');
  const heldSource=await readDerivedSourceOriginals(input.source,[...new Set<string>([...helperNames.map(name=>'qlever/scripts/'+name),'scripts/lib/module-artifact-limits.json','qlever/scripts/sdk-debian-source-materials.py',...master.sourceInventory.map((row:any)=>row.sourcePath)])],input.budget);
  continuations.push(heldSource.assertCurrent);
  for (const name of helperNames) {
    const file = fileURLToPath(new URL('../../../qlever/scripts/' + name, import.meta.url));
    const local=readNativeRuntimeLocalHelper(file,input.budget);guards.push(local.identity);
    need(hash(local.bytes) === hash(heldSource.readTracked('qlever/scripts/' + name)), 'source-bound native receiver dependency: ' + name);
    assertLegalFileIdentity(local.identity);
  }
  const limitsFile = fileURLToPath(new URL('../module-artifact-limits.json', import.meta.url));
  const localLimits=readNativeRuntimeLocalHelper(limitsFile,input.budget);guards.push(localLimits.identity);
  need(hash(localLimits.bytes) === hash(heldSource.readTracked('scripts/lib/module-artifact-limits.json')), 'source-bound unchanged limits');
  const mechanics = await native.withArchiveFile(async archive => {
    current(); need(archive.identity.bytes === native.archive.bytes && archive.identity.sha256 === native.archive.sha256, 'same held ZIP');
    const plan = Buffer.from(JSON.stringify({master: masterRef, remainingMilliseconds: Math.floor(input.budget.remainingMs()), remainingOriginalBytes: MAXIMUM}));
    return JSON.parse(execFileSync(python, ['-I', '-S', '-B', helper, '--observe-native', archive.path], {
      input: plan, maxBuffer: META, timeout: Math.max(1, Math.floor(input.budget.remainingMs())), env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'},
    }).toString());
  }, input.budget);
  current(); need(mechanics.kind === 'candidate-service-native-runtime-mechanics' && isDeepStrictEqual(mechanics.identity, identity)
    && mechanics.originalBytes === total && mechanics.sourceAuthorityVerified === false, 'actual same-master kernel replay');
  need(Array.isArray(mechanics.inputEvents) && Array.isArray(mechanics.facts?.toolchainFileSnapshots), 'ordered replay inputs required');
  const git: NativeInputSnapshot[] = [];
  need(Array.isArray(master.sourceInventory), 'actual retained Git inventory');
  for (const item of master.sourceInventory) {
    current(); need(relative(item.sourcePath) && source.trackedPaths.includes(item.sourcePath), 'actual tracked Git path');
    const ref = reference(item.original);
    const original = heldSource.readTrackedGitObject(item.sourcePath);
    need(original.bytes.length === ref.bytes, 'actual retained Git exact byte bound');
    need(original.mode === '100644' || original.mode === '100755', 'ordinary Git input');
    need(hash(original.bytes) === ref.sha256, 'actual retained Git bytes differ');
    git.push({path: '/workspace/xpod/' + item.sourcePath, bytes: ref.bytes, sha256: ref.sha256, mode: original.mode === '100755' ? 0o755 : 0o644});
  }
  const inputs = sdkVerifiedInputOriginalView(input.sdkOriginals); need(inputs, 'qualified SDK input inventory required');
  const sdkRows = inputs.rows.map(row => ({path: row.originalPath, bytes: row.bytes, sha256: row.sha256, mode: row.mode & 0o7777}));
  // Full authenticated upstream/FetchContent source rows for applicable notices.
  // These are the same private canonical rows; no path-only or new issuer.
  const sourceOriginals: {path:string;bytes:number;sha256:string;mode:number}[] = [];
  try {
    const upstreamView = qleverSdkUpstreamGitObservation(input.sdkOriginals) as any;
    for (const row of upstreamView?.postpatchMembers ?? []) sourceOriginals.push({path: '/opt/qlever-sdk/source/' + row.path, bytes: row.bytes, sha256: row.sha256, mode: row.mode});
  } catch { /* optional axis; absence stays pending downstream */ }
  const tools: NativeInputSnapshot[] = mechanics.facts.toolchainFileSnapshots.map((row: any) => ({path: row.observedPath,
    bytes: reference(row.original).bytes, sha256: reference(row.original).sha256, mode: row.identity[2] & 0o7777}));
  const priorGenerated: NativeInputSnapshot[] = [], needsApt: NativeInputSnapshot[] = [];
  for (const event of mechanics.inputEvents) {
    if (event.kind === 'producer-close') priorGenerated.push(event);
    else {need(event.kind === 'source-read', 'known ordered input event');
      needsApt.push(...joinNativeInputSnapshots({reads: [event], generated: priorGenerated, git, sdk: sdkRows, sourceOriginals}).unresolved);}
  }
  needsApt.push(...joinNativeInputSnapshots({tools, git, sdk: sdkRows}).unresolved);
  const aptRows = [...new Map(needsApt.map(row => [JSON.stringify([row.path, row.bytes, row.sha256, row.mode]), row])).values()];
  const reader = {...native, originFacts: {...native.originFacts, sourceSha: source.sourceSha, target: identity.target as string}, kind: 'candidate-service-native-runtime-originals' as const, sdkProfile: 'service-trixie', masterReference: masterRef, materialRoot: '/out/artifact/inner'};
  const index = await inspectDebianIndexCore({reader, remainingMs: input.budget.remainingMs(), check: current, current});
  const signature = await inspectDebianSignatureCore({reader, remainingMs: input.budget.remainingMs(), check: current, current,
    prerequisites: {indexInRelease: index.checksums.map(row => ({sha256: row.inReleaseSha256, sourceOriginal: row.sourceOriginal, signedIndexMatches: row.observation.signedIndexMatches}))}});
  if (signature.assertCurrent) continuations.push(signature.assertCurrent);
  const signatureFacts = signature.facts.sdkDebianSignatureOriginals as {observations?: {inRelease: Ref}[]} | undefined;
  const signatureVerified = signature.facts.sdkDebianOfficialSignatureAndSuiteVerified === true
    && typeof signature.assertCurrent === 'function' && !!signatureFacts?.observations?.length && index.checksums.length > 0;
  if (signatureVerified) signature.assertCurrent!();
  const pending = nativeRuntimePendingAfterSignature({mechanics: mechanics.pending, index: index.pending,
    signature: signature.pending, signatureVerified});
  let debian: NativeInputSnapshot[] = [];
  let sourceCoordinates: {name: string; version: string}[] = [];
  const debianInputCoordinates=new Map<string,Readonly<{name:string;version:string}>>();
  if (signatureVerified && signatureFacts?.observations) {
    const binary = await inspectDebianBinaryCore({reader, source, remainingMs: input.budget.remainingMs(), check: current, current,
      prerequisites: {inputs: {rows: aptRows.map(row => ({...row, originalPath: row.path}))}, signatureVerified: true,
        signatureInRelease: signatureFacts.observations.map(row => row.inRelease), indexInRelease: index.checksums.map(row => ({sha256: row.inReleaseSha256})), sourceSha: source.sourceSha, target: identity.target},
      validateContext({master: observed, reference: retained}) {need(isDeepStrictEqual(observed, master), 'same held native context'); retained(master.debianBinaries); retained(master.debianSources);},
    });
    pending.push(...binary.pending);
    sourceCoordinates = (binary.files ?? []).map(row => row.source);
    for(const row of binary.files??[]){const key=JSON.stringify([row.installedPath,row.bytes,row.sha256,row.mode&0o7777]),coordinate=Object.freeze({...row.source}),prior=debianInputCoordinates.get(key);need(!prior||isDeepStrictEqual(prior,coordinate),'same Debian input source coordinate');debianInputCoordinates.set(key,coordinate);}
    if (binary.assertCurrent) continuations.push(binary.assertCurrent);
    debian = (binary.files ?? []).map(row => ({path: row.installedPath, bytes: row.bytes, sha256: row.sha256, mode: row.mode & 0o7777}));
  }
  const generated: NativeInputSnapshot[] = [], unresolved: unknown[] = [], sourceBindings: NativeInputCovered[] = [];
  for (const event of mechanics.inputEvents) {
    if (event.kind === 'producer-close') generated.push(event);
    else {need(event.kind === 'source-read', 'known replay event'); const joined=joinNativeInputSnapshots({reads: [event], generated, git, sdk: sdkRows, debian, sourceOriginals});unresolved.push(...joined.unresolved);sourceBindings.push(...joined.covered.filter(row=>row.via!=='generated'));}
  }
  unresolved.push(...joinNativeInputSnapshots({tools, git, sdk: sdkRows, debian}).unresolved);
  for (const row of unresolved as NativeInputSnapshot[]) pending.push('native-input-source-unresolved:' + row.path + ':' + row.sha256);
  const sourceCollection = JSON.parse(read(reference(master.debianSources)).toString());
  need(sourceCollection.schemaVersion === 1 && sourceCollection.kind === 'qlever-sdk-exact-debian-source-originals', 'actual source collection');
  const parser = fileURLToPath(new URL('../../../qlever/scripts/sdk-debian-source-materials.py', import.meta.url));
  const localParser=readNativeRuntimeLocalHelper(parser,input.budget);const parserGuard=localParser.identity;guards.push(parserGuard);
  need(hash(localParser.bytes) === hash(heldSource.readTracked('qlever/scripts/sdk-debian-source-materials.py')), 'same source-bound existing DSC parser');
  const archiveResult = inspectDebianSourceArchiveCore({packages: sourceCollection.packages,
    allowedCoordinates: sourceCoordinates, reader: native, reference, small: value => read(value),
    maximumFileBytes: MAXIMUM, maximumTotalBytes: MAXIMUM - masterRef.bytes, check: current,
    parseDsc(bytes) {
      current(); const result = execFileSync(python, ['-I', '-S', '-B', parser, '--parse-dsc'], {input: bytes,
        maxBuffer: META, timeout: Math.max(1, Math.min(15000, Math.floor(input.budget.remainingMs()))), env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'}});
      current(); return JSON.parse(result.toString());
    },
  });
  for (const coordinate of sourceCoordinates) if (!archiveResult.coordinates.some(row => row.name === coordinate.name && row.version === coordinate.version))
    pending.push('native-owned-source-archive-unavailable:' + coordinate.name + ':' + coordinate.version);
  // Index core binds the actual DSC to signed Sources; archive core hashes every
  // declared orig/debian member. Neither result alone is official source authority.
  if (!signature.assertCurrent || signature.facts.sdkDebianOfficialSignatureAndSuiteVerified !== true || !index.checksums.length)
    pending.push('native-official-source-authority-unverified');
  need(master.runtimeMembers && typeof master.runtimeMembers === 'object' && !Array.isArray(master.runtimeMembers), 'complete runtime members');
  const runtime: any[] = [], runtimeRefs = new Map<string, Ref>();
  const bindCoordinate=(row:NativeInputCovered):CandidateServiceNativeInputBinding=>{const sourceCoordinate=row.via==='debian'?debianInputCoordinates.get(JSON.stringify([row.path,row.bytes,row.sha256,row.mode])):undefined;need(row.via!=='debian'||sourceCoordinate,'authenticated Debian input source coordinate');return Object.freeze({...row,...(sourceCoordinate?{sourceCoordinate}:{})});};
  const phaseBindings=Object.freeze([...new Map(sourceBindings.map(row=>[JSON.stringify(row),bindCoordinate(row)])).values()]);
  const memberBindings=new Map<string,readonly CandidateServiceNativeInputBinding[]>();
  for (const [name, raw] of Object.entries(master.runtimeMembers)) {
    current(); need(relative(name), 'runtime relative path'); const row = raw as any;
    need(row && ['file', 'directory', 'symlink'].includes(row.type) && Number.isInteger(row.mode)
      && row.mode >= 0 && row.mode <= 0o7777, 'typed runtime member');
    const absolute = '/opt/xpod/qlever/' + name;
    if (row.type === 'file') {
      const ref = reference({...row, path: 'retained/runtime/' + name}); runtimeRefs.set(name, ref);
      if (![...generated, ...git, ...sdkRows, ...debian].some(input => input.bytes === row.bytes && input.sha256 === row.sha256 && input.mode === row.mode))
        pending.push('native-runtime-output-source-unresolved:' + name + ':' + row.sha256);
      // Generated output inherits the conservative complete phase input union.
      // This is provenance only: consumers must establish each applicable grant.
      if(generated.some(input=>input.bytes===row.bytes&&input.sha256===row.sha256&&input.mode===row.mode))memberBindings.set(name,phaseBindings);
      else {const copied=([['git',git],['sdk',sdkRows],['debian',debian]] as const).flatMap(([via,inputs])=>inputs.filter(input=>input.bytes===row.bytes&&input.sha256===row.sha256&&input.mode===row.mode).map(input=>Object.freeze({...input,kind:'reads' as const,via})));memberBindings.set(name,Object.freeze(copied.map(bindCoordinate)));}
      runtime.push({path: absolute, type: 'file', mode: row.mode, bytes: ref.bytes, sha256: ref.sha256});
    } else {
      need(row.bytes === 0, 'non-file zero bytes');
      if (row.type === 'symlink') {
        need(typeof row.target === 'string' && row.target && !/[\\\x00-\x1f]/u.test(row.target), 'actual link target');
        const resolved = path.posix.resolve(path.posix.dirname(absolute), row.target);
        need(resolved === '/opt/xpod/qlever' || resolved.startsWith('/opt/xpod/qlever/'), 'runtime link escape');
        const target = resolved.slice('/opt/xpod/qlever/'.length);
        need(resolved === '/opt/xpod/qlever' || Object.prototype.hasOwnProperty.call(master.runtimeMembers, target), 'runtime link missing target');
      }
      runtime.push({path: absolute, type: row.type, mode: row.mode, bytes: 0, ...(row.type === 'symlink' ? {target: row.target} : {})});
    }
  }
  need(runtime.length > 0, 'nonempty complete runtime inventory');
  const assertCurrent = () => {current(); continuations.forEach(check => check());};
  assertCurrent();
  const hostPendingRows: string[] = Array.isArray(master.hostPending) ? master.hostPending.map((row: any) => String(row)) : [];
  const retainedNotices = master.retainedNoticeOriginals ?? [];
  need(Array.isArray(retainedNotices) && retainedNotices.length <= 1024, 'bounded retained notice rows required');
  const noticeFacts = Object.freeze(retainedNotices.map((row: any) => Object.freeze({...row})));
  const facts = immutable({identity: {...identity}, originalBytes: total, replayedInputEvents: mechanics.inputEvents.length, host,
    retainedNoticeOriginals: noticeFacts,
    unresolvedInputs: unresolved, sourceArchives: archiveResult.coordinates, runtimeMembers: runtime});
  // F9: the producer's notice rows must be actual runtime members with the
  // same relative path/bytes/SHA. Notice claims alone never satisfy this.
  const runtimeByRelative = new Map(runtime.map((row: any) => [row.path.replace('/opt/xpod/qlever/', ''), row]));
  // The physical source-root prefix per semantic universe. This is the ONE
  // mapping between plane P3 (semantic namespace) and plane P1 (in-image
  // absolute path); nothing else re-derives a path from a key.
  const SOURCE_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
    // V13: the workspace COPY scope is /workspace/xpod (root LICENSE) plus
    // /workspace/xpod/qlever (COPY roots + qlever.lock.json). There is no
    // qlever/LICENSE in the real checkout, so the ancestor file keys as
    // `workspace:LICENSE` from the workspace root, exactly like the program.
    workspace: '/workspace/xpod/',
    qleverCopy: '/workspace/xpod/qlever/',
    upstream: '/opt/qlever-sdk/source/',
    dependency: '/opt/qlever-sdk/dependencies/',
  });
  // V10-6/V10-8: a notice must be an actual runtime member AND be bound to an
  // actual contributing source original (Git path+blob / SDK member /
  // dependency declared row). A universe label alone is not evidence.
  // C3: the contributor key namespace MUST be exactly the one the fixed
  // program emits (see run-focused-native-build.sh `add()`):
  //   workspace:<rel>            top-level COPY_FILES
  //   workspace/<copyRoot>:<rel> COPY-root recursive notices
  //   upstream:<rel>             SDK source root
  //   dependency/<name>:<rel>    declared FetchContent contributor
  // Only authenticated rows from the actual inventories populate this map, so a
  // lookup success means the bytes really came from a retained original.
  const sourceByKey = new Map<string, {path: string; bytes: number; sha256: string; mode: number}>();
  const addKey = (key: string, row: {path: string; bytes: number; sha256: string; mode: number}) => {
    const prior = sourceByKey.get(key);
    // V13: a conflicting insertion REFUSES immediately. Silently keeping the
    // first row would let a notice bind to the wrong contributor, and deferring
    // the check to a later pass over Map entries is unreachable because Map keys
    // are unique by construction.
    if (prior) {
      need(prior.bytes === row.bytes && prior.sha256 === row.sha256 && prior.mode === row.mode,
        'contributor key namespace is ambiguous: ' + key);
    }
    sourceByKey.set(key, row);
  };
  // Workspace COPY roots: git rows already carry /workspace/xpod/qlever/<root>/<rel>.
  for (const row of git) {
    if (row.path.startsWith(SOURCE_PREFIXES.qleverCopy!)) {
      // COPY-root / qlever.lock.json rows live under /workspace/xpod/qlever/.
      const rel = row.path.slice(SOURCE_PREFIXES.qleverCopy!.length);
      addKey('workspace:' + rel, row);
      const [head, ...rest] = rel.split('/');
      if (rest.length > 0 && head) addKey('workspace/' + head + ':' + rest.join('/'), row);
      continue;
    }
    if (row.path.startsWith(SOURCE_PREFIXES.workspace!)) {
      // Ancestor workspace-root file (e.g. LICENSE): key is workspace:<name>.
      const rel = row.path.slice(SOURCE_PREFIXES.workspace!.length);
      if (!rel.includes('/')) addKey('workspace:' + rel, row);
    }
  }
  // SDK upstream source rows, keyed by their manifest-relative path.
  for (const row of sourceOriginals) {
    if (!row.path.startsWith(SOURCE_PREFIXES.upstream!)) continue;
    addKey('upstream:' + row.path.slice(SOURCE_PREFIXES.upstream!.length), row);
  }
  // Declared FetchContent dependencies: authenticated SDK input rows whose
  // original path is under a declared dependency root.
  for (const row of inputs.rows) {
    const path = row.originalPath;
    const match = /^\/opt\/qlever-sdk\/dependencies\/([^/]+)\/(.+)$/u.exec(path);
    if (!match) continue;
    addKey('dependency/' + match[1] + ':' + match[2],
      {path, bytes: row.bytes, sha256: row.sha256, mode: row.mode & 0o7777});
  }
  for (const notice of retainedNotices) {
    current();
    need(notice && typeof notice.relative === 'string' && notice.relative.startsWith('notices/')
      && typeof notice.sha256 === 'string' && Number.isSafeInteger(notice.bytes)
      && notice.bytes >= 0
      && typeof notice.sourcePath === 'string'
      && ['/opt/qlever-sdk/source/', '/opt/qlever-sdk/dependencies/', '/workspace/xpod/'].some(prefix => notice.sourcePath.startsWith(prefix))
      && typeof notice.sourcePathKey === 'string' && notice.sourcePathKey
      && !!notice.contributor && typeof notice.contributor === 'object'
      && !!notice.sourceOriginal && typeof notice.sourceOriginal === 'object',
      'canonical retained notice row required');
    const member = runtimeByRelative.get(notice.relative);
    if (!member || member.bytes !== notice.bytes || member.sha256 !== notice.sha256)
      pending.push('native-retained-notice-not-actual-runtime-member:' + notice.relative + ':' + notice.sha256);
    const candidate = sourceByKey.get(notice.sourcePathKey);
    if (!candidate) pending.push('native-retained-notice-unbound-contributor:' + notice.sourcePathKey);
    else if (candidate.sha256 !== notice.sha256 || candidate.bytes !== notice.bytes)
      pending.push('native-retained-notice-contributor-bytes-differ:' + notice.sourcePathKey);
    // C3/C4: the receipt's sourceOriginal ref is NOT taken as authority. When it
    // names a real retained materials original, that exact original is opened
    // through the bounded held-original reader and its declared bytes/SHA must
    // match, so the contributor identity is authenticated rather than labelled.
    const declared = notice.sourceOriginal;
    if (declared && typeof declared === 'object' && typeof declared.kind === 'string') {
      // The producer retains the authenticated contributor inventory as a real
      // original and references it; open THOSE bytes through the same bounded
      // held-original reader. The receipt's relative label is not authority.
      const retainedRef = declared.original;
      if (retainedRef && typeof retainedRef === 'object'
        && typeof retainedRef.path === 'string' && Number.isSafeInteger(retainedRef.bytes)
        && typeof retainedRef.sha256 === 'string'
        && Number.isSafeInteger(declared.bytes) && declared.sha256 === retainedRef.sha256) {
        try {
          const raw = read(retainedRef as Ref);
          need(raw.length === retainedRef.bytes && hash(raw) === retainedRef.sha256,
            'notice source original bytes differ');
          need(raw.length === declared.bytes, 'notice source original size differs from declaration');
        } catch {
          pending.push('native-retained-notice-source-original-unavailable:' + notice.sourcePathKey);
        }
      } else if (declared.kind === 'fetchcontent-source-inventory') {
        pending.push('native-retained-notice-source-original-unavailable:' + notice.sourcePathKey);
      }
    } else {
      pending.push('native-retained-notice-source-original-unauthenticated:' + notice.sourcePathKey);
    }
  }
  pending.push(...hostPendingRows);
  if (pending.length) return immutable({verified: false, pending: [...new Set(pending)], facts});
  const observation = immutable({verified: true, pending: [], facts});
  // Legal consumers receive only the already-authenticated Debian source
  // originals; this reader conveys bytes, never a grant decision.
  const sourceArchiveRefs = new Map(archiveResult.coordinates.flatMap(row => [row.dsc, ...row.archives]).map(row => [row.path, row]));
  const view = Object.freeze({identity: facts.identity, members: facts.runtimeMembers, sourceArchives: archiveResult.coordinates, assertCurrent,
    inputBindingsForMember(name:string){assertCurrent();const rows=memberBindings.get(name);need(rows,'actual native output member input mapping');return rows;},
    readSourceArchiveRange(name: string, offset: number, length: number) {
      assertCurrent(); const ref = sourceArchiveRefs.get(name); need(ref, 'authenticated native source archive member');
      need(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(length) && length >= 0 && length <= RANGE
        && offset + length <= ref.bytes, 'bounded native source original range');
      return Buffer.from(native.readOriginalRange(ref.path, offset, length));
    },
    readMemberRange(name: string, offset: number, length: number) {
      assertCurrent(); const ref = runtimeRefs.get(name); need(ref, 'exact runtime-relative member');
      need(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(length) && length >= 0 && length <= RANGE
        && offset + length <= ref.bytes, 'bounded member range');
      return Buffer.from(native.readOriginalRange(ref.path, offset, length));
    }});
  issued.set(observation, {input, view, current: assertCurrent});
  return observation;
}


/** Ordinary-model constants. These are consumer-side names only; the producer
 * records them in the retained master so a legacy master can never be re-read
 * as an ordinary one merely by adding fields at the consumer. */
export const NORMAL_RUNTIME_MODEL = 'normal-runtime-v1' as const;
export const NORMAL_RUNTIME_KIND = 'candidate-service-normal-runtime-originals' as const;
const NORMAL_NON_CLAIMS = ['generatedInputCausality', 'kernelReadOnlyEnforcement',
  'syscallSourceReadInventory', 'toolchainExecutionLifetime'] as const;
const NORMAL_RECIPE_PATHS = ['docker/qlever-local-runtime/Dockerfile',
  'qlever/scripts/run-focused-native-build.sh', 'qlever/qlever.lock.json'] as const;
const NORMAL_MEMBER_ROOT = '/opt/xpod/qlever';
// The ordinary focused build's COPY scope. This is the same declared scope the
// host enumerates with `git ls-files`; requiring the consumer-side set to equal
// it prevents a pruned inventory from masquerading as a complete input union.
const NORMAL_SOURCE_SCOPE = ['LICENSE', 'qlever/cmake', 'qlever/include',
  'qlever/qlever.lock.json', 'qlever/patches', 'qlever/qlever_adapter',
  'qlever/qlever_local_runtime', 'qlever/rdf_protocol', 'qlever/rdf_sqlite_backend',
  'qlever/scripts', 'docker/qlever-local-runtime/Dockerfile'] as const;
const inNormalScope = (name: string) => NORMAL_SOURCE_SCOPE.some(root =>
  name === root || name.startsWith(root + '/'));

function normalNeed(value: unknown, why: string): asserts value {
  if (!value) throw Error('Normal runtime evidence: ' + why);
}
const NORMAL_SMOKE_PREFIX = ['docker', 'run', '--rm', '-i', '--network', 'none',
  '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m'] as const;
function smokePayload(stdout: string, stderr: string) {
  normalNeed(typeof stderr === 'string', 'actual smoke stderr required');
  let rows: any[];
  try { rows = stdout.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)); }
  catch (error) { throw Error('Normal runtime evidence: smoke stdout is not JSON lines: ' + String(error).slice(0, 256)); }
  const ready = rows.filter(row => row?.type === 'ready');
  normalNeed(ready.length === 1 && Number.isInteger(ready[0].adapterAbiVersion)
    && Number.isInteger(ready[0].physicalBackendAbiVersion), 'actual ready/ABI smoke required');
  for (const smokeCase of normalSmokeCases) {
    const id = smokeCase.request.id;
    const hits = rows.filter(row => row?.id === id);
    normalNeed(hits.length === 1 && hits[0]?.type === 'result'
      && hits[0]?.result?.status === 'ok',
      'actual semantic smoke result required: ' + id);
    let body: any;
    try { body = JSON.parse(hits[0].result.body); }
    catch { throw Error('Normal runtime evidence: invalid SPARQL result body: ' + id); }
    normalNeed(isDeepStrictEqual(body?.results?.bindings, smokeCase.bindings),
      'exact semantic smoke bindings required: ' + id);
  }
  normalNeed(!rows.some(row => row?.type === 'error'), 'smoke reported a protocol error');
  return {adapterAbiVersion: ready[0].adapterAbiVersion,
    physicalBackendAbiVersion: ready[0].physicalBackendAbiVersion,
    resultIds: normalSmokeCases.map(row => row.request.id)};
}

/** Validate and issue the ORDINARY local-runtime evidence. Every predicate is
 * derived from retained bytes plus the already-issued SDK/source/native
 * capabilities; the master's own declarations are never authority. */
export interface NormalLocalRuntimeReadContext {
  read(value: any, maximum?: number): Buffer;
  reference(value: any): any;
  members: Map<string, any>;
  native: any;
  source: any;
  sdk: any;
  admission: any;
  current(): void;
}
/** Pure ordinary-model validation over already-retained bytes. It reads only
 * through the caller's bounded `read`/`reference` closures and never invokes a
 * process, so a test can exercise every predicate without a fake child. */
export function inspectNormalLocalRuntimeMaster(masterRef: any, master: any, context: NormalLocalRuntimeReadContext) {
  const {read, reference, members, native, source, sdk, admission, current} = context;
  normalNeed(master.schemaVersion === 1 && master.kind === NORMAL_RUNTIME_KIND
    && master.proofModel === NORMAL_RUNTIME_MODEL, 'normal master schema/model');
  const identity = master.identity ?? {};
  normalNeed(identity.sourceSha === source.sourceSha && identity.sourceSha === native.originFacts.sourceSha
    && identity.runId === native.originFacts.runId && identity.runAttempt === native.originFacts.runAttempt,
    'normal master source/run coordinates differ from the actual local-runtime job');
  normalNeed((identity.target === 'linux-x64' || identity.target === 'linux-arm64')
    && identity.target === native.originFacts.target, 'same supported normal target as the native origin');
  normalNeed(identity.sdkProfile === 'service-trixie', 'actual service-trixie SDK profile required');
  normalNeed(identity.job === 'publish',
    'normal master must name the fixed local-runtime publish job');
  normalNeed(/^[a-f0-9]{64}$/u.test(String(identity.sdkInputHash ?? ''))
    && master.sdkInputHash === identity.sdkInputHash, 'canonical normal SDK input hash required');
  normalNeed(/^ghcr\.io\/undefinedsco\/xpod-qlever-sdk@sha256:[a-f0-9]{64}$/u.test(String(identity.sdkImage ?? ''))
    && /^ghcr\.io\/undefinedsco\/xpod-qlever-local-runtime@sha256:[a-f0-9]{64}$/u.test(String(identity.runtimeImage ?? ''))
    && /^sha256:[a-f0-9]{64}$/u.test(String(identity.runtimeConfigDigest ?? '')), 'immutable SDK/runtime image and config digests required');
  normalNeed(master.runtimeImage === identity.runtimeImage
    && master.runtimeConfigDigest === identity.runtimeConfigDigest, 'normal master duplicated identity differs');
  normalNeed(master.releaseAccepted === false && Array.isArray(master.pending) && master.pending.length === 0,
    'normal master must not claim release acceptance or carry pending prerequisites');
  normalNeed(master.guarantees && typeof master.guarantees === 'object'
    && JSON.stringify(Object.keys(master.guarantees).sort()) === JSON.stringify([...NORMAL_NON_CLAIMS].sort())
    && NORMAL_NON_CLAIMS.every(key => master.guarantees[key] === false), 'normal non-claims must stay explicit and false');
  normalNeed(typeof master.scope === 'string' && /does NOT prove/iu.test(master.scope), 'normal scope must state its non-claims');

  // SDK provenance: the retained SDK master must be the same immutable image and
  // the same normal-build producer tuple. This is a join of already-issued
  // capabilities, not a second claim minted from this JSON.
  const sdkMaster = JSON.parse(sdk.readOriginal(sdk.masterReference.path, META).toString());
  normalNeed(sdkMaster?.kind === 'qlever-linux-sdk-originals'
    && sdkMaster.buildExecutionModel === 'normal-build-v1', 'actual normal-build-v1 SDK master required');
  normalNeed(sdkMaster.image?.referenceByDigest === identity.sdkImage, 'normal master SDK image differs from the retained SDK');
  normalNeed(sdkMaster.identity?.sourceSha === sdk.originFacts.sourceSha
    && sdkMaster.identity?.runId === sdk.originFacts.runId
    && sdkMaster.identity?.runAttempt === sdk.originFacts.runAttempt
    && sdkMaster.identity?.sdkProfile === identity.sdkProfile
    && sdkMaster.identity?.target === identity.target, 'normal master SDK provenance differs from the retained SDK');
  normalNeed(sdk.originFacts.sourceSha !== undefined && sdk.originFacts.artifactId > 0, 'same issued SDK origin required');
  // The producer job original is retained by the same authenticated GitHub
  // origin as the native archive. A reusable workflow reports its API name as
  // `<caller> / <job>`, so only the final segment must be this master's job.
  const jobs = native.metadataOriginals
    .filter((row: any) => /^jobs(?:-page-\d+)?\.original\.json$/u.test(row.name))
    .flatMap((row: any) => {
      const expected = native.originFacts.originals.find((value: any) => value.name === row.name);
      normalNeed(expected && expected.bytes === row.data.length && expected.sha256 === hash(row.data),
        'actual job API originals');
      return JSON.parse(row.data.toString()).jobs ?? [];
    })
    .filter((row: any) => row.id === native.originFacts.producerJobId);
  normalNeed(jobs.length === 1 && String(jobs[0].name ?? '').split(' / ').at(-1) === identity.job
    && jobs[0].conclusion === 'success', 'same successful local-runtime producer job');
  normalNeed(admission?.verified === true && admission?.facts?.sdkBuildExecutionModel === 'normal-build-v1'
    && admission?.facts?.sdkNormalBuildAdmissionVerified === true,
    'genuine verified normal-build-v1 SDK admission required');
  normalNeed(sdkMaster.normalBuild?.inputHash === identity.sdkInputHash,
    'normal master canonical SDK input hash differs from the retained SDK proof');

  // Recipe files must equal bytes actually tracked in the SAME immutable source
  // checkout; a caller JSON cannot declare a different recipe.
  const recipe = master.recipe;
  normalNeed(recipe && typeof recipe === 'object' && /^[a-f0-9]{40}$/u.test(String(recipe.qleverTree ?? '')),
    'actual qlever tree identity required');
  for (const path of NORMAL_RECIPE_PATHS) {
    normalNeed(/^[a-f0-9]{64}$/u.test(String(recipe[path] ?? '')), 'normal recipe hash required: ' + path);
    normalNeed(source.trackedPaths.includes(path), 'normal recipe path is not tracked: ' + path);
    const bytes = source.readTracked(path);
    normalNeed(hash(bytes) === recipe[path], 'normal recipe bytes differ from the immutable source: ' + path);
  }
  const inventoryRef = master.sourceInventory;
  normalNeed(inventoryRef && inventoryRef.path === 'source-inventory.json', 'actual source inventory original required');
  const inventory = JSON.parse(read(inventoryRef).toString());
  normalNeed(Array.isArray(inventory) && inventory.length > 0 && inventory.length <= 100000,
    'bounded actual source inventory required');
  // The ordinary model makes NO syscall read claim. What it can state honestly
  // is the COMPLETE DECLARED build input union: every Git-tracked file in the
  // focused Dockerfile COPY scope, re-hashed from the same immutable checkout.
  // Legal/ABI consumers get that union as the conservative provenance of every
  // runtime output; they must not read it as per-output causality.
  const expectedInputs = source.trackedPaths.filter(inNormalScope).sort();
  normalNeed(JSON.stringify(inventory.map((row: any) => String(row?.path ?? '')).sort())
    === JSON.stringify(expectedInputs.map((name: string) => './' + name)),
    'declared build input inventory is not the complete fixed COPY scope');
  const union: any[] = [];
  for (const row of inventory) {
    normalNeed(row && typeof row.path === 'string' && row.path.startsWith('./')
      && /^[a-f0-9]{64}$/u.test(String(row.sha256 ?? ''))
      && Number.isSafeInteger(row.bytes) && row.bytes >= 0
      && Number.isInteger(row.mode) && row.mode >= 0 && row.mode <= 0o7777,
      'typed declared build input required');
    const sourcePath = row.path.slice(2);
    normalNeed(source.trackedPaths.includes(sourcePath), 'declared input is not tracked: ' + sourcePath);
    const bytes = source.readTracked(sourcePath);
    normalNeed(bytes.length === row.bytes && hash(bytes) === row.sha256,
      'declared build input bytes differ from the immutable checkout: ' + sourcePath);
    union.push(Object.freeze({path: '/workspace/xpod/' + sourcePath, bytes: row.bytes,
      sha256: row.sha256, mode: row.mode, kind: 'reads' as const, via: 'git' as const,
      scope: 'complete-declared-build-input-union'}));
  }
  const declaredUnion = Object.freeze(union);

  // Runtime member inventory: closed, typed, and containing the actual executable.
  const runtimeMembers = master.runtimeMembers;
  normalNeed(runtimeMembers && typeof runtimeMembers === 'object' && !Array.isArray(runtimeMembers),
    'complete normal runtime members required');
  const runtime: any[] = [];
  for (const [name, raw] of Object.entries(runtimeMembers)) {
    current(); normalNeed(relative(name), 'runtime relative path');
    const row = raw as any;
    normalNeed(row && ['file', 'directory', 'symlink'].includes(row.type)
      && Number.isInteger(row.mode) && row.mode >= 0 && row.mode <= 0o7777
      && Number.isSafeInteger(row.bytes) && row.bytes >= 0, 'typed normal runtime member');
    const absolute = NORMAL_MEMBER_ROOT + '/' + name;
    if (row.type === 'file') {
      normalNeed(/^[a-f0-9]{64}$/u.test(String(row.sha256 ?? '')), 'normal runtime file sha256');
      reference({...row, path: 'artifact/runtime/' + name});
      runtime.push({path: absolute, type: 'file', mode: row.mode, bytes: row.bytes, sha256: row.sha256});
    } else {
      normalNeed(row.bytes === 0, 'structural normal member has zero bytes');
      if (row.type === 'symlink') {
        normalNeed(typeof row.target === 'string' && row.target, 'normal link target required');
        const resolved = path.posix.resolve(path.posix.dirname(absolute), row.target);
        normalNeed(resolved === NORMAL_MEMBER_ROOT || resolved.startsWith(NORMAL_MEMBER_ROOT + '/'),
          'normal runtime link escape');
      }
      runtime.push({path: absolute, type: row.type, mode: row.mode, bytes: 0,
        ...(row.type === 'symlink' ? {target: row.target} : {})});
    }
  }
  normalNeed(runtime.some(row => row.path === NORMAL_MEMBER_ROOT + '/bin/xpod_qlever_local_runtime' && row.type === 'file'),
    'actual normal runtime executable member required');

  // Closed original set: no orphan, no unregistered body, no duplicate member.
  normalNeed(Array.isArray(master.originals) && master.originals.length > 0, 'normal original inventory required');
  const names = new Set<string>();
  let total = masterRef.bytes;
  for (const row of master.originals) {
    current(); const ref = reference(row);
    normalNeed(!names.has(ref.path) && ref.path !== 'materials.json', 'unique normal original reference');
    names.add(ref.path); total += ref.bytes;
    normalNeed(total <= MAXIMUM, 'normal original byte bound');
  }
  normalNeed(master.retainedOriginalBytes === total - masterRef.bytes, 'normal retained byte total differs');
  normalNeed(members.size === names.size + 1
    && [...names].every(name => members.has(name)), 'normal originals are not the complete member set');
  for (const row of runtime) if (row.type === 'file')
    normalNeed(names.has('artifact/runtime/' + row.path.slice(NORMAL_MEMBER_ROOT.length + 1)),
      'normal runtime file lacks its retained original');

  // Functional smoke: exact command, actual wait/exit, and the original streams.
  const smoke = master.smoke;
  normalNeed(smoke && smoke.evidence && smoke.commandReceipt && smoke.stdout && smoke.stderr,
    'normal functional smoke originals required');
  const smokeRaw = JSON.parse(read(smoke.evidence).toString());
  normalNeed(smokeRaw.schemaVersion === 1 && smokeRaw.kind === 'normal-local-runtime-functional-smoke'
    && smokeRaw.proofModel === NORMAL_RUNTIME_MODEL, 'normal functional smoke schema/model');
  normalNeed(Array.isArray(smokeRaw.command)
    && JSON.stringify(smokeRaw.command.slice(0, NORMAL_SMOKE_PREFIX.length)) === JSON.stringify([...NORMAL_SMOKE_PREFIX])
    && smokeRaw.command[NORMAL_SMOKE_PREFIX.length] === '--name'
    && /^xpod-normal-runtime-smoke-[a-f0-9]{16}$/u.test(String(smokeRaw.command[NORMAL_SMOKE_PREFIX.length + 1]))
    && smokeRaw.command[NORMAL_SMOKE_PREFIX.length + 2] === '--mount'
    && String(smokeRaw.command[NORMAL_SMOKE_PREFIX.length + 3] ?? '').startsWith('type=bind,src=')
    && smokeRaw.command[NORMAL_SMOKE_PREFIX.length + 4] === identity.runtimeImage
    && smokeRaw.command.at(-2) === '--sqlite-path' && smokeRaw.command.length === NORMAL_SMOKE_PREFIX.length + 7,
    'normal functional smoke is not the expected immutable-image execution');
  normalNeed(smokeRaw.exit === 0 && smokeRaw.signal === null && smokeRaw.actualWait === true
    && smokeRaw.rawClosedBeforeHash === true && smokeRaw.ownedGroupAbsentAfterWait === true,
    'normal functional smoke did not actually run and close successfully');
  const mount = /^type=bind,src=(\/[^,\r\n\0]+),dst=\/data$/u
    .exec(String(smokeRaw.command[NORMAL_SMOKE_PREFIX.length + 3]));
  normalNeed(mount && path.posix.normalize(mount[1]!) === mount[1]
    && smokeRaw.command.at(-1) === '/data/runtime-smoke.sqlite',
    'normal smoke must use its owned database mount');
  normalNeed(JSON.stringify(smokeRaw.stdout) === JSON.stringify(smoke.stdout)
    && JSON.stringify(smokeRaw.stderr) === JSON.stringify(smoke.stderr)
    && JSON.stringify(smokeRaw.commandReceipt) === JSON.stringify(smoke.commandReceipt),
    'normal smoke reference set differs');
  const stdout = read(smoke.stdout, 4 * 1024 ** 2).toString();
  const stderr = read(smoke.stderr, 1024 ** 2).toString();
  const receipt = JSON.parse(read(smoke.commandReceipt).toString());
  const driver = receipt.command;
  normalNeed(Array.isArray(driver) && driver.length === 5
    && driver[0] === 'python3' && driver[1] === '-B'
    && typeof driver[2] === 'string' && driver[2].startsWith('/')
    && path.posix.normalize(driver[2]) === driver[2]
    && driver[2].endsWith('/scripts/collect-normal-local-runtime-originals.py')
    && driver[3] === '--smoke-session' && typeof driver[4] === 'string',
    'normal smoke must execute the reviewed sequential protocol driver');
  normalNeed(isDeepStrictEqual(JSON.parse(driver[4]), smokeRaw.command),
    'normal smoke driver argv differs from its actual immutable-image command');
  normalNeed(receipt.schemaVersion === 1 && receipt.actualWait === true && receipt.exit === 0
    && receipt.signal === null && receipt.rawClosedBeforeHash === true
    && receipt.stdout?.bytes === smoke.stdout.bytes && receipt.stdout?.sha256 === smoke.stdout.sha256
    && receipt.stderr?.bytes === smoke.stderr.bytes && receipt.stderr?.sha256 === smoke.stderr.sha256,
    'normal smoke command receipt differs from its raw originals');
  const facts = smokePayload(stdout, stderr);
  normalNeed(JSON.stringify(facts) === JSON.stringify(smokeRaw.facts), 'normal smoke facts differ from the retained raw streams');

  const refs = new Map<string, any>();
  for (const row of master.originals) refs.set(row.path, reference(row));
  const assertCurrent = () => {
    current();
    const raw = sdk.readOriginal(sdk.masterReference.path, META);
    normalNeed(hash(raw) === sdk.masterReference.sha256, 'normal SDK master changed');
    normalNeed(native.readOriginal('materials.json', META).length === masterRef.bytes,
      'normal native master changed');
    for (const row of master.originals) {
      const ref = reference(row);
      normalNeed(refs.get(row.path)?.sha256 === ref.sha256, 'normal original reference changed');
    }
  };
  assertCurrent();
  const runtimeByName = new Map<string, any>(runtime.map(row => [row.path.slice(NORMAL_MEMBER_ROOT.length + 1), row]));
  const view: CandidateServiceNativeRuntimeOriginalView = Object.freeze({
    identity: Object.freeze({...identity}),
    members: Object.freeze(runtime),
    sourceArchives: Object.freeze([]) as unknown as readonly ArchiveCoordinate[],
    inputBindingsForMember(name: string) {
      assertCurrent();
      // Conservative COMPLETE DECLARED build-input union for this actual runtime
      // member. This is provenance of the recipe scope, explicitly not a
      // syscall-observed per-output read set; the master's nonClaims say so.
      normalNeed(runtimeByName.has(name), 'actual normal runtime member required');
      return declaredUnion as readonly CandidateServiceNativeInputBinding[];
    },
    assertCurrent,
    readSourceArchiveRange(): Buffer {
      throw Error('Normal runtime evidence has no syscall-derived Debian source archive');
    },
    readMemberRange(name: string, offset: number, length: number) {
      assertCurrent();
      const row = runtimeByName.get(name);
      normalNeed(row && row.type === 'file', 'exact normal runtime member required');
      normalNeed(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(length)
        && length >= 0 && length <= RANGE && offset + length <= row.bytes, 'bounded normal member range');
      return Buffer.from(native.readOriginalRange('artifact/runtime/' + name, offset, length));
    },
  });
  const observation = Object.freeze({schemaVersion: 1, kind: NORMAL_RUNTIME_KIND,
    proofModel: NORMAL_RUNTIME_MODEL, identity: view.identity, pending: [] as readonly string[]});
  return Object.freeze({observation, view,
    facts: Object.freeze({identity: view.identity, runtimeMembers: view.members,
      smokeFacts: facts, nonClaims: Object.freeze([...NORMAL_NON_CLAIMS]),
      inputUnionScope: 'complete-declared-build-input-union'})});
}
function observeNormalLocalRuntime(input: NormalLocalRuntimeReadContext & {
  masterRef: any; master: any; publish(observation: object, view: CandidateServiceNativeRuntimeOriginalView): void;
}) {
  const inspected = inspectNormalLocalRuntimeMaster(input.masterRef, input.master, input);
  input.publish(inspected.observation, inspected.view);
  return inspected.observation;
}
export function candidateServiceNativeRuntimeOriginalsView(value: unknown, originals: unknown, source: unknown, sdkOriginals: unknown, sdkAdmission: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const row = issued.get(value);
  if (!row || row.input.originals !== originals || row.input.source !== source || row.input.sdkOriginals !== sdkOriginals || row.input.sdkAdmission !== sdkAdmission) return undefined;
  row.current(); return row.view;
}
