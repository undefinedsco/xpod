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
import { captureLegalFileIdentity, assertLegalFileIdentity } from './legal-file-custody';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const SHA = /^[a-f0-9]{64}$/u;
const HELPER_SHA = 'dddb499b82df467ff41511dd6dfab5877ed7d63cbcfa88fb772be9e6152aca6c';
const safe = (name: unknown): name is string => typeof name === 'string' && Boolean(name) && !name.startsWith('/') && !/[\\\u0000-\u001f\u007f]/u.test(name) && !name.split('/').some(part => !part || part === '.' || part === '..');
function need(value: unknown, reason: string): asserts value { if (!value) throw Error('QLever SDK source: ' + reason); }
const verifiedInputs = new WeakMap<object, Readonly<{sdk: NonNullable<ReturnType<typeof qleverSdkOriginalsView>>; afterReference: Readonly<{path: string; bytes: number; sha256: string}>; rows: readonly Readonly<{originalPath: string; bytes: number; sha256: string; mode: number}>[] }>>();
/** Reuses the one actual full-shard verification, never caller JSON facts. */
export function sdkVerifiedInputOriginalView(capability: unknown) {
  if (!capability || typeof capability !== 'object') return undefined;
  const value = verifiedInputs.get(capability);
  if (value && qleverSdkOriginalsView(capability) === value.sdk) {
    const raw = value.sdk.readOriginal(value.afterReference.path, limits.metadataBytes);
    need(raw.length === value.afterReference.bytes && hash(raw) === value.afterReference.sha256, 'verified input inventory custody changed');
    return Object.freeze({afterReference: value.afterReference, rows: value.rows});
  }
  return undefined;
}
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
    const python = realpathSync('/usr/bin/python3'), pythonIdentity = captureLegalFileIdentity(python);
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
      pending.add(SDK_TRACKED_PHASE_UNOBSERVED);execution={verified:false,pending:[SDK_TRACKED_PHASE_UNOBSERVED],generationMetadataReferenceSealVerified:error.generationMetadataOriginals!==undefined};
    }
    need(qleverSdkOriginalsView(capability) === sdk, 'SDK closed build original custody changed');
    facts.sdkConfigureCompileExecution = execution;
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
      rows: Object.freeze(after.files.map((row: any) => Object.freeze({originalPath: row.originalPath, bytes: row.bytes, sha256: row.sha256, mode: row.mode})))}));
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
    const identities = new Set(Object.values(ledger).map((row: any) => row.source.name + '\0' + row.source.version));
    const seen = new Set<string>(); let sourceBytes = 0;
    for (const item of sources.packages) {
      const coordinate = item.name + '\0' + item.version;
      need(!seen.has(coordinate) && identities.has(coordinate), 'exact Debian source identity absent or repeated in actual dpkg ledger'); seen.add(coordinate);
      const dscRef = reference(item.dsc), dsc = parse('--parse-dsc', small(dscRef));
      need(dsc.name === item.name && dsc.version === item.version && path.posix.basename(dscRef.path) === item.name + '_' + item.version.replace(/^[0-9]+:/u, '') + '.dsc', 'actual dsc source/version differs');
      const parent = path.posix.dirname(dscRef.path);
      need(/^inner\/debian-source\/package-[0-9]{4}$/u.test(parent) && Array.isArray(item.files) && item.files.length === dsc.files.length, 'Debian original group/reference set differs');
      const expected = new Map<string, any>(dsc.files.map((row: any) => [row.name, row]));
      const names = new Set<string>([dscRef.path]); sourceBytes += dscRef.bytes;
      for (const value of item.files) {
        const ref = reference(value), relative = ref.path.slice(parent.length + 1), declared = expected.get(relative);
        need(ref.path.startsWith(parent + '/') && !names.has(ref.path) && declared && ref.bytes === declared.bytes && ref.sha256 === declared.sha256, 'all orig/debian archive bytes must match dsc SHA256 universe'); names.add(ref.path);
        need(ref.bytes <= limits.shardBytes, 'Debian source member exceeds fixed original bound');
        sourceBytes += ref.bytes;
        need(total + sourceBytes <= limits.sourceMaterialBytes, 'SDK context/input/Debian domains exceed shared source budget');
        const digest = createHash('sha256');
        for (let offset = 0; offset < ref.bytes; offset += limits.rangeBytes) {
          check(); const length = Math.min(limits.rangeBytes, ref.bytes - offset), bytes = sdk.readOriginalRange(ref.path, offset, length);
          need(bytes.length === length, 'Debian source original truncated'); digest.update(bytes);
        }
        need(digest.digest('hex') === declared.sha256, 'actual complete Debian source original hash differs');
      }
      const actual = sdk.members.filter(row => row.path.startsWith(parent + '/'));
      need(actual.length === names.size && actual.every(row => names.has(row.path)), 'unregistered extra Debian source original member');
      need(total + sourceBytes <= limits.sourceMaterialBytes, 'SDK context/input/Debian domains exceed shared source budget');
    }
    need(qleverSdkOriginalsView(capability) === sdk, 'SDK source custody changed');
    facts.sdkRelatedOriginalCustodyVerified = true; facts.debianDscAndAllSourceArchiveBytesVerified = true;
    facts.debianSourcePackageInstances = seen.size; facts.debianSourceOriginalBytes = sourceBytes;
    pending.add('qlever-sdk-Debian-signed-Sources-InRelease-keyring-authority-not-yet-verified');
    const absent = ownership.requiredSources.filter(row => !seen.has(row.name + '\0' + row.version));
    facts.sdkDebianSourceArchiveMissingCoordinates = Object.freeze(absent);
    facts.sdkOwnedDebianInputSourceArchivesComplete = absent.length === 0;
    if (absent.length) pending.add('qlever-sdk-exact-owned-Debian-input-source-archives-incomplete');
    pending.add('qlever-sdk-generated-input-and-full-toolchain-source-causality-not-yet-verified');
  } catch (error) { pending.add((error as Error).message); }
  return Object.freeze({verified: false, pending: Object.freeze([...pending]), facts: Object.freeze(facts)});
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
    need(sdk && source && sdk.originFacts.sourceSha === source.sourceSha, 'same issued SDK and immutable source required');
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
      && unresolved.filter(row=>row.role!=='installed-metadata').every(row=>{
        if(row.role!=='observed-input'||row.reason!=='generated-or-unobserved-before-compile')return false;
        const selected=inputRows.filter(value=>value.originalPath===row.path);
        const observed=toolFiles.filter((value:any)=>value.path===row.path&&value.observedBeforeCompile===false);
        if(selected.length!==1||observed.length!==1)return false;
        const actual=selected[0]!,tool=observed[0];
        if(tool.bytes!==actual.bytes||tool.sha256!==actual.sha256||tool.mode!==actual.mode)return false;
        const binaries=signedFiles.filter(value=>value.installedPath===row.path&&value.bytes===actual.bytes&&value.sha256===actual.sha256&&value.mode===actual.mode);
        return binaries.length===1&&tool.signedDebianBinary===binaries[0]!.binary&&tool.declaredSource===binaries[0]!.source;
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
      generatedInputIoClosure: facts.sdkGeneratedInputIoClosureVerified===true, toolchainSourceClosure: 'verifier-not-implemented' as const});
    facts.sdkSourceRequiredAxes = axes;
    verified = Object.values(axes).every(value => value === true) && pending.size === 0;
    facts.sdkSourceCompletenessVerified = verified;
    check(); assertCurrent();
  } catch (error) {
    toolchainGuard=undefined;facts.sdkToolchainOperationCoverageVerified=false;facts.sdkToolchainObservedAfterFileBindingsVerified=false;facts.sdkToolchainSignedDebianBinaryFileBindingsVerified=false;facts.sdkToolchainStopReadOnlyProviderCoverageVerified=false;facts.sdkToolchainSourceClosureVerified=false;delete facts.sdkToolchainSignedFileCoordinates;
    if(fetchContentGuard){fetchContentGuard=undefined;facts.sdkPreparedDependencySourceOriginalsVerified=false;facts.sdkGeneratedInputIoClosureVerified=false;facts.sdkFetchContentDependencyReadOriginsVerified=false;facts.sdkFetchContentDeclaredSourceByteClosureVerified=false;facts.sdkFetchContentPreparationStageOriginalsVerified=false;delete facts.sdkFetchContentSourceOriginals;}
    pending.add((error as Error).message); verified = false; facts.sdkSourceCompletenessVerified = false;
    if ('sdkObservedToolAfterShardBytesVerified' in facts) { observedToolGuard=undefined; facts.sdkObservedToolAfterShardBytesVerified=false; facts.sdkObservedToolsSignedDebianBinaryBytesVerified=false; delete facts.sdkObservedToolAfterShardFiles; }
    if (binaryObservation) { binaryObservation = undefined; facts.sdkSelectedDebianBinaryFilesVerified = false; delete facts.sdkDebianBinaryFiles; delete facts.sdkDebianBinaryScope; }
    if (signatureObservation) { signatureObservation = undefined; facts.sdkDebianOfficialSignatureAndSuiteVerified = false; facts.sdkOwnedDebianSourceArchiveAuthorityVerified = false; }
  }
  const freeze = (value: unknown): void => {if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);}};
  freeze(facts);
  return Object.freeze({verified, facts: Object.freeze(facts), pending: Object.freeze([...pending]), assertCurrent});
}
