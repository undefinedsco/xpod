import {selectSdkControllerHelperGroup} from './sdk-controller-helper-groups';
import { inspectSdkBuildExecution } from './qlever-sdk-execution';
import { createHash } from 'node:crypto';
import { runSdkSelectedOriginalCommand } from './sdk-selected-original-command';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import limits from '../module-artifact-limits.json';
import { qleverSdkOriginalsView } from './qlever-sdk-originals';
import { derivedSourceView, assertDerivedSourceCurrent } from './source-context';
import { sdkVerifiedInputOriginalView, qleverSdkSourceAdmissionView } from './qlever-sdk-source';
import { isDeepStrictEqual } from 'node:util';
import { captureLegalFileIdentity, assertLegalFileIdentity,resolveExecutableIdentityPath} from './legal-file-custody';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function need(value: unknown, reason: string): asserts value { if (!value) throw Error('SDK upstream source: ' + reason); }
type PostpatchMember=Readonly<{path:string;mode:number;bytes:number;sha256:string}>;
type SelectedReadBudget=Readonly<{check():void;remainingMs():number;remainingReadBytes():number;reserveBytes(bytes:number):void;chargeReadBytes(bytes:number):void}>;
type SelectedReader=Readonly<{postpatchMembers:readonly PostpatchMember[];readSelectedOriginals(paths:readonly string[],budget:SelectedReadBudget):Promise<Readonly<{paths:readonly string[];readTracked(path:string):Buffer;assertCurrent():void}>>;assertCurrent():void}>;
type StoredObservation=Readonly<{sourceCapability:unknown;cmakeDeclaration:Readonly<{bytes:number;sha256:string}>;assertCurrent():void;postpatchMembers:readonly PostpatchMember[];readSelectedOriginals:(paths:readonly string[],budget:SelectedReadBudget,admission:unknown)=>ReturnType<SelectedReader['readSelectedOriginals']>}>;
const upstreamObservations=new WeakMap<object,StoredObservation>();
const publicObservations=new WeakMap<object,Readonly<{cmakeDeclaration:Readonly<{bytes:number;sha256:string}>;assertCurrent():void}>>();
/** Existing public shape only; selected reader is deliberately absent here. */
export function qleverSdkUpstreamGitObservation(capability:unknown){if(!capability||typeof capability!=='object')return undefined;const observation=upstreamObservations.get(capability);observation?.assertCurrent();return observation?publicObservations.get(capability):undefined;}
/** Only the same already-verified upstream observation; this never inserts a view. */
export function qleverSdkUpstreamSelectedOriginalsView(capability:unknown,sourceCapability:unknown,admission:unknown):SelectedReader|undefined{
 if(!capability||typeof capability!=='object')return undefined;
 const observation=upstreamObservations.get(capability);if(!observation||observation.sourceCapability!==sourceCapability)return undefined;
 const admitted=qleverSdkSourceAdmissionView(admission,{sdkOriginals:capability,source:sourceCapability});
 if(!admitted||qleverSdkOriginalsView(capability)===undefined||derivedSourceView(sourceCapability)===undefined)return undefined;
 observation.assertCurrent();admitted.assertCurrent();
 const assertCurrent=()=>{need(upstreamObservations.get(capability as unknown as object)===observation,'same upstream observation required');observation.assertCurrent();const current=qleverSdkSourceAdmissionView(admission,{sdkOriginals:capability,source:sourceCapability});need(current&&current.verified===true,'same verified SDK source admission required');current.assertCurrent();};
 return Object.freeze({postpatchMembers:observation.postpatchMembers,readSelectedOriginals:(paths:readonly string[],budget:SelectedReadBudget)=>{assertCurrent();return observation.readSelectedOriginals(paths,budget,admission);},assertCurrent});
}
/** Mechanical response validation only; this function cannot issue any SDK capability. */
export function inspectSdkSelectedOriginalResponse(observed:any,baseline:any,requested:readonly PostpatchMember[],budget:Pick<SelectedReadBudget,'check'|'reserveBytes'>):readonly Readonly<{path:string;bytes:Buffer}>[]{
 budget.check();need(requested.length>0&&requested.length<=limits.sourceMembers&&new Set(requested.map(row=>row.path)).size===requested.length,'unique bounded selected response request');
 const projection=observed?.patchProjection,rows=projection?.selectedOriginals;
 need(baseline?.verified===true&&baseline.patchProjection?.verified===true&&Array.isArray(rows),'complete captured and selected Git projection required');
 const {selectedOriginals:_selected,...plainProjection}=projection;
 need(isDeepStrictEqual({...observed,patchProjection:plainProjection},baseline),'complete selected Git result differs from original verified result');
 need(rows.length===requested.length,'exact selected original set required');
 const expected=new Map(requested.map(row=>[row.path,row])),seen=new Set<string>(),out:{path:string;bytes:Buffer}[]=[];let total=0;
 for(const row of rows){budget.check();const held=expected.get(row?.path);need(held&&!seen.has(row.path),'unexpected or duplicate selected response path');
  need(typeof row.base64==='string'&&row.base64.length<=Math.ceil(limits.metadataBytes/3)*4&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(row.base64),'bounded canonical selected base64 required');
  need(Number.isSafeInteger(row.bytes)&&row.bytes>=0&&row.bytes===held.bytes&&row.mode===held.mode&&(row.mode===0o644||row.mode===0o755),'selected byte size/mode differs');total+=row.bytes;need(total<=limits.metadataBytes,'selected logical byte ceiling');budget.reserveBytes(row.bytes);
  const bytes=Buffer.from(row.base64,'base64');need(bytes.toString('base64')===row.base64&&bytes.length===held.bytes&&hash(bytes)===held.sha256&&row.sha256===held.sha256,'selected original bytes/hash differ');seen.add(row.path);out.push(Object.freeze({path:row.path,bytes}));
 }
 budget.check();return Object.freeze(out);
}
const HELPERS = [
  ['sdk-git-source-bindings.py', '612063f44d09932b93883db2d186d197bd828e07d39e2df430d9dbe574fd66d0'],
  ['sdk-git-source-observer.py', 'fd578d0fef97c1d3b4b60e5510320c109c6930580d91db9335d67cbacff186f6'],
  ['sdk-git-patch-projection.py', '3e4051b50acf6be11ade6e5d6c05ca23ab8376aa4ff5861975088eab642c8f23'],
  ['sdk-zip-originals.py', '304a8d26c8a124af31f2b240f1b2af52312520982cd6e1f4cba70fde2602bcb8'],
] as const;
export function assertSdkUpstreamCollectionProjection(upstream: any, inner: any): void {
  const normalize = (value: any): any => {
      if (Array.isArray(value)) return value.map(normalize);
      if (!value || typeof value !== 'object') return value;
      if (typeof value.path === 'string' && Number.isSafeInteger(value.bytes) && typeof value.sha256 === 'string') return {...value, path: 'inner/' + value.path};
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child)]));
    };
  const {innerMaterials: _innerReference, ...rooted} = upstream;
  need(isDeepStrictEqual(rooted, normalize(inner)), 'complete root/inner upstream source collection differs');
}

