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

export function candidateServiceNativeRuntimeOriginalsView(value: unknown, originals: unknown, source: unknown, sdkOriginals: unknown, sdkAdmission: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const row = issued.get(value);
  if (!row || row.input.originals !== originals || row.input.source !== source || row.input.sdkOriginals !== sdkOriginals || row.input.sdkAdmission !== sdkAdmission) return undefined;
  row.current(); return row.view;
}
