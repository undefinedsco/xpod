import {inspectDebianSourceArchiveCore} from './qlever-debian-source-archive-core';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { derivedSourceView, assertDerivedSourceCurrent } from './source-context';
import limits from '../module-artifact-limits.json';
import { inspectSdkInputOwnership } from './qlever-sdk-inputs';
import { inspectSdkBuildExecution, SdkTrackedPhaseOriginalsUnobserved, SDK_TRACKED_PHASE_UNOBSERVED } from './qlever-sdk-execution';
import { inspectSdkSymlinkOriginals } from './qlever-sdk-symlinks';
import { qleverSdkOriginalsView } from './qlever-sdk-originals';
import { qleverSdkUpstreamGitObservation } from './qlever-sdk-upstream-source';
import { qleverSdkFetchContentByteRows } from './qlever-sdk-fetchcontent';
import { captureLegalFileIdentity, assertLegalFileIdentity,resolveExecutableIdentityPath} from './legal-file-custody';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const SHA = /^[a-f0-9]{64}$/u;
const HELPER_SHA = 'dddb499b82df467ff41511dd6dfab5877ed7d63cbcfa88fb772be9e6152aca6c';
/** The ONE composite obligation the mechanical byte pass cannot discharge. It
 * names two real proofs (generated-input causality and full toolchain source
 * causality) and is retired ONLY by the operational path once every
 * independently verified axis plus every live same-handle guard holds. */
export const SDK_COMPOSITE_SOURCE_GAP = 'qlever-sdk-generated-input-and-full-toolchain-source-causality-not-yet-verified';
const safe = (name: unknown): name is string => typeof name === 'string' && Boolean(name) && !name.startsWith('/') && !/[\\\u0000-\u001f\u007f]/u.test(name) && !name.split('/').some(part => !part || part === '.' || part === '..');
function need(value: unknown, reason: string): asserts value { if (!value) throw Error('QLever SDK source: ' + reason); }
type SourceOriginalReference=Readonly<{path:string;bytes:number;sha256:string}>;
type SourceArchiveOriginalView=Readonly<{sourceSha:string;target:string;collection:SourceOriginalReference;ledger:SourceOriginalReference;coordinates:readonly Readonly<{name:string;version:string;dsc:SourceOriginalReference;archives:readonly SourceOriginalReference[]}>[];requiredCoordinates:readonly Readonly<{name:string;version:string}>[];absentOwnedCoordinates:readonly Readonly<{name:string;version:string}>[];ownedCoordinatesComplete:boolean;scope:'actual DSC and complete archive checksum mechanics only';officialAuthorityVerified:false;assertCurrent():void}>;
/** The SAME verified full-shard input map, now also carrying the verified input
 * ownership view derived during that one verification. The ownership rows hold
 * each input's signed-Debian binary/source tuples; without this the leaf had no
 * bridge to them at all. The map stays private and currentness-guarded. */
type VerifiedInputOwnership=Readonly<{
  inputRows:readonly Readonly<{path:string;role:string;observedBeforeCompile:boolean;
    owners:readonly Readonly<{binary:string;binaryVersion:string;
      source:Readonly<{name:string;version:string}>}>[]}>[];
  unresolvedInputs:readonly Readonly<{path:string;role:string;reason:string}>[]}>;
const verifiedInputs = new WeakMap<object, Readonly<{sourceArchiveView?:SourceArchiveOriginalView;sdk: NonNullable<ReturnType<typeof qleverSdkOriginalsView>>; afterReference: Readonly<{path: string; bytes: number; sha256: string}>; rows: readonly Readonly<{originalPath: string; bytes: number; sha256: string; mode: number}>[]; ownership: VerifiedInputOwnership}>>();
type SdkSourceAdmissionResult = Readonly<{verified: boolean; facts: Readonly<Record<string, unknown>>; pending: readonly string[]; assertCurrent(): void}>;
const sourceAdmissions = new WeakMap<object, Readonly<{sdkOriginals: unknown; source: unknown; result: SdkSourceAdmissionResult}>>();
/** Only the actual complete observer result, bound to both original private handles. */
export function qleverSdkSourceAdmissionView(value: unknown, input: {sdkOriginals: unknown; source: unknown}): SdkSourceAdmissionResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const held = sourceAdmissions.get(value);
  if (!held || held.sdkOriginals !== input.sdkOriginals || held.source !== input.source || !held.result.verified) return undefined;
  held.result.assertCurrent();
  return held.result;
}
/** Reuses the one actual full-shard verification, never caller JSON facts. */
export function sdkVerifiedInputOriginalView(capability: unknown) {
  if (!capability || typeof capability !== 'object') return undefined;
  const value = verifiedInputs.get(capability);
  if (value && qleverSdkOriginalsView(capability) === value.sdk) {
    const raw = value.sdk.readOriginal(value.afterReference.path, limits.metadataBytes);
    need(raw.length === value.afterReference.bytes && hash(raw) === value.afterReference.sha256, 'verified input inventory custody changed');
    // Ownership comes from the SAME map entry, so a caller cannot supply it and
    // the existing currentness check covers it exactly like rows/afterReference.
    return Object.freeze({afterReference: value.afterReference, rows: value.rows, ownership: value.ownership});
  }
  return undefined;
}
/** Same existing verified-input map; no JSON or separate registration can issue this view. */
export function sdkVerifiedSourceArchiveOriginalView(capability:unknown):SourceArchiveOriginalView|undefined {
  if(!capability||typeof capability!=='object')return undefined;
  const view=verifiedInputs.get(capability)?.sourceArchiveView;view?.assertCurrent();return view;
}
/** Freeze the verified ownership projection. Only these fields are published:
 * the per-input role/before-compile fact and the signed binary/source tuple that
 * the SAME verification derived. Nothing here is caller-supplied. */