/** Same private SDK/source handles. This axis proves pinned Git preimages only;
 * it cannot bless the postpatch inventory, generated inputs or toolchain. */
export async function observeQleverSdkUpstreamGitOriginals(capability: unknown, sourceCapability: unknown, remainingMilliseconds = limits.timeoutMs) {
  const facts: Record<string, unknown> = {}, pending = new Set<string>();
  try {
    const sdk = qleverSdkOriginalsView(capability), source = derivedSourceView(sourceCapability);
    need(sdk && source && source.sourceSha === sdk.originFacts.sourceSha, 'same issued SDK and immutable source required'); assertDerivedSourceCurrent(sourceCapability);
    need(Number.isFinite(remainingMilliseconds) && remainingMilliseconds > 0, 'source observation window exhausted');
    const deadline = performance.now() + Math.min(remainingMilliseconds, limits.timeoutMs), check = () => need(performance.now() < deadline, 'aggregate Git source deadline exceeded');
    const originals = new Map(sdk.members.map(row => [row.path, row]));
    const ref = (value: any) => { check(); const actual = originals.get(value?.path); need(actual && actual.bytes === value.bytes && actual.sha256 === value.sha256, 'same SDK ZIP reference required'); return actual; };
    const json = (value: any, maximum = limits.metadataBytes) => { const original = ref(value); need(original.bytes <= maximum, 'bounded source metadata required'); const bytes = sdk.readOriginal(original.path, maximum); need(bytes.length === original.bytes && hash(bytes) === original.sha256, 'source metadata bytes differ'); return JSON.parse(bytes.toString()); };
    const master = json(sdk.masterReference, 8 * 1024 ** 2);
    need(master.kind === 'qlever-linux-sdk-originals' && master.identity?.sourceSha === source.sourceSha && master.identity?.target === sdk.originFacts.target, 'SDK source master differs');
    if (!master.upstreamSource) return Object.freeze({facts: Object.freeze(facts), pending: Object.freeze(['qlever-sdk-upstream-Git-object-originals-unavailable'])});
    need(ref(master.upstreamSource).path === 'upstream-source-collection.json', 'fixed upstream source collection role required');
    const upstream = json(master.upstreamSource), lock = JSON.parse(source.readTracked('qlever/qlever.lock.json').toString());
    need(upstream.schemaVersion === 1 && upstream.kind === 'qlever-sdk-upstream-source-originals' && upstream.objectFormat === 'sha1'
      && upstream.objectIdsFormat === 'ascii-sorted-unique-sha1-lf' && upstream.sourceRoot === '/opt/qlever-sdk/source'
      && upstream.repository === lock.repository && upstream.commit === lock.commit, 'immutable lock repository/commit/object format differs');
    const preparedMode = master.executionOwners?.sourcePrepare !== undefined || master.stages.some((stage: any) => stage.name === 'source-prepare') || upstream.phaseBindings?.sourcePrepare !== undefined;
    need(upstream.phaseBindings && (preparedMode ? ['sourcePrepare', 'configure', 'compile'] : ['configure', 'compile']).every(name => { const matches = master.stages.filter((stage: any) => stage.name === (name === 'sourcePrepare' ? 'source-prepare' : name)); return matches.length === 1 && isDeepStrictEqual(upstream.phaseBindings[name], matches[0]); }), 'actual SDK configure/compile phase bindings differ');
    need(ref(upstream.innerMaterials).path === 'inner/upstream-source/final-materials.json', 'registered original inner upstream collection required');
    const inner = json(upstream.innerMaterials);
    assertSdkUpstreamCollectionProjection(upstream, inner);
    const configureReceipt = json(upstream.phaseBindings.configure.receipt), compileReceipt = json(upstream.phaseBindings.compile.receipt);
    let hookReceipt = configureReceipt;
    if (preparedMode) {
      const jobs = sdk.metadataOriginals.filter(row => /^jobs(?:-page-\d+)?\.original\.json$/u.test(row.name)).flatMap(row => {
        const expected = sdk.originFacts.originals.find(item => item.name === row.name);
        need(expected && row.data.length === expected.bytes && hash(row.data) === expected.sha256, 'SDK job API original differs');
        return JSON.parse(row.data.toString()).jobs;
      }).filter((row: any) => row.id === sdk.originFacts.producerJobId);
      need(jobs.length === 1, 'unique actual SDK producer job required');
      const actualPhases=master.stages.filter((stage:any)=>['configure','compile'].includes(stage.name));
      if(actualPhases.length===2&&actualPhases.every((stage:any)=>stage.closureKind==='ptrace-tracked-phase-v1')){
        const {qleverSdkExecutionOriginalObservation}=await import('./qlever-sdk-generation');
        need(qleverSdkExecutionOriginalObservation(capability)?.sdkActualConfigureCompileTrackedWaitVerified===true,'actual typed configure/compile wait observation required');
      }else{
        const execution = inspectSdkBuildExecution({master, members: sdk.members, jobWindow: {start: Date.parse(jobs[0].started_at), end: Date.parse(jobs[0].completed_at)},
          readOriginal: (path, maximum) => sdk.readOriginal(path, maximum), readRange: (path, offset, length) => sdk.readOriginalRange(path, offset, length), check});
        need(execution.stages[0]?.name === 'source-prepare', 'actual sourcePrepare execution required');
      }
      hookReceipt = json(upstream.phaseBindings.sourcePrepare.receipt);
      need(BigInt(hookReceipt.completedUnixNs) <= BigInt(configureReceipt.startedUnixNs), 'sourcePrepare must close before configure');
    }
    const windows = upstream.hookWindows;
    need(windows && ['beforeEndedUnixNs', 'afterEndedUnixNs'].every(key => typeof windows[key] === 'string' && /^[0-9]+$/u.test(windows[key])), 'actual upstream hook windows required');
    const beforeHook = BigInt(windows.beforeEndedUnixNs), afterHook = BigInt(windows.afterEndedUnixNs);
    need(BigInt(hookReceipt.startedUnixNs) <= beforeHook && beforeHook <= afterHook && afterHook <= BigInt(hookReceipt.completedUnixNs)
      && BigInt(configureReceipt.completedUnixNs) <= BigInt(compileReceipt.startedUnixNs), 'actual Git source hooks must occur inside configure before compile');
    const verifiedInputs = sdkVerifiedInputOriginalView(capability);
    need(verifiedInputs && isDeepStrictEqual(ref(upstream.actualInputInventory), verifiedInputs.afterReference), 'actual full-shard input verification required');
    const selected = json(upstream.selectedInputs), post = json(upstream.postpatchInventory);
    need(selected.schemaVersion === 1 && Array.isArray(selected.files) && selected.files.length > 0 && Array.isArray(selected.unresolvedInputs) && post.schemaVersion === 1 && Array.isArray(post.files), 'actual selected/postpatch inventories required');
    const postRows = new Map<string, any>(post.files.map((row: any) => [row.path, row])), actualRows = new Map(verifiedInputs.rows.map(row => [row.originalPath, row]));
    need(postRows.size === post.files.length, 'unique postpatch paths required');
    const selectedPaths = new Set<string>();
    for (const item of selected.files) {
      check(); const relative = item.sourceRelativePath;
      need(typeof relative === 'string' && relative && !relative.startsWith('/') && !/[\\\u0000-\u001f\u007f]/u.test(relative) && relative.split('/').every(part => part && part !== '.' && part !== '..')
        && item.originalPath === upstream.sourceRoot + '/' + relative && !selectedPaths.has(item.originalPath), 'canonical actual selected source path required');
      const row = actualRows.get(item.originalPath), projected = postRows.get(relative);
      need(row && projected && isDeepStrictEqual(item.postpatchEntry, projected) && row.bytes === projected.bytes && row.sha256 === projected.sha256 && row.mode === parseInt(projected.mode, 8) % 0o10000, 'selected actual shard bytes differ from postpatch projection'); selectedPaths.add(item.originalPath);
    }
    for (const item of selected.unresolvedInputs) {
      need(item.reason === 'selected-source-input-generated-after-patch-snapshot' && typeof item.path === 'string' && item.path.startsWith(upstream.sourceRoot + '/') && actualRows.has(item.path) && !selectedPaths.has(item.path), 'actual generated selected input required'); selectedPaths.add(item.path);
    }
    need(verifiedInputs.rows.filter(row => row.originalPath.startsWith(upstream.sourceRoot + '/')).every(row => selectedPaths.has(row.originalPath)), 'selected actual source input universe incomplete');
    need(Array.isArray(upstream.addedPaths) && upstream.addedPaths.length === 0 && Array.isArray(upstream.deletedPaths) && upstream.deletedPaths.length === 0, 'current reviewed text patch path universe must remain unchanged');
    const seriesBytes = source.readTracked('qlever/patches/series'), names = seriesBytes.toString().split('\n').map(name => name.trim()).filter(Boolean);
    need(names.length > 0 && new Set(names).size === names.length && names.every(name => /^[A-Za-z0-9_.-]+\.patch$/u.test(name)) && upstream.patchSeriesSourcePath === 'qlever/patches/series'
      && Array.isArray(upstream.patches) && upstream.patches.length === names.length, 'one immutable reviewed patch series required');
    const seriesDigest = createHash('sha256').update(seriesBytes);
    const reviewedPatches = names.map((name, index) => {
      const item = upstream.patches[index], sourcePath = 'qlever/patches/' + name;
      need(item.name === name && item.sourcePath === sourcePath && ref(item.file).path.startsWith('inner/upstream-source/'), 'ordered immutable patch original role differs');
      const bytes = source.readTracked(sourcePath); seriesDigest.update(name).update(Buffer.from([0])).update(bytes);
      return {name, file: ref(item.file), base64: bytes.toString('base64')};
    });
    need(seriesDigest.digest('hex') === lock.patchSeriesSha256, 'immutable reviewed patch series digest differs from lock');
    const lockRef = ref(upstream.lock); need(lockRef.path.startsWith('inner/upstream-source/') && sdk.readOriginal(lockRef.path, limits.metadataBytes).equals(source.readTracked('qlever/qlever.lock.json')), 'actual upstream lock bytes differ from immutable Git');
    for (const field of ['commitOriginal', 'treeListing', 'objectIds', 'prepatchInventory', 'objectPack']) need(ref(upstream[field]).path.startsWith('inner/upstream-source/'), 'fixed upstream original prefix required');
    const helperDigests=new Map<string,string>();
    const helpers = HELPERS.map(([name]) => { const file = fileURLToPath(new URL('../../../qlever/scripts/' + name, import.meta.url)), identity = captureLegalFileIdentity(file); need(identity.size <= BigInt(limits.metadataBytes), 'bounded reviewed controller Git helper');helperDigests.set(name,hash(readFileSync(file)));assertLegalFileIdentity(identity); return identity; });
    selectSdkControllerHelperGroup(REVIEWED_HELPER_GROUPS,helperDigests);helpers.forEach(assertLegalFileIdentity);
    const python = resolveExecutableIdentityPath('/usr/bin/python3'), pythonIdentity = captureLegalFileIdentity(python), git = resolveExecutableIdentityPath('/usr/bin/git'), gitIdentity = captureLegalFileIdentity(git);
    const limitsPath = fileURLToPath(new URL('../module-artifact-limits.json', import.meta.url)), limitsIdentity = captureLegalFileIdentity(limitsPath);
    const { moduleSourcePhasePolicy } = await import('./module-source-phases'); need(hash(readFileSync(limitsPath)) === moduleSourcePhasePolicy.limits, 'reviewed source budget differs');
    const identities = [...helpers, pythonIdentity, gitIdentity, limitsIdentity]; identities.forEach(assertLegalFileIdentity);
    const observerRefs = Object.fromEntries(['commitOriginal', 'treeListing', 'objectIds', 'prepatchInventory', 'objectPack'].map(field => [field, ref(upstream[field])]));
    const planBase = {commit: lock.commit, rootTree: upstream.rootTree, gitExecutable: git, reviewedPatches, reviewedSeriesBase64: seriesBytes.toString('base64'), patchSeries: ref(upstream.patchSeries), postpatchInventory: ref(upstream.postpatchInventory), addedPaths: upstream.addedPaths, deletedPaths: upstream.deletedPaths, ...observerRefs};
    const observerPlan = (selectedPaths: readonly string[], remainingMilliseconds: number) => Buffer.from(JSON.stringify({remainingMilliseconds, ...planBase, ...(selectedPaths.length ? {selectedOriginalPaths: [...selectedPaths]} : {})}));
    // The shared supervised command owns plan/cap reservation, refreshed
    // deadlines, actual IO accounting and group-absence observation.
    const runSelectedObserver = async (selectedPaths: readonly string[], parent: SelectedReadBudget) => {
      const command = await runSdkSelectedOriginalCommand({
        archiveIdentity: sdk.archive,
        withArchiveFile: (operation, budget) => sdk.withArchiveFile(operation as any, budget),
        python, helperPath: helpers[1]!.path,
        createPlan: remainingMs => observerPlan(selectedPaths, remainingMs),
        remainingMs: () => deadline - performance.now(),
        budget: parent,
      });
      return command.json;
    };
    const result = await sdk.withArchiveFile(async archive => {
      check(); need(archive.identity.bytes === sdk.archive.bytes && archive.identity.sha256 === sdk.archive.sha256, 'same retained SDK archive required');
      const plan = observerPlan([], Math.max(1, Math.floor(deadline - performance.now()))); need(plan.length <= limits.metadataBytes, 'bounded fixed Git observer plan required');
      const bytes = execFileSync(python, ['-I', '-S', '-B', helpers[1]!.path, archive.path], {input: plan, maxBuffer: limits.metadataBytes,
        timeout: Math.max(1, Math.floor(deadline - performance.now())), env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'}, stdio: ['pipe', 'pipe', 'pipe']});
      return JSON.parse(bytes.toString());
    }, {check, remainingMs: () => deadline - performance.now()});
    identities.forEach(assertLegalFileIdentity); assertDerivedSourceCurrent(sourceCapability); check(); need(qleverSdkOriginalsView(capability) === sdk, 'SDK/source custody revoked');
    need(result.verified === true && result.commit === lock.commit && result.packBytes === upstream.objectPack.bytes && result.packSha256 === upstream.objectPack.sha256, 'actual pinned Git observation differs');
    facts.sdkUpstreamGitCommitTreePreimageClosureVerified = true; facts.sdkUpstreamGitOriginals = Object.freeze(result);
    need(result.patchProjection?.verified === true, 'actual reviewed patch projection required');
    facts.sdkUpstreamReviewedPatchProjectionVerified = true;
    facts.sdkSelectedUpstreamInputOriginalsVerified = selected.unresolvedInputs.length === 0;
    facts.sdkSelectedUpstreamInputCount = selected.files.length;
    facts.sdkSelectedUpstreamInputBytes = selected.files.reduce((sum: number, row: any) => sum + actualRows.get(row.originalPath)!.bytes, 0);
    if (selected.unresolvedInputs.length) pending.add('qlever-sdk-selected-upstream-inputs-generated-after-patch-snapshot');
    const cmake=postRows.get('CMakeLists.txt'),actualCmake=actualRows.get(upstream.sourceRoot+'/CMakeLists.txt');
    if(cmake&&actualCmake&&cmake.bytes===actualCmake.bytes&&cmake.sha256===actualCmake.sha256&&parseInt(cmake.mode,8)%0o10000===actualCmake.mode){
      const assertCurrent=()=>{identities.forEach(assertLegalFileIdentity);assertDerivedSourceCurrent(sourceCapability);need(qleverSdkOriginalsView(capability)===sdk&&sdkVerifiedInputOriginalView(capability)?.rows===verifiedInputs.rows,'upstream source/input custody changed');};assertCurrent();
      // Same verified snapshot only; selected reads re-run the complete raw
      // Git/patch observer and never trust these frozen rows alone.
      const postpatchMembers: readonly PostpatchMember[]=Object.freeze(post.files.map((row:any)=>Object.freeze({path:row.path,mode:parseInt(row.mode,8)%0o10000,bytes:row.bytes,sha256:row.sha256})));
      need(postpatchMembers.length===post.files.length,'unique frozen postpatch members required');
      const memberByPath=new Map(postpatchMembers.map(row=>[row.path,row]));
      const readSelectedOriginals=async (paths:readonly string[],parent:SelectedReadBudget,admission:unknown)=>{
        need(qleverSdkSourceAdmissionView(admission,{sdkOriginals:capability,source:sourceCapability})?.verified===true,'same verified private SDK source admission required');
        need(parent&&typeof parent.check==='function'&&typeof parent.remainingMs==='function'&&typeof parent.remainingReadBytes==='function'&&typeof parent.reserveBytes==='function'&&typeof parent.chargeReadBytes==='function','same parent read budget required');
        if(!Array.isArray(paths)||!paths.length||paths.length>limits.sourceMembers||new Set(paths).size!==paths.length)throw Error('SDK upstream selected source: canonical unique requested paths required');
        const requested: string[]=[];const requestedBytes=new Map<string,number>();let logical=0;
        for(const path of paths){parent.check();need(typeof path==='string'&&path&&!path.startsWith('/')&&!/[\\\u0000-\u001f\u007f]/u.test(path)&&path.split('/').every(part=>part&&part!=='.'&&part!=='..'),'canonical requested selected source required');const row=memberByPath.get(path);need(row&&Number.isSafeInteger(row.bytes)&&row.bytes>=0&&(row.mode===0o644||row.mode===0o755),'requested selected regular member absent from captured postpatch snapshot');requestedBytes.set(path,row.bytes);logical+=row.bytes;need(logical<=limits.metadataBytes,'cumulative selected logical member bound');requested.push(path);}
        parent.check();need(parent.remainingMs()>0,'selected source window exhausted');
        // The fixed pack is authenticated by its exact registered identity and
        // may legitimately exceed the 4MiB metadata ceiling; only the JSON
        // response remains <= metadata. Charge the shared source domain.
        let fixed=0;for(const field of ['commitOriginal','treeListing','objectIds','prepatchInventory','objectPack','postpatchInventory','patchSeries'])fixed+=ref(upstream[field]).bytes;
        for(const item of reviewedPatches)fixed+=item.file.bytes;
        need(Number.isSafeInteger(result.expandedBytes)&&result.expandedBytes>=0&&result.expandedBytes<=limits.sourceMaterialBytes,'captured full pack expanded byte bound');
        const precharge=fixed+logical+result.expandedBytes;need(precharge<=limits.sourceMaterialBytes,'selected observer fixed original source-material bound');
        need(precharge<=parent.remainingReadBytes(),'selected observer exceeds same parent remaining read bytes');
        parent.reserveBytes(precharge);parent.chargeReadBytes(precharge);parent.check();need(parent.remainingReadBytes()>0,'shared read budget exhausted before selected spawn');
        const observed=await runSelectedObserver(requested,parent);
        const selectedRows=inspectSdkSelectedOriginalResponse(observed,result,requested.map(path=>memberByPath.get(path)!),parent);
        const raw=new Map(selectedRows.map(row=>[row.path,row.bytes]));
        const current=()=>{parent.check();assertCurrent();need(qleverSdkOriginalsView(capability)===sdk&&sdkVerifiedInputOriginalView(capability)?.rows===verifiedInputs.rows&&derivedSourceView(sourceCapability)===source,'selected upstream custody changed');need(qleverSdkSourceAdmissionView(admission,{sdkOriginals:capability,source:sourceCapability})?.verified===true,'same verified SDK source admission required for selected result');};
        current();
        return Object.freeze({paths:Object.freeze([...requested]),readTracked:(path:string)=>{current();const value=raw.get(path);if(!value)throw Error('SDK upstream selected source: path was not requested');parent.check();need(value.length<=parent.remainingReadBytes(),'selected copy exceeds parent read budget');parent.reserveBytes(value.length);parent.chargeReadBytes(value.length);return Buffer.from(value);},assertCurrent:current});
      };
      const cmakeDeclaration=Object.freeze({bytes:cmake.bytes,sha256:cmake.sha256});
      publicObservations.set(capability as object,Object.freeze({cmakeDeclaration,assertCurrent}));
      upstreamObservations.set(capability as object,Object.freeze({sourceCapability,cmakeDeclaration,postpatchMembers,readSelectedOriginals,assertCurrent}));
    }
  } catch (error) { pending.add((error as Error).message); }
  return Object.freeze({facts: Object.freeze(facts), pending: Object.freeze([...pending])});
}

const PRE_SELECTED_HELPER_GROUPS:readonly(readonly(readonly[string,string])[])[]=Object.freeze([...Object.freeze([...Object.freeze([HELPERS,Object.freeze([["sdk-git-source-bindings.py","612063f44d09932b93883db2d186d197bd828e07d39e2df430d9dbe574fd66d0"],["sdk-git-source-observer.py","fd578d0fef97c1d3b4b60e5510320c109c6930580d91db9335d67cbacff186f6"],["sdk-git-patch-projection.py","3e4051b50acf6be11ade6e5d6c05ca23ab8376aa4ff5861975088eab642c8f23"],["sdk-zip-originals.py","86cca59ac6a30eb719fe10dbaf6939c4e7c50328e757f22d3d4d34ea90fe6c10"]] as const),Object.freeze([["sdk-git-source-bindings.py","612063f44d09932b93883db2d186d197bd828e07d39e2df430d9dbe574fd66d0"],["sdk-git-source-observer.py","fd578d0fef97c1d3b4b60e5510320c109c6930580d91db9335d67cbacff186f6"],["sdk-git-patch-projection.py","3e4051b50acf6be11ade6e5d6c05ca23ab8376aa4ff5861975088eab642c8f23"],["sdk-zip-originals.py","cf30b662bfec174a61d229811272241a945318259e9b181e8219330acf0555e6"]] as const),Object.freeze([["sdk-git-source-bindings.py","0fec964b836bd14a197de3df0c536bd1f8353db70f91e31debb93497808101e5"],["sdk-git-source-observer.py","fd578d0fef97c1d3b4b60e5510320c109c6930580d91db9335d67cbacff186f6"],["sdk-git-patch-projection.py","3e4051b50acf6be11ade6e5d6c05ca23ab8376aa4ff5861975088eab642c8f23"],["sdk-zip-originals.py","cf30b662bfec174a61d229811272241a945318259e9b181e8219330acf0555e6"]] as const)]),Object.freeze([["sdk-git-source-bindings.py","f44b1a83859c4f84120dd0521468a26437f6df846465b35ec5e6e5efdd0fcd87"],["sdk-git-source-observer.py","fd578d0fef97c1d3b4b60e5510320c109c6930580d91db9335d67cbacff186f6"],["sdk-git-patch-projection.py","3e4051b50acf6be11ade6e5d6c05ca23ab8376aa4ff5861975088eab642c8f23"],["sdk-zip-originals.py","cf30b662bfec174a61d229811272241a945318259e9b181e8219330acf0555e6"]] as const)]),Object.freeze([["sdk-git-source-bindings.py","4c95c935a5789e1e0669ab1bf7eba67c05f91f013a51c9b6fe968fc288b222ba"],["sdk-git-source-observer.py","fd578d0fef97c1d3b4b60e5510320c109c6930580d91db9335d67cbacff186f6"],["sdk-git-patch-projection.py","3e4051b50acf6be11ade6e5d6c05ca23ab8376aa4ff5861975088eab642c8f23"],["sdk-zip-originals.py","cf30b662bfec174a61d229811272241a945318259e9b181e8219330acf0555e6"]] as const)]);
const REVIEWED_HELPER_GROUPS=Object.freeze([...PRE_SELECTED_HELPER_GROUPS,Object.freeze([["sdk-git-source-bindings.py", "4c95c935a5789e1e0669ab1bf7eba67c05f91f013a51c9b6fe968fc288b222ba"], ["sdk-git-source-observer.py", "a16ec233749df128e9cf21405a26c42c3cfc64e8482ddb94fdc2635b83dc77cd"], ["sdk-git-patch-projection.py", "37e009c20ec5250f7e22bd450f3d9ae74ecddf7f15a51c4e2dd8f55126925aa0"], ["sdk-zip-originals.py", "56f5ec76344b82b5e8242508208b5635663c037b2b915013e23b91c8ccdc3e17"]] as const)]);