const verifiedOwnershipView=(ownership:any):VerifiedInputOwnership=>Object.freeze({
  inputRows: Object.freeze((ownership.inputRows??[]).map((row:any)=>Object.freeze({
    path: row.path, role: row.role, observedBeforeCompile: row.observedBeforeCompile === true,
    owners: Object.freeze((row.owners??[]).map((owner:any)=>Object.freeze({
      binary: owner.binary, binaryVersion: owner.binaryVersion,
      source: Object.freeze({name: owner.source.name, version: owner.source.version})}))) }))),
  unresolvedInputs: Object.freeze((ownership.unresolvedInputs??[]).map((row:any)=>Object.freeze({
    path: row.path, role: row.role, reason: row.reason})))});

/** SDK byte/source-set facts only. The one central SDK private binding is
 * required; no JSON can reconstruct it, or authorize a native/release gate. */
export function inspectQleverSdkSourceOriginals(capability: unknown, remainingMilliseconds = limits.timeoutMs): Readonly<{
  verified: false; pending: readonly string[]; facts: Readonly<Record<string, unknown>>;
}> {
  if (capability && typeof capability === 'object') verifiedInputs.delete(capability);
  const pending = new Set<string>(), facts: Record<string, unknown> = {sdkSourceCompletenessVerified: false};
  try {
    const sdk = qleverSdkOriginalsView(capability); need(sdk, 'issued related SDK originals required');
    need(Number.isFinite(remainingMilliseconds) && remainingMilliseconds >= 1, 'mechanical source observation deadline expired');
    const deadline = performance.now() + Math.min(remainingMilliseconds, limits.timeoutMs), members = new Map(sdk.members.map(row => [row.path, row]));
    const check = () => need(performance.now() < deadline, 'mechanical source observation deadline exceeded');
    const reference = (value: any) => {
      check(); const actual = members.get(value?.path);
      need(value && safe(value.path) && actual && actual.bytes === value.bytes && actual.sha256 === value.sha256 && SHA.test(actual.sha256), 'same SDK ZIP original reference required'); return actual;
    };
    const small = (value: any, maximum = limits.metadataBytes) => {
      const ref = reference(value); need(ref.bytes <= maximum, 'bounded SDK source metadata required');
      const bytes = sdk.readOriginal(ref.path, maximum); need(bytes.length === ref.bytes && hash(bytes) === ref.sha256, 'SDK source metadata bytes differ'); return bytes;
    };
    const master = JSON.parse(small(sdk.masterReference, 8 * 1024 ** 2).toString());
    facts.sdkFetchContentOriginalsRequired=master.fetchContentSources!==undefined;
    need(master.identity.sourceSha === sdk.originFacts.sourceSha && master.identity.target === sdk.originFacts.target && master.kind === 'qlever-linux-sdk-originals', 'SDK master/source binding differs');
    const helper = fileURLToPath(new URL('../../../qlever/scripts/sdk-debian-source-materials.py', import.meta.url));
    const helperIdentity = captureLegalFileIdentity(helper); need(helperIdentity.size <= BigInt(limits.metadataBytes) && hash(readFileSync(helper)) === HELPER_SHA, 'reviewed controller source parser differs');
    const python = resolveExecutableIdentityPath('/usr/bin/python3'), pythonIdentity = captureLegalFileIdentity(python);
    const parse = (mode: '--parse-dsc' | '--parse-ledger', bytes: Buffer) => {
      check(); assertLegalFileIdentity(helperIdentity); assertLegalFileIdentity(pythonIdentity);
      const output = execFileSync(python, ['-I', '-S', '-B', helper, mode], {input: bytes, maxBuffer: limits.metadataBytes,
        timeout: Math.max(1, Math.min(15000, Math.floor(deadline - performance.now()))), env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'}});
      assertLegalFileIdentity(helperIdentity); assertLegalFileIdentity(pythonIdentity); check(); return JSON.parse(output.toString());
    };
    const before = JSON.parse(small(master.inputs?.before).toString());
    const after = JSON.parse(small(master.inputs?.after).toString());
    need(Array.isArray(after.shards) && Array.isArray(master.inputs?.shards) && after.shards.length === master.inputs.shards.length
      && after.shards.every((row: any, index: number) => row.path && master.inputs.shards[index].path === 'inner/' + row.path
        && row.bytes === master.inputs.shards[index].bytes && row.sha256 === master.inputs.shards[index].sha256), 'inner/master actual shard references differ');
    const jobs = sdk.metadataOriginals.filter(row => /^jobs(?:-page-\d+)?\.original\.json$/u.test(row.name)).flatMap(row => {
      const original = sdk.originFacts.originals.find(value => value.name === row.name);
      need(original && original.bytes === row.data.length && original.sha256 === hash(row.data), 'actual SDK job API bytes differ');
      return JSON.parse(row.data.toString()).jobs;
    }).filter((row: any) => row.id === sdk.originFacts.producerJobId);
    need(jobs.length === 1, 'unique actual SDK build job required');
    let execution;
    try { execution = inspectSdkBuildExecution({master, members: sdk.members, jobWindow: {start: Date.parse(jobs[0].started_at), end: Date.parse(jobs[0].completed_at)},
      readOriginal: (name, maximum) => sdk.readOriginal(name, maximum), readRange: (name, offset, length) => sdk.readOriginalRange(name, offset, length), check});
    } catch(error) {
      if(!(error instanceof SdkTrackedPhaseOriginalsUnobserved))throw error;
      pending.add(SDK_TRACKED_PHASE_UNOBSERVED);execution={verified:false,pending:[SDK_TRACKED_PHASE_UNOBSERVED],generationMetadataReferenceSealVerified:error.generationMetadataOriginals!==undefined,readOnlyBuildOwnerReferenceSeal:error.readOnlyBuildOwnerReferenceSeal};
    }
    need(qleverSdkOriginalsView(capability) === sdk, 'SDK closed build original custody changed');
    facts.sdkConfigureCompileExecution = execution;
    facts.sdkReadOnlyBuildOwnerReferenceSeal=execution.readOnlyBuildOwnerReferenceSeal;
    facts.sdkReadOnlyExecutorRequired=master.buildExecutionModel==='controller-readonly-v1';
    facts.sdkConfigureCompileClosedExecutionVerified = execution.verified;
    facts.sdkGenerationMetadataReferenceSealVerified = execution.generationMetadataReferenceSealVerified === true;
    const ledgerReference = {...after.sourcePackageIdentityRaw, path: 'inner/' + after.sourcePackageIdentityRaw?.path};
    const ledger = parse('--parse-ledger', small(ledgerReference));
    const context = JSON.parse(small(master.sourceContext).toString());
    const total = reference(context.archive).bytes + master.inputs.shards.reduce((sum: number, ref: any) => sum + reference(ref).bytes, 0)
      + (master.inputs.symlinks?.before ? reference(master.inputs.symlinks.before).bytes : 0)
      + (master.inputs.symlinks?.after ? reference(master.inputs.symlinks.after).bytes : 0);
    need(total <= limits.sourceMaterialBytes, 'SDK context/input source domains exceed shared source budget');
    const ownership = inspectSdkInputOwnership({before, after, shards: master.inputs.shards.map(reference), ledger,
      readRange: (name, offset, length) => sdk.readOriginalRange(name, offset, length), check});
    facts.sdkActualInputShardBytesVerified = true;
    facts.sdkInputOwnership = ownership;
    if (master.inputs.symlinks?.before && master.inputs.symlinks?.after) {
      const refs = master.inputs.symlinks;
      need(refs.before.path === 'inner/' + after.symlinkBeforeOriginals?.path && refs.after.path === 'inner/' + after.symlinkAfterOriginals?.path
        && ['bytes', 'sha256'].every(key => refs.before[key] === after.symlinkBeforeOriginals[key] && refs.after[key] === after.symlinkAfterOriginals[key]), 'inner/master readlink references differ');
      const symlinks = inspectSdkSymlinkOriginals({before: JSON.parse(small(refs.before).toString()), after: JSON.parse(small(refs.after).toString()),
        inputRows: after.files, legacyLinks: after.symlinkOriginalTargets ?? [], check});
      need(qleverSdkOriginalsView(capability) === sdk, 'SDK readlink original custody changed');
      facts.sdkInputSymlinkOriginals = Object.freeze({before: reference(refs.before), after: reference(refs.after), ...symlinks});
      facts.sdkSelectedInputSymlinkBeforeAfterBytesVerified = symlinks.unresolved.length === 0;
      if (symlinks.unresolved.length) pending.add('qlever-sdk-input-symlink-before-after-causality-unverified');
    } else if (ownership.unresolvedSymlinkOriginalTargets.length) pending.add('qlever-sdk-input-symlink-before-after-causality-unverified');
    need(qleverSdkOriginalsView(capability) === sdk, 'SDK verified input snapshot custody changed');
    if (!ownership.unresolvedSymlinkOriginalTargets.length || facts.sdkSelectedInputSymlinkBeforeAfterBytesVerified === true) verifiedInputs.set(capability as object, Object.freeze({sdk, afterReference: Object.freeze({...reference(master.inputs.after)}),
      rows: Object.freeze(after.files.map((row: any) => Object.freeze({originalPath: row.originalPath, bytes: row.bytes, sha256: row.sha256, mode: row.mode}))),
      ownership: verifiedOwnershipView(ownership)}));
    facts.sdkExactDebianSourceTuplesDerivedFromActualOwnership = ownership.requiredSources;
    if (ownership.unresolvedInputs.some(row => row.role !== 'installed-metadata')) pending.add('qlever-sdk-Git-generated-or-other-non-Debian-input-source-authority-unresolved');
    need(qleverSdkOriginalsView(capability) === sdk, 'SDK input custody changed');
    if (!master.debianSources) {
      pending.add('qlever-sdk-exact-Debian-dsc-and-all-orig-debian-originals-unavailable');
      return Object.freeze({verified: false, pending: Object.freeze([...pending]), facts: Object.freeze(facts)});
    }
    const sources = JSON.parse(small(master.debianSources).toString());
    need(sources.schemaVersion === 1 && sources.kind === 'qlever-sdk-exact-debian-source-originals' && Array.isArray(sources.packages) && sources.packages.length > 0 && sources.packages.length <= 4096, 'SDK Debian source collection schema differs');
    need(reference(sources.sourceIdentities).path === ledgerReference.path, 'source acquisition ledger differs from actual SDK build ledger');
    const archiveResult = inspectDebianSourceArchiveCore({packages: sources.packages,
      allowedCoordinates: Object.values(ledger).map((row: any) => row.source), reader: sdk, reference, small,
      parseDsc: bytes => parse('--parse-dsc', bytes), maximumFileBytes: limits.shardBytes,
      maximumTotalBytes: limits.sourceMaterialBytes - total, check});
    const archiveCoordinates = archiveResult.coordinates, sourceBytes = archiveResult.sourceBytes;
    const seen = new Set(archiveCoordinates.map(row => row.name + '\0' + row.version));
    const originalReference = (value: any): SourceOriginalReference => {const ref = reference(value); return Object.freeze({path: ref.path, bytes: ref.bytes, sha256: ref.sha256});};
    need(qleverSdkOriginalsView(capability) === sdk, 'SDK source custody changed');
    facts.sdkRelatedOriginalCustodyVerified = true; facts.debianDscAndAllSourceArchiveBytesVerified = true;
    facts.debianSourcePackageInstances = seen.size; facts.debianSourceOriginalBytes = sourceBytes;
    pending.add('qlever-sdk-Debian-signed-Sources-InRelease-keyring-authority-not-yet-verified');
    const absent = ownership.requiredSources.filter(row => !seen.has(row.name + '\0' + row.version));
    facts.sdkDebianSourceArchiveMissingCoordinates = Object.freeze(absent);
    facts.sdkOwnedDebianInputSourceArchivesComplete = absent.length === 0;
    if (absent.length) pending.add('qlever-sdk-exact-owned-Debian-input-source-archives-incomplete');
    const inputSnapshot=verifiedInputs.get(capability as object);
    if(inputSnapshot){
      const target=sdk.originFacts.target;need(target==='linux-x64'||target==='linux-arm64','verified source archive requires actual Linux target');
      const collection=originalReference(master.debianSources),ledgerOriginal=originalReference(ledgerReference);
      const assertCurrent=()=>{
        need(verifiedInputs.get(capability as object)===retained,'verified source archive observation revoked');
        need(qleverSdkOriginalsView(capability)===sdk,'verified source archive SDK custody changed');
        need(sdkVerifiedInputOriginalView(capability)?.rows===inputSnapshot.rows,'verified source archive input custody changed');
        for(const ref of [collection,ledgerOriginal]){const raw=sdk.readOriginal(ref.path,limits.metadataBytes);need(raw.length===ref.bytes&&hash(raw)===ref.sha256,'verified source collection/ledger custody changed');}
        assertLegalFileIdentity(helperIdentity);assertLegalFileIdentity(pythonIdentity);
      };
      const coordinates=Object.freeze(archiveCoordinates),requiredCoordinates=Object.freeze(ownership.requiredSources.map(row=>Object.freeze({name:row.name,version:row.version}))),absentOwnedCoordinates=Object.freeze(absent.map(row=>Object.freeze({name:row.name,version:row.version})));
      const sourceArchiveView:SourceArchiveOriginalView=Object.freeze({sourceSha:sdk.originFacts.sourceSha,target,collection,ledger:ledgerOriginal,coordinates,requiredCoordinates,absentOwnedCoordinates,ownedCoordinatesComplete:absent.length===0,scope:'actual DSC and complete archive checksum mechanics only',officialAuthorityVerified:false,assertCurrent});
      const retained=Object.freeze({...inputSnapshot,sourceArchiveView});verifiedInputs.set(capability as object,retained);assertCurrent();
    }

    pending.add(SDK_COMPOSITE_SOURCE_GAP);
  } catch (error) { pending.add((error as Error).message); }
  return Object.freeze({verified: false, pending: Object.freeze([...pending]), facts: Object.freeze(facts)});
}


/** The CLOSED set of axes the composite SOURCE obligation actually represents.
 * A caller cannot shrink this list: an unknown/missing/extra axis is refused. */
export const SDK_SOURCE_REQUIRED_AXES = Object.freeze(['inputOriginals','preparedDependencySources','configureCompileExecution',
  'ownedDebianSourceArchives','upstreamGitPreimages','reviewedPatchProjection','selectedUpstreamInputOriginals',
  'generatedInputIoClosure','toolchainSourceClosure'] as const);

/** PURE, FAIL-CLOSED retirement rule for the ONE composite source gap.
 *
 * The composite token states: "generated-input causality AND full toolchain
 * source causality are not yet verified". It may be retired ONLY when the
 * complete closed axis set is independently true AND no other pending fact
 * remains AND the caller has just re-run its live same-handle guards.
 *
 * Every input here is an already-derived fact (never a caller-supplied
 * boolean): `axes` comes from verified views in this module, `pending` is the
 * accumulated set of real obligations, and `guardsCurrent()` re-asserts the
 * private capability/currentness chain. A missing axis, an extra axis, a false
 * axis, any residual pending, or a stale guard all leave the token in place.
 */
export function inspectSdkCompositeSourceRetirement(input:{
  axes:Readonly<Record<string,boolean>>;
  pending:ReadonlySet<string>;
  guardsCurrent:()=>boolean;
  contributing?:Readonly<{toolchainOperations:number}>;
}):Readonly<{retired:boolean;reason:string;axes:readonly string[]}>{
  const required=[...SDK_SOURCE_REQUIRED_AXES], keys=Object.keys(input.axes);
  if(keys.length!==required.length||!required.every(name=>Object.prototype.hasOwnProperty.call(input.axes,name)))
    return Object.freeze({retired:false,reason:'closed axis set differs',axes:required});
  const missing=required.filter(name=>input.axes[name]!==true);
  if(missing.length)return Object.freeze({retired:false,reason:'unverified axes: '+missing.join(','),axes:required});
  if(!input.pending.has(SDK_COMPOSITE_SOURCE_GAP))
    return Object.freeze({retired:false,reason:'composite obligation not present',axes:required});
  const residual=[...input.pending].filter(reason=>reason!==SDK_COMPOSITE_SOURCE_GAP);
  if(residual.length)return Object.freeze({retired:false,reason:'residual source obligations: '+residual.length,axes:required});
  const contributing=input.contributing;
  if(!contributing||!Number.isSafeInteger(contributing.toolchainOperations)||contributing.toolchainOperations<=0)
    return Object.freeze({retired:false,reason:'nonvacuous verified contributor set required',axes:required});
  let current=false;
  try{current=input.guardsCurrent()===true;}catch{current=false;}
  if(!current)return Object.freeze({retired:false,reason:'live same-handle guards are not current',axes:required});
  return Object.freeze({retired:true,reason:'every closed source axis, contributor and live guard verified',axes:required});
}

/** Operational source-axis orchestration. Inspect above remains the synchronous
 * byte-mechanics API; only this path consumes independent signature authority. */
export async function observeQleverSdkSourceAdmission(input: {sdkOriginals: unknown; source: unknown; remainingMilliseconds?: number}) {
  const sdk = qleverSdkOriginalsView(input.sdkOriginals), source = derivedSourceView(input.source);
  const pending = new Set<string>(), facts: Record<string, unknown> = {sdkSourceCompletenessVerified: false};
  let signatureObservation: Readonly<Record<string, unknown>> | undefined;
  let signatureGetter: typeof import('./qlever-sdk-debian-signature').qleverSdkDebianSignatureObservation | undefined;
  let binaryObservation: ReturnType<typeof import('./qlever-sdk-debian-binary').qleverSdkDebianBinaryObservation>;
  let binaryGetter: typeof import('./qlever-sdk-debian-binary').qleverSdkDebianBinaryObservation | undefined;
  const assertCurrent = () => {
    need(qleverSdkOriginalsView(input.sdkOriginals) === sdk && derivedSourceView(input.source) === source, 'SDK/source admission custody changed');
    if (source) assertDerivedSourceCurrent(input.source);
    generationGuard?.();
    observedToolGuard?.();
    toolchainGuard?.();
    fetchContentGuard?.();
    if (binaryObservation) {
      need(binaryGetter?.(input.sdkOriginals) === binaryObservation, 'independent Debian binary observation custody changed');
      binaryObservation.assertCurrent();
    }
    if (signatureObservation) need(signatureGetter?.(input.sdkOriginals) === signatureObservation, 'independent Debian signature observation custody changed');
  };
  let generationGuard:(()=>void)|undefined;
  let observedToolGuard:(()=>void)|undefined;
  let toolchainGuard:(()=>void)|undefined;
  let fetchContentGuard:(()=>void)|undefined;
  let verified = false;
  try {
    // App-vs-SDK ORIGIN PARTITION. The SDK artifact is acquired from its own
    // GitHub coordinates and carries its own immutable source commit. It is NOT
    // required to equal the app commit. The real bindings are: the SDK master
    // identity must equal this SDK origin's own facts (checked below), and the
    // app source relationship is bound by the service master's typed SDK
    // locator (artifact id/digest/master image) in the source qualification.
    need(sdk && source, 'same issued SDK and immutable source required');
    need(sdk.originFacts.sourceSha === JSON.parse(sdk.readOriginal(sdk.masterReference.path, 8 * 1024 ** 2).toString()).identity?.sourceSha,
      'SDK origin and SDK master source coordinate differ');
    const remaining = input.remainingMilliseconds ?? limits.timeoutMs;
    need(Number.isFinite(remaining) && remaining >= 1, 'shared SDK source deadline expired');
    const deadline = performance.now() + Math.min(remaining, limits.timeoutMs);
    const check = () => need(performance.now() < deadline, 'shared SDK source deadline expired');
    const available = () => {check(); return deadline - performance.now();};
    assertCurrent();
    const mechanical = inspectQleverSdkSourceOriginals(input.sdkOriginals, available()); check();
    Object.assign(facts, mechanical.facts); mechanical.pending.forEach(value => pending.add(value));
    const {observeQleverSdkDebianIndexOriginals} = await import('./qlever-sdk-debian-index');
    const index = await observeQleverSdkDebianIndexOriginals(input.sdkOriginals, available()); check();
    Object.assign(facts, index.facts); index.pending.forEach(value => pending.add(value));
    const generationModule=await import('./qlever-sdk-generation');
    const generation=await generationModule.observeQleverSdkGeneratedInputOriginals(input.sdkOriginals,input.source,available());check();
    Object.assign(facts,generation.facts);generation.pending.forEach(value=>pending.add(value));
    if(generation.assertCurrent)generationGuard=generation.assertCurrent;
    const tracked=generationModule.qleverSdkExecutionOriginalObservation(input.sdkOriginals);
    if(tracked===generation.facts&&tracked?.sdkActualConfigureCompileTrackedWaitVerified===true){pending.delete(SDK_TRACKED_PHASE_UNOBSERVED);facts.sdkConfigureCompileClosedExecutionVerified=true;}
    if(facts.sdkReadOnlyExecutorRequired===true){
      const {observeQleverSdkReadOnlyExecutor}=await import('./qlever-sdk-readonly-executor');
      const readonly=await observeQleverSdkReadOnlyExecutor({sdkOriginals:input.sdkOriginals,source:input.source,remainingMilliseconds:available()});check();
      Object.assign(facts,readonly.facts);readonly.pending.forEach(value=>pending.add(value));
      if(readonly.assertCurrent){const previous=generationGuard;generationGuard=()=>{previous?.();readonly.assertCurrent?.();};}
    }
    const {observeQleverSdkUpstreamGitOriginals} = await import('./qlever-sdk-upstream-source');
    const git = await observeQleverSdkUpstreamGitOriginals(input.sdkOriginals, input.source, available()); check();
    Object.assign(facts, git.facts); git.pending.forEach(value => pending.add(value));
    facts.sdkPreparedDependencySourceOriginalsVerified=false;
    if(facts.sdkFetchContentOriginalsRequired===true){
      const dependencyModule=await import('./qlever-sdk-fetchcontent');
      const dependency=await dependencyModule.observeQleverSdkFetchContentOriginals(input.sdkOriginals,input.source,available());check();
      Object.assign(facts,dependency.facts);dependency.pending.forEach(value=>pending.add(value));
      const retained=dependencyModule.qleverSdkFetchContentObservation(input.sdkOriginals);
      if(retained&&retained.facts===dependency.facts&&retained.facts.sdkFetchContentPreparationStageOriginalsVerified===true&&retained.facts.sdkFetchContentDeclaredSourceByteClosureVerified===true){
        retained.assertCurrent();fetchContentGuard=()=>{need(dependencyModule.qleverSdkFetchContentObservation(input.sdkOriginals)===retained,'FetchContent observation custody changed');retained.assertCurrent();};fetchContentGuard();
        facts.sdkPreparedDependencySourceOriginalsVerified=true;
        pending.delete('independent-FetchContent-dependency-stage-and-Git-or-URL-source-authority-unverified');
        if(retained.facts.sdkFetchContentDependencyReadOriginsVerified===true&&tracked===generation.facts&&tracked?.sdkActualConfigureCompileTrackedWaitVerified===true){pending.delete('qlever-sdk-dependency-source-read-origin-unverified');if(generation.facts.sdkGeneratedInputIoClosureExceptDependencyOriginVerified===true)facts.sdkGeneratedInputIoClosureVerified=true;}
      }else pending.add('qlever-sdk-independent-FetchContent-private-observation-unavailable');
    }

    const signatureModule = await import('./qlever-sdk-debian-signature'); signatureGetter = signatureModule.qleverSdkDebianSignatureObservation;
    const signature = await signatureModule.observeQleverSdkDebianSignatureOriginals(input.sdkOriginals, available()); check();
    signature.pending.forEach(value => pending.add(value));
    const currentSignature = signatureGetter(input.sdkOriginals);
    const signatureVerified = signature.facts.sdkDebianOfficialSignatureAndSuiteVerified === true && signature.pending.length === 0
      && currentSignature !== undefined && currentSignature === signature.facts;
    facts.sdkDebianOfficialSignatureAndSuiteVerified = signatureVerified;
    if (signatureVerified) {
      signatureObservation = currentSignature; Object.assign(facts, currentSignature);
      // These two exact obligations are owned by the now independently verified
      // signature/suite axis. No source/generated/toolchain pending is filtered.
      pending.delete('qlever-sdk-Debian-signed-Sources-InRelease-keyring-authority-not-yet-verified');
      pending.delete('qlever-sdk-official-Debian-keyring-gpgv-and-suite-authority-unverified');
    } else if (signature.facts.sdkDebianOfficialSignatureAndSuiteVerified === true) {
      pending.add('qlever-sdk-independent-Debian-signature-private-observation-unavailable');
    }
    // Binary provenance can consume only the independently verified signature
    // observation on this same SDK, never producer unclassified gpgv metadata.
    facts.sdkSelectedDebianBinaryFilesVerified = false;
    if (signatureVerified) {
      const binaryModule = await import('./qlever-sdk-debian-binary');
      binaryGetter = binaryModule.qleverSdkDebianBinaryObservation;
      const binary = await binaryModule.observeQleverSdkDebianBinaryOriginals(input.sdkOriginals, input.source, available()); check();
      binary.pending.forEach(value => pending.add(value));
      const currentBinary = binaryGetter(input.sdkOriginals);
      if (binary.facts.sdkSelectedDebianBinaryFilesVerified === true && currentBinary
        && binary.facts.sdkDebianBinaryFiles === currentBinary.files && binary.facts.sdkDebianBinaryScope === currentBinary.scope) {
        binaryObservation = currentBinary; currentBinary.assertCurrent();
        facts.sdkSelectedDebianBinaryFilesVerified = true;
        facts.sdkDebianBinaryFiles = currentBinary.files;
        facts.sdkDebianBinaryScope = currentBinary.scope;
        facts.sdkDebianBinaryUnresolved = currentBinary.unresolved;
      } else {
        if (binary.facts.sdkSelectedDebianBinaryFilesVerified === true) pending.add('qlever-sdk-independent-Debian-binary-private-observation-unavailable');
        if (binary.facts.sdkDebianBinaryUnresolved !== undefined) facts.sdkDebianBinaryUnresolved = binary.facts.sdkDebianBinaryUnresolved;
      }
    } else pending.add('qlever-sdk-Debian-binary-signature-prerequisite-unverified');
    facts.sdkOwnedDebianSourceArchiveAuthorityVerified = facts.debianDscAndAllSourceArchiveBytesVerified === true
      && facts.sdkOwnedDebianInputSourceArchivesComplete === true && facts.sdkDebianInReleaseSourcesDscChecksumChainVerified === true && signatureVerified;
    // This reader consumes the existing same-SDK full-shard, execution and
    // binary observations. Its after-only files never populate the before map.
    const {observeQleverSdkObservedToolOriginals} = await import('./qlever-sdk-observed-tools');
    const tools = await observeQleverSdkObservedToolOriginals(input.sdkOriginals,input.source,available()); check();
    Object.assign(facts,tools.facts);tools.pending.forEach(value=>pending.add(value));
    if((tools.facts.sdkObservedToolAfterShardBytesVerified===true||tools.facts.sdkObservedToolsSignedDebianBinaryBytesVerified===true)&&!tools.assertCurrent)throw Error('observed tool private custody guard unavailable');
    if(tools.assertCurrent){observedToolGuard=tools.assertCurrent;observedToolGuard();}
    const {observeQleverSdkToolchainSourceOriginals}=await import('./qlever-sdk-toolchain-source');
    const toolchain=await observeQleverSdkToolchainSourceOriginals(input.sdkOriginals,input.source,available());check();
    Object.assign(facts,toolchain.facts);toolchain.pending.forEach(value=>pending.add(value));
    if(toolchain.assertCurrent){toolchainGuard=toolchain.assertCurrent;toolchainGuard();}
    const unresolved=(facts.sdkInputOwnership as {unresolvedInputs?:readonly {path:string;role:string;reason:string}[]}|undefined)?.unresolvedInputs;
    const toolFiles=tools.facts.sdkObservedToolAfterShardFiles;
    const inputRows=sdkVerifiedInputOriginalView(input.sdkOriginals)?.rows;
    const signedFiles=binaryObservation?.files;
    // The pending is global: discharge it only if every contributing unresolved
    // row has its own exact same-private binary and verified after-shard join.
    if(observedToolGuard && tracked===generation.facts && tracked?.sdkActualConfigureCompileTrackedWaitVerified===true && facts.sdkOwnedDebianSourceArchiveAuthorityVerified===true
      && tools.facts.sdkObservedToolAfterShardBytesVerified===true && tools.facts.sdkObservedToolsSignedDebianBinaryBytesVerified===true
      && Array.isArray(unresolved) && unresolved.some(row=>row.role!=='installed-metadata') && Array.isArray(toolFiles) && inputRows && signedFiles
      // PER-ROW RESOLUTION. Each unresolved input closes only under a real
      // same-private origin: an exact signed-Debian binary/after-shard join, a
      // reviewed Git/patch postpatch member, a prepared FetchContent dependency
      // byte row, or a transitive generated origin already proven by the
      // toolchain leaf. Any unknown row keeps the global pending.
      && unresolved.filter(row=>row.role!=='installed-metadata').every(row=>{
        const selected=inputRows.filter(value=>value.originalPath===row.path);
        if(selected.length!==1)return false;
        const actual=selected[0]!;
        // (a) signed Debian installed file with its after-shard owner
        if(row.role==='observed-input'&&row.reason==='generated-or-unobserved-before-compile'){
          const observed=toolFiles.filter((value:any)=>value.path===row.path&&value.observedBeforeCompile===false);
          if(observed.length===1){
            const tool=observed[0];
            if(tool.bytes===actual.bytes&&tool.sha256===actual.sha256&&tool.mode===actual.mode){
              const binaries=signedFiles.filter(value=>value.installedPath===row.path&&value.bytes===actual.bytes&&value.sha256===actual.sha256&&value.mode===actual.mode);
              if(binaries.length===1&&tool.signedDebianBinary===binaries[0]!.binary&&tool.declaredSource===binaries[0]!.source)return true;
            }
          }
        }
        // (b) reviewed Git/patch postpatch member, via the SAME private getter.
        // Members carry RELATIVE paths; the canonical join uses the observation's
        // OWN verified source root, never a path-prefix guess.
        const git=qleverSdkUpstreamGitObservation(input.sdkOriginals);
        if(git&&facts.sdkUpstreamReviewedPatchProjectionVerified===true){
          const root=git.sourceRoot;
          if(typeof root==='string'&&root.startsWith('/')&&root.length>1&&!root.endsWith('/')){
            const member=git.postpatchMembers.filter((value:any)=>value&&typeof value.path==='string'
              &&!value.path.startsWith('/')
              &&root+'/'+value.path===row.path
              &&value.bytes===actual.bytes&&value.sha256===actual.sha256&&value.mode===actual.mode);
            if(member.length===1)return true;
          }
        }
        // (c) prepared FetchContent dependency byte row, from the helper-closed
        // byte set on the SAME private observation (not a guessed result shape).
        if(facts.sdkPreparedDependencySourceOriginalsVerified===true
          &&facts.sdkFetchContentDeclaredSourceByteClosureVerified===true){
          const prepared=(input.sdkOriginals as any)&&qleverSdkFetchContentByteRows?.(input.sdkOriginals);
          if(Array.isArray(prepared)&&prepared.some((rec:any)=>rec&&rec.path===row.path
            &&rec.bytes===actual.bytes&&rec.sha256===actual.sha256&&rec.mode===actual.mode))return true;
        }
        // (d) transitive generated origin proven by the toolchain leaf for this
        // exact path/bytes/sha (the earlier producer chain already closed)
        const generatedOrigin=(facts.sdkToolchainGeneratedProducerInputOrigins as readonly any[]|undefined);
        if(Array.isArray(generatedOrigin)&&generatedOrigin.some((entry:any)=>entry
          &&entry.path===row.path&&entry.bytes===actual.bytes&&entry.sha256===actual.sha256
          &&entry.closed===true))return true;
        // (e) CLOSED PRODUCER OUTPUT. A build output is not an INPUT of its own
        // producer, so it never appears in the input-origin list. It closes here
        // ONLY through the toolchain leaf's own post-graph-validation output fact,
        // joined on the exact path/bytes/mode from the SAME private verified
        // inventory. The `compile-output` role or any boolean is NOT authority:
        // the leaf emits the fact only after the complete exec/input/custody/
        // origin graph accepted, so a present row here is already proved.
        const closedOutputs=(facts.sdkToolchainGeneratedProducerClosedOutputs as readonly any[]|undefined);
        if(Array.isArray(closedOutputs)&&closedOutputs.some((entry:any)=>entry&&entry.path===row.path
          &&entry.bytes===actual.bytes&&entry.sha256===actual.sha256&&entry.mode===actual.mode
          &&entry.closed===true))return true;
        return false;
      })) {
      assertCurrent();pending.delete('qlever-sdk-Git-generated-or-other-non-Debian-input-source-authority-unresolved');
    }
    const axes = Object.freeze({inputOriginals: sdkVerifiedInputOriginalView(input.sdkOriginals) !== undefined,
      preparedDependencySources: facts.sdkFetchContentOriginalsRequired!==true||facts.sdkPreparedDependencySourceOriginalsVerified===true,
      configureCompileExecution: facts.sdkConfigureCompileClosedExecutionVerified === true,
      ownedDebianSourceArchives: facts.sdkOwnedDebianSourceArchiveAuthorityVerified === true,
      upstreamGitPreimages: facts.sdkUpstreamGitCommitTreePreimageClosureVerified === true,
      reviewedPatchProjection: facts.sdkUpstreamReviewedPatchProjectionVerified === true,
      selectedUpstreamInputOriginals: facts.sdkSelectedUpstreamInputOriginalsVerified === true,
      generatedInputIoClosure: facts.sdkGeneratedInputIoClosureVerified===true, toolchainSourceClosure: toolchainGuard!==undefined && facts.sdkToolchainSourceClosureVerified===true});
    facts.sdkSourceRequiredAxes = axes;
    // AGGREGATE RETIREMENT. The composite token represents BOTH generated-input
    // causality and full toolchain source causality, so it can only leave the
    // set when the closed axis list, the nonvacuous verified contributor set,
    // every other pending fact and the live same-handle guards all hold. The
    // rule itself is a pure function of derived facts; no JSON can retire it.
    const retirement = inspectSdkCompositeSourceRetirement({
      axes,
      pending,
      guardsCurrent: () => { try { assertCurrent(); return true; } catch { return false; } },
      contributing: {toolchainOperations: Number(facts.sdkToolchainOperationCount ?? 0)},
    });
    facts.sdkSourceCompositeRequirement = Object.freeze({
      token: SDK_COMPOSITE_SOURCE_GAP,
      closedAxes: SDK_SOURCE_REQUIRED_AXES,
      retired: retirement.retired,
      reason: retirement.reason,
    });
    if (retirement.retired) pending.delete(SDK_COMPOSITE_SOURCE_GAP);
    else pending.add(SDK_COMPOSITE_SOURCE_GAP);
    verified = Object.values(axes).every(value => value === true) && pending.size === 0;
    facts.sdkSourceCompletenessVerified = verified;
    check(); assertCurrent();
  } catch (error) {
    toolchainGuard=undefined;facts.sdkToolchainExactSourceArchiveCoverageVerified=false;delete facts.sdkToolchainSourceArchiveCoordinates;delete facts.sdkToolchainSourceArchiveScope;facts.sdkToolchainOperationCoverageVerified=false;facts.sdkToolchainObservedAfterFileBindingsVerified=false;facts.sdkToolchainSignedDebianBinaryFileBindingsVerified=false;facts.sdkToolchainStopReadOnlyProviderCoverageVerified=false;facts.sdkToolchainSourceClosureVerified=false;delete facts.sdkToolchainSignedFileCoordinates;
    if(fetchContentGuard){fetchContentGuard=undefined;facts.sdkPreparedDependencySourceOriginalsVerified=false;facts.sdkGeneratedInputIoClosureVerified=false;facts.sdkFetchContentDependencyReadOriginsVerified=false;facts.sdkFetchContentDeclaredSourceByteClosureVerified=false;facts.sdkFetchContentPreparationStageOriginalsVerified=false;delete facts.sdkFetchContentSourceOriginals;}
    pending.add((error as Error).message); verified = false; facts.sdkSourceCompletenessVerified = false;
    if ('sdkObservedToolAfterShardBytesVerified' in facts) { observedToolGuard=undefined; facts.sdkObservedToolAfterShardBytesVerified=false; facts.sdkObservedToolsSignedDebianBinaryBytesVerified=false; delete facts.sdkObservedToolAfterShardFiles; }
    if (binaryObservation) { binaryObservation = undefined; facts.sdkSelectedDebianBinaryFilesVerified = false; delete facts.sdkDebianBinaryFiles; delete facts.sdkDebianBinaryScope; }
    if (signatureObservation) { signatureObservation = undefined; facts.sdkDebianOfficialSignatureAndSuiteVerified = false; facts.sdkOwnedDebianSourceArchiveAuthorityVerified = false; }
  }
  const freeze = (value: unknown): void => {if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);}};
  freeze(facts);
  const result = Object.freeze({verified, facts: Object.freeze(facts), pending: Object.freeze([...pending]), assertCurrent});
  sourceAdmissions.set(result, Object.freeze({sdkOriginals: input.sdkOriginals, source: input.source, result}));
  return result;
}
