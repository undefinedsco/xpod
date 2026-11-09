import {prepareSdkGitInputApplicability,type SdkGitPreparedApplicability} from './candidate-service-sdk-git-grants';
import {qleverSdkFetchContentSelectedCaptures} from './qlever-sdk-fetchcontent';
import {inspectNativeArchiveInputApplicability} from './candidate-service-native-archive-applicability';
import {inspectTranspiledLegalMappingView} from './legal-source-mappings';
import type {NativeLicenseArchiveObservation} from './candidate-service-native-license-reader';
import {readDerivedSourceOriginals} from './source-context';
import {candidateServiceNativeLegalMaterials} from './candidate-service-native-legal-materials';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import limits from '../module-artifact-limits.json';
import { collectedArtifactView, collectedCandidateServiceRuntime, candidateServiceRuntimeArtifactPath } from './artifact-collector';
import { derivedSourceView } from './source-context';
import { nativeOriginalsView } from './native-original-collector';
import { isCandidateServiceImageGitHubOrigin } from './github-origin';
import { qleverSdkOriginalsView } from './qlever-sdk-originals';
import { inspectCandidateServiceLegalOrigins, LEGAL_GRANT_TEMPLATE_PATHS, type CandidateServiceLegalOrigin,
  type CandidateServiceOriginKind, type CandidateServiceDependencyOriginal, type LegalAdmissionFacts, type LegalAdmissionResult } from './legal-admission';
import type { LegalCoverageReport } from './legal-coverage';

/** Sole legal entry for candidate-service app/SDK runtime members. The source
 * worker's private getter is the only origin/material authority; this module
 * never accepts a caller origin list or reconstructs membership from JSON. */
const SOURCE_QUALIFICATION_MODULE = './candidate-service-source-qualification';
const require = createRequire(import.meta.url);
const requireHere = (name: string): Record<string, unknown> => {
  try { return require(name) as Record<string, unknown>; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code, message = error instanceof Error ? error.message : '';
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND'
      || message.includes("Cannot find module '") || message.includes('Cannot find module "')) return {};
    throw error;
  }
};
function sourceQualification(value: unknown, originals: unknown, source: unknown, sdk: unknown): any {
  const loader = requireHere(SOURCE_QUALIFICATION_MODULE);
  const getter = loader.candidateServiceSourceQualificationView;
  return typeof getter === 'function' ? (getter as (...args: unknown[]) => unknown)(value, originals, source, sdk) : undefined;
}
export interface CandidateServiceLegalBudget { check(): void; remainingMs(): number }
export interface CandidateServiceLegalResult {
  readonly status: 'pending' | 'verified';
  readonly reason: string;
  readonly pending: readonly string[];
  readonly facts: LegalAdmissionFacts;
  readonly coverage?: LegalCoverageReport;
  readonly scope: 'mechanical service app/SDK per-member original grant, provenance and notice preservation; no external legal opinion, whole-OS or release qualification';
}
type OriginRecord = CandidateServiceLegalOrigin & Readonly<{
  original?: unknown; transformation?: unknown; inputs?: readonly unknown[];
  dependency?: Readonly<CandidateServiceDependencyOriginal>;
}>;
interface MaterialSnapshot {
  readonly view: object;
  readonly sourceSha: string;
  readonly readDependencyOriginal: unknown;
  readonly readDependencyOriginalRange: unknown;
  readonly dependencyOriginalIdentity: unknown;
}
interface LegalIssued {
  readonly budget: CandidateServiceLegalBudget;
  readonly originals: unknown; readonly source: unknown; readonly runtimeMembers: unknown; readonly sourceClosure: unknown; readonly sdk: unknown;
  readonly runtimeCapability: object; readonly qualification: object;
  readonly material: MaterialSnapshot;
  readonly originRecords: readonly OriginRecord[];
  readonly result: CandidateServiceLegalResult;
}
const issued = new WeakMap<object, LegalIssued>();
const fail = (message: string): never => { throw Error('Candidate service legal: ' + message); };
function checkBudget(budget: CandidateServiceLegalBudget | undefined): void {
  if (!budget || typeof budget.check !== 'function' || typeof budget.remainingMs !== 'function') fail('one shared parent budget required');
  const checked = budget as CandidateServiceLegalBudget;
  checked.check(); const remaining = checked.remainingMs();
  if (!Number.isFinite(remaining) || remaining <= 0) fail('shared parent budget exhausted');
  checked.check();
}
function requireRuntime(native: unknown, source: unknown, sdk: unknown): { originals: NonNullable<ReturnType<typeof nativeOriginalsView>>; source: NonNullable<ReturnType<typeof derivedSourceView>>; sdk: NonNullable<ReturnType<typeof qleverSdkOriginalsView>> } {
  const originals = nativeOriginalsView(native), immutable = derivedSourceView(source), sdkOriginals = qleverSdkOriginalsView(sdk);
  if (!originals || !immutable || !sdkOriginals) return fail('same issued native/original handles required');
  if (!isCandidateServiceImageGitHubOrigin(originals.origin)) return fail('candidate service native origin required');
  // The APP/SERVICE source is one commit: the native artifact's commit and the
  // immutable derived source must be identical. That is a real equality, never
  // a shortcut.
  if (originals.originFacts.sourceSha !== immutable.sourceSha) return fail('native origin and immutable app source are the same commit');
  // The SDK is acquired from its OWN GitHub artifact coordinates and may be a
  // DIFFERENT commit (SOURCE V2/V3 model it as a typed origin partition). The
  // equal-commit shortcut is therefore forbidden; instead the SDK handle must
  // carry a real source sha and its own exact artifact tuple, which the SOURCE
  // cross-seal (below) validates against the genuine source view.
  if (typeof sdkOriginals.originFacts.sourceSha !== 'string'
    || !/^[a-f0-9]{40}$/u.test(sdkOriginals.originFacts.sourceSha)) return fail('SDK origin carries a real source sha');
  if (!Number.isSafeInteger(sdkOriginals.originFacts.runId) || !Number.isSafeInteger(sdkOriginals.originFacts.runAttempt)
    || sdkOriginals.originFacts.runId <= 0 || sdkOriginals.originFacts.runAttempt <= 0) return fail('SDK origin carries real run/attempt coordinates');
  return { originals, source: immutable, sdk: sdkOriginals };
}

/** Composite source-identity check consumed by the legal observer. It uses the
 * genuine private SOURCE view (when present via sourceClosure) to cross-seal the
 * App and SDK universes. When the source view is absent this returns only the
 * structural SDK coordinate assertions, so legal never substitutes an
 * equal-commit proof for a real cross-seal. */
function crossSealSdkSource(qualification: any, sdkOriginals: NonNullable<ReturnType<typeof qleverSdkOriginalsView>>, appSourceSha: string): void {
  if (!qualification || typeof qualification !== 'object') return;
  const declared = qualification.sdkSourceSha;
  const same = qualification.appSdkSameSourceSha;
  // The source view must REPORT the its own SDK sha and whether it equals the app
  // commit; legal requires the report to agree with the SDK handle it now holds.
  if (declared !== undefined) {
    if (typeof declared !== 'string' || !/^[a-f0-9]{40}$/u.test(declared)) fail('source view must report a real SDK source sha');
    if (declared !== sdkOriginals.originFacts.sourceSha) fail('source view SDK sha differs from the held SDK originals');
  }
  if (same !== undefined && typeof same !== 'boolean') fail('source view must report the App/SDK sha relation as a boolean');
  if (typeof same === 'boolean' && same !== (appSourceSha === sdkOriginals.originFacts.sourceSha))
    fail('source view App/SDK sha relation disagrees with the held handles');
}
const same = (a: unknown, b: unknown): boolean => typeof a === 'object' && a !== null && a === b;
const absolutePath = (name: unknown): name is string => typeof name === 'string' && (name === '/app' || name.startsWith('/app/')
  || name === '/opt/xpod/qlever' || name.startsWith('/opt/xpod/qlever/')) && !name.split('/').some(part => part === '.' || part === '..');
const safeRelative = (name: unknown): name is string => typeof name === 'string' && name.length > 0 && !name.startsWith('/')
  && !name.includes('\\') && !name.split('/').some(part => !part || part === '.' || part === '..');

/** Deep-frozen defensive material snapshot. The reader view comes from the
 * private getter; moduleSourceMaterialView() is neither called nor required. */
/** Exported for interface/mutation tests only; it issues no capability. */
export function candidateServiceMaterialSnapshot(value: unknown, sourceSha: string): Readonly<{sourceSha:string}> { const snapshot = materialSnapshot(value, sourceSha); return Object.freeze({ sourceSha: snapshot.sourceSha }); }
function materialSnapshot(value: unknown, sourceSha: string): MaterialSnapshot {
  if (!value || typeof value !== 'object') return fail('private source material view required');
  const view = value as Record<string, unknown>;
  if (view.sourceSha !== sourceSha || !Array.isArray(view.outputs) || !Array.isArray(view.transpiledOutputs)
    || !Array.isArray(view.dependencyRows) || !Array.isArray(view.trackedSourcePaths)
    || typeof view.readDependencyOriginal !== 'function' || typeof view.readDependencyOriginalRange !== 'function'
    || typeof view.dependencyOriginalIdentity !== 'function' || typeof view.assertCurrent !== 'function') fail('complete private source material reader view required');
  (view.assertCurrent as () => void)();
  return Object.freeze({ view, sourceSha, readDependencyOriginal: view.readDependencyOriginal,
    readDependencyOriginalRange: view.readDependencyOriginalRange, dependencyOriginalIdentity: view.dependencyOriginalIdentity });
}
/** Absent or genuinely held opaque references only; primitives never act as caps. */
const sameOpaque = (a: unknown, b: unknown): boolean => a === undefined || a === null ? b === undefined || b === null : typeof a === 'object' && a === b;
function originalMetadataSnapshot(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return fail('origin original metadata required');
  const row = value as Record<string, unknown>, archive = row.archive as Record<string, unknown> | undefined;
  if (!row.original || typeof row.original !== 'object' || typeof row.name !== 'string' || !row.name
    || typeof row.version !== 'string' || !row.version || typeof row.sourceRoot !== 'string' || !row.sourceRoot
    || !archive || typeof archive.url !== 'string' || !archive.url || /[\u0000-\u001f\u007f\\]/u.test(archive.url)
    || !Number.isSafeInteger(archive.bytes) || (archive.bytes as number) < 0
    || typeof archive.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(archive.sha256)) return fail('complete original/archive metadata required');
  return Object.freeze({ original: row.original, name: row.name, version: row.version, sourceRoot: row.sourceRoot,
    archive: Object.freeze({ url: archive.url, bytes: archive.bytes, sha256: archive.sha256 }) });
}
function sameOriginalMetadata(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  if (!sameOpaque(left.original, right.original) || left.name !== right.name || left.version !== right.version || left.sourceRoot !== right.sourceRoot) return false;
  const a = left.archive as Record<string, unknown> | undefined, b = right.archive as Record<string, unknown> | undefined;
  return Boolean(a && b && a.url === b.url && a.bytes === b.bytes && a.sha256 === b.sha256);
}
/** Opaque provenance capabilities are compared by reference, never structurally. */
function sameOriginRecord(a: OriginRecord, b: OriginRecord): boolean {
  if (a.path !== b.path || a.kind !== b.kind || a.sourcePath !== b.sourcePath || a.originalPath !== b.originalPath || a.runtimePath !== b.runtimePath) return false;
  const left = a as unknown as Record<string, unknown>, right = b as unknown as Record<string, unknown>;
  if (!sameOpaque(left.original, right.original) || !sameOpaque(left.transformation, right.transformation)) return false;
  const leftInputs = left.inputs as readonly Record<string, unknown>[] | undefined, rightInputs = right.inputs as readonly Record<string, unknown>[] | undefined;
  if ((leftInputs?.length ?? 0) !== (rightInputs?.length ?? 0)) return false;
  if (leftInputs && rightInputs) for (let index = 0; index < leftInputs.length; index++) {
    if (!sameOriginalMetadata(leftInputs[index]!, rightInputs[index]!)) return false;
  }
  const leftDependency = left.dependency as Record<string, unknown> | undefined, rightDependency = right.dependency as Record<string, unknown> | undefined;
  if (!leftDependency || !rightDependency) return !leftDependency === !rightDependency;
  return sameOriginalMetadata(leftDependency, rightDependency);
}
/** Canonical origins accessor. The snapshot is a frozen array of frozen
 * records; opaque original/transformation/input capabilities are retained by
 * reference and are never compared by structural equality or serialized. */
/** Exported for interface/mutation tests only; it issues no capability. */
export function candidateServiceOriginSnapshot(accessor: unknown): readonly Readonly<{path:string;kind:CandidateServiceOriginKind}>[] { return originSnapshot(accessor); }
function originSnapshot(accessor: unknown): readonly OriginRecord[] {
  if (!accessor || typeof accessor !== 'object') return fail('private source origins accessor required');
  const value = accessor as Record<string, unknown>;
  if (typeof value.lookup !== 'function' || typeof value.list !== 'function') return fail('private source origins lookup/list required');
  const rows = (value.list as () => unknown)();
  if (!Array.isArray(rows) || rows.length > 100000) return fail('bounded private source origins list required');
  const seen = new Map<string, OriginRecord>();
  const frozen: OriginRecord[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') return fail('frozen private origin record required');
    const row = raw as Record<string, unknown>;
    if (!absolutePath(row.path) || typeof row.kind !== 'string') return fail('absolute typed private origin required');
    const kind = row.kind as CandidateServiceOriginKind;
    const record: Record<string, unknown> = { path: row.path, kind };
    if (kind === 'exact-source') {
      if (!safeRelative(row.sourcePath)) return fail('exact-source origin needs a source path');
      record.sourcePath = row.sourcePath;
    } else if (kind === 'installed-projection') {
      if (!safeRelative(row.originalPath)) return fail('installed-projection origin needs a package path');
      record.originalPath = row.originalPath; record.dependency = originalMetadataSnapshot(row.dependency);
    } else if (kind === 'workspace-transform') {
      if (!safeRelative(row.sourcePath) || typeof row.transformation !== 'object' || !row.transformation
        || !Array.isArray(row.inputs) || row.inputs.length < 1 || row.inputs.length > 4096
        || row.inputs.some((input: unknown) => !input || typeof input !== 'object' || typeof (input as any).original !== 'object')) return fail('workspace-transform transformation/input capabilities required');
      record.sourcePath = row.sourcePath; record.transformation = row.transformation;
      record.inputs = Object.freeze(row.inputs.map(originalMetadataSnapshot));
    } else if (kind === 'native-runtime') {
      if (!safeRelative(row.runtimePath) || typeof row.original !== 'object' || !row.original) return fail('native-runtime private original capability required');
      record.runtimePath = row.runtimePath; record.original = row.original;
    } else return fail('reviewed private origin kind required');
    const frozenRecord = Object.freeze(record) as unknown as OriginRecord;
    if (seen.has(frozenRecord.path)) return fail('duplicate private origin record');
    seen.set(frozenRecord.path, frozenRecord); frozen.push(frozenRecord);
  }
  // lookup(path) must agree with list() on every field and on the opaque
  // original/transformation references. The canonical container itself is
  // module-private, so repeated list/lookup calls are the only mutation probe.
  for (const record of frozen) {
    const resolved = (value.lookup as (path: string) => unknown)(record.path);
    if (!resolved || typeof resolved !== 'object' || !sameOriginRecord(record, resolved as OriginRecord)) return fail('private origins lookup/list disagree');
  }
  const repeated = (value.list as () => unknown)();
  if (!Array.isArray(repeated) || repeated.length !== frozen.length
    || frozen.some((record, index) => !repeated[index] || typeof repeated[index] !== 'object' || !sameOriginRecord(record, repeated[index] as OriginRecord))) return fail('private origins list is not stable');
  return Object.freeze(frozen);
}
function materialStillCurrent(snapshot: MaterialSnapshot, current: unknown): boolean {
  if (!current || typeof current !== 'object') return false;
  const view = current as Record<string, unknown>;
  return view.sourceSha === snapshot.sourceSha
    && view.readDependencyOriginal === snapshot.readDependencyOriginal
    && view.readDependencyOriginalRange === snapshot.readDependencyOriginalRange
    && view.dependencyOriginalIdentity === snapshot.dependencyOriginalIdentity
    && typeof view.assertCurrent === 'function';
}
function originsStillCurrent(accessor: unknown, snapshot: readonly OriginRecord[]): boolean {
  if (!accessor || typeof accessor !== 'object') return false;
  const value = accessor as Record<string, unknown>;
  if (typeof value.lookup !== 'function' || typeof value.list !== 'function') return false;
  const rows = (value.list as () => unknown)();
  if (!Array.isArray(rows) || rows.length !== snapshot.length) return false;
  return snapshot.every((record, index) => {
    const current = rows[index], resolved = (value.lookup as (path: string) => unknown)(record.path);
    return Boolean(current && typeof current === 'object' && resolved && typeof resolved === 'object'
      && sameOriginRecord(record, current as OriginRecord) && sameOriginRecord(record, resolved as OriginRecord));
  });
}

/** Only the source worker's getter resolves origins/materials. The runtime
 * artifact is collected through the existing collector issuer and must be the
 * exact same opaque handle that the source view returned. */
export async function observeCandidateServiceLegal(input: {
  originals: unknown; source: unknown; runtimeMembers: unknown; sourceClosure: unknown; sdk: unknown; budget: CandidateServiceLegalBudget;
}): Promise<CandidateServiceLegalResult> {
  checkBudget(input.budget);
  const bound = requireRuntime(input.originals, input.source, input.sdk);
  const qualification = sourceQualification(input.sourceClosure, input.originals, input.source, input.sdk);
  if (!qualification || typeof qualification !== 'object') throw Error('Candidate service legal: private source qualification unavailable (candidateServiceSourceQualificationView missing)');
  // Consume the genuine SOURCE origin partition/cross-seal; the equal-commit
  // shortcut must never stand in for it.
  crossSealSdkSource(qualification, bound.sdk, bound.source.sourceSha);
  if (!same(qualification.runtimeArtifact, input.runtimeMembers)) fail('source qualification must return the same runtime artifact handle');
  if (typeof qualification.assertCurrent !== 'function') fail('private source qualification current guard required');
  qualification.assertCurrent();
  const material = materialSnapshot(qualification.materials, bound.source.sourceSha);
  const originRecords = originSnapshot(qualification.origins);
  const { collectCandidateServiceRuntimeArtifact } = require('./artifact-collector.ts') as typeof import('./artifact-collector');
  const runtimeCapability = collectCandidateServiceRuntimeArtifact({ runtime: qualification.runtimeArtifact, originals: input.originals, source: input.source });
  if (!runtimeCapability) throw Error('Candidate service legal: private runtime artifact issuer unavailable (candidateServiceRuntimeArtifactView missing)');
  const collected = collectedCandidateServiceRuntime(runtimeCapability), artifact = collectedArtifactView(runtimeCapability);
  if (!collected || !artifact) return fail('issued runtime artifact capability required');
  const entries = new Map<string, 'file' | 'directory' | 'symlink'>();
  for (const entry of collected.entries) entries.set(entry.path, entry.type);
  const memberPaths = new Map<string, string>();
  for (const entry of collected.entries) if (entry.type === 'file') memberPaths.set(entry.path, candidateServiceRuntimeArtifactPath(entry.path));
  if (memberPaths.size !== artifact.members.length) fail('runtime file membership adapter is not bijective');
  const pending: string[] = [];
  let nativeMaterials:ReturnType<typeof candidateServiceNativeLegalMaterials>|undefined;
  if(originRecords.some(row=>row.kind==='native-runtime')&&qualification.nativeContext){
    const budget=input.budget as CandidateServiceLegalBudget & {chargeReadBytes(bytes:number):void;remainingReadBytes():number;reserveBytes(bytes:number):void};
    if(typeof budget.chargeReadBytes!=='function'||typeof budget.remainingReadBytes!=='function'||typeof budget.reserveBytes!=='function')fail('same shared native legal read/reservation budget required');
    nativeMaterials=candidateServiceNativeLegalMaterials({serviceOriginals:input.originals,source:input.source,runtimeArtifact:input.runtimeMembers,nativeContext:qualification.nativeContext,budget});
  }
  const legalBudget=input.budget as CandidateServiceLegalBudget & {chargeReadBytes(bytes:number):void;remainingReadBytes():number;reserveBytes(bytes:number):void};
  const gitPaths=new Set<string>(Object.values(LEGAL_GRANT_TEMPLATE_PATHS));
  for(const record of originRecords)if(record.kind==='exact-source'&&record.sourcePath)gitPaths.add(record.sourcePath);
  if(nativeMaterials)for(const record of originRecords){
    if(record.kind!=='native-runtime'||!record.runtimePath||!record.original)continue;
    for(const row of nativeMaterials.inputsForOrigin({path:record.path,runtimePath:record.runtimePath,original:record.original}))if(row.via==='git'&&row.path.startsWith('/workspace/xpod/'))gitPaths.add(row.path.slice('/workspace/xpod/'.length));
  }
  for(const selected of [...gitPaths]){let directory=selected.includes('/')?selected.slice(0,selected.lastIndexOf('/')):'';for(;;){for(const name of bound.source.trackedPaths){const parent=name.includes('/')?name.slice(0,name.lastIndexOf('/')):'';if(parent===directory&&/^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/iu.test(name.slice(name.lastIndexOf('/')+1)))gitPaths.add(name);}if(!directory)break;directory=directory.includes('/')?directory.slice(0,directory.lastIndexOf('/')):'';}}
  const gitOriginals=await readDerivedSourceOriginals(input.source,[...gitPaths],legalBudget);
  const template = bound.source.trackedPaths.includes(LEGAL_GRANT_TEMPLATE_PATHS.mit) ? gitOriginals.readTracked(LEGAL_GRANT_TEMPLATE_PATHS.mit)
    : fail('immutable MIT template required');
  // Only file entries carry file origins. Directory/symlink records are
  // validated as structural membership and never acquire a grant.
  const legalOrigins: CandidateServiceLegalOrigin[] = originRecords.filter(record => entries.get(record.path) === 'file').map(record => Object.freeze({ path: record.path, kind: record.kind,
    ...(record.sourcePath ? { sourcePath: record.sourcePath } : {}), ...(record.originalPath ? { originalPath: record.originalPath } : {}),
    ...(record.runtimePath ? { runtimePath: record.runtimePath } : {}), ...(record.original ? {original:record.original} : {}), ...(record.dependency ? { dependency: record.dependency } : {}) }));
  for (const record of originRecords) if (!entries.has(record.path)) pending.push('Source origin is not an actual runtime member: ' + record.path);
  for (const entry of collected.entries) if (entry.type === 'file' && !originRecords.some(record => record.path === entry.path)) pending.push('Runtime file lacks complete provenance origin: ' + entry.path);
  const readTemplate = (name: string) => bound.source.trackedPaths.includes(name) ? gitOriginals.readTracked(name) : undefined;
  const isc = readTemplate(LEGAL_GRANT_TEMPLATE_PATHS.isc), apache = readTemplate(LEGAL_GRANT_TEMPLATE_PATHS.apache);
  if (!isc || !apache) return fail('immutable ISC/Apache original templates required');
  const packageArchives=new Map<string,NativeLicenseArchiveObservation[]>();
  if(nativeMaterials){
    const selectedCoordinates=new Set<string>();
    for(const origin of legalOrigins){
      if(origin.kind!=='native-runtime'||!origin.runtimePath||!origin.original)continue;
      for(const row of nativeMaterials.inputsForOrigin({path:origin.path,runtimePath:origin.runtimePath,original:origin.original})){
        if(row.sourceCoordinate)selectedCoordinates.add(row.sourceCoordinate.name+'\0'+row.sourceCoordinate.version);
      }
    }
    for(const coordinateKey of selectedCoordinates){
      const coordinate=nativeMaterials.coordinates.find(row=>row.name+'\0'+row.version===coordinateKey);
      if(!coordinate){pending.push('Authenticated native package source archive absent: '+coordinateKey.replace('\0',':'));continue;}
      for(const archive of coordinate.archives){
        let observed=await nativeMaterials.scanArchive(archive.path);
        const selected=new Set<string>();
        for(const origin of legalOrigins){if(origin.kind!=='native-runtime'||!origin.runtimePath||!origin.original)continue;for(const row of nativeMaterials.inputsForOrigin({path:origin.path,runtimePath:origin.runtimePath,original:origin.original})){if(!row.sourceCoordinate||row.sourceCoordinate.name+'\0'+row.sourceCoordinate.version!==coordinateKey)continue;for(const member of observed.members)if(member.type==='file'&&member.bytes===row.bytes&&member.sha256===row.sha256)selected.add(member.path);}}
        if(selected.size)observed=await nativeMaterials.scanArchive(archive.path,[...selected]);
        packageArchives.set(coordinateKey,[...(packageArchives.get(coordinateKey)??[]),observed]);
        nativeMaterials.assertCurrent();
        // Whole-package retention is conservative. It is not by itself proof
        // that each source member's license applies to a generated input.
        if(!observed.texts.length)pending.push('Native source original notice absent: '+archive.path);
        for(const notice of observed.texts)if(!artifact.members.some(member=>member.bytes===notice.bytes&&member.sha256===notice.sha256))
          pending.push('Native applicable package original notice not retained: '+archive.path+':'+notice.path);
      }
    }
  }
  // Prepared from actual private upstream selected reads once, before the
  // synchronous parser. Unknown SDK inputs stay explicit pending, never true.
  const preparedSdkGit = new Map<string, SdkGitPreparedApplicability>();
  const sdkContext = qualification.nativeContext as undefined | {sdkOriginals?: unknown; sdkAdmission?: unknown};
  if (nativeMaterials && sdkContext && sdkContext.sdkOriginals !== undefined && sdkContext.sdkAdmission !== undefined) {
    for (const origin of legalOrigins) {
      if (origin.kind !== 'native-runtime' || !origin.runtimePath || !origin.original) continue;
      const memberPath = memberPaths.get(origin.path);
      if (!memberPath) continue;
      for (const row of nativeMaterials.inputsForOrigin({ path: origin.path, runtimePath: origin.runtimePath, original: origin.original })) {
        if (row.via !== 'sdk') continue;
        const key = [memberPath, row.path, row.bytes, row.sha256, row.mode].join('\u0000');
        if (preparedSdkGit.has(key)) continue;
        try {
          const prepared = await prepareSdkGitInputApplicability({ sdkOriginals: sdkContext.sdkOriginals, source: input.source, sdkAdmission: sdkContext.sdkAdmission,
            input: { path: row.path, bytes: row.bytes, sha256: row.sha256, mode: row.mode }, artifact, memberPath, sourceSha: bound.source.sourceSha, budget: legalBudget });
          preparedSdkGit.set(key, prepared);
          checkBudget(legalBudget);
        } catch (error) {
          pending.push('SDK Git input applicability unavailable: ' + row.path + ': ' + String((error as Error)?.message ?? error).slice(0, 512));
        }
      }
    }
  }
  // Actual FetchContent dependency reads carry authenticated full-range
  // source bytes already observed from the same SDK ZIP. Map exact records to
  // the same artifact member and route through the existing normative parser.
  const dependencyCaptures = new Map<string, any>(), dependencyNotices = new Map<string, any>();
  const sdkDependencyPaths=new Set<string>();
  if(nativeMaterials){for(const origin of legalOrigins){if(origin.kind!=='native-runtime'||!origin.runtimePath||!origin.original)continue;for(const row of nativeMaterials.inputsForOrigin({path:origin.path,runtimePath:origin.runtimePath,original:origin.original})){if(row.via==='sdk'&&row.path.startsWith('/opt/qlever-sdk/dependencies/'))sdkDependencyPaths.add(row.path);}}}
  if (sdkContext && sdkContext.sdkOriginals !== undefined && sdkDependencyPaths.size) {
    const requestedPaths=[...sdkDependencyPaths].sort();
    const rows = requestedPaths.length ? await qleverSdkFetchContentSelectedCaptures(sdkContext.sdkOriginals, input.source, sdkContext.sdkAdmission, legalBudget, requestedPaths) : undefined;
    if (rows) for (const row of rows) {
      checkBudget(legalBudget);
      const key = [row.path, row.bytes, row.sha256, row.mode].join('\u0000');
      if (row.requested === true) { if (!dependencyCaptures.has(key)) dependencyCaptures.set(key, row); }
      else { if (!/^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/iu.test(row.path.split('/').pop() ?? '')) fail('automatic dependency ancestor notice required'); if (!dependencyNotices.has(key)) dependencyNotices.set(key, row); }
    }
  }
  const nativePackageGrant = (row: any, memberPath: string, verifyGrant: (bytes: Buffer) => boolean, declarations: (bytes: Buffer) => string[]) => {
    if (row.via === 'sdk' && row.path.startsWith('/opt/qlever-sdk/dependencies/')) {
      const capture = dependencyCaptures.get([row.path, row.bytes, row.sha256, row.mode].join('\u0000'));
      if (!capture) return {covered: false, pending: ['SDK dependency input lacks authenticated complete-phase source bytes: ' + row.path + ':' + row.sha256]};
      try {
        // Complete applicable scope: the exact source member plus every
        // authenticated ancestor notice from the same dependency universe.
        const sourceBytes = capture.readTracked(row.path);
        const members: any[] = [{path: row.path, type: 'file', bytes: capture.bytes, sha256: capture.sha256}];
        const texts: any[] = [{path: row.path, bytes: capture.bytes, sha256: capture.sha256, text: sourceBytes}];
        let noticeTotal = 0;
        for (const notice of dependencyNotices.values()) {
          checkBudget(legalBudget);
          const bytes = notice.readTracked(notice.path);
          noticeTotal += bytes.length;
          if (noticeTotal > limits.metadataBytes) fail('dependency notice bytes exceed metadata ceiling');
          members.push({path: notice.path, type: 'file', bytes: notice.bytes, sha256: notice.sha256});
          texts.push({path: notice.path, bytes: notice.bytes, sha256: notice.sha256, text: bytes});
        }
        const result = inspectNativeArchiveInputApplicability({original: row, memberPath, sourceSha: bound.source.sourceSha,
          members, texts, artifact, check: () => { checkBudget(legalBudget); }, chargeReadBytes: n => legalBudget.chargeReadBytes(n), verifyGrant, declarations});
        return {covered: result.covered, pending: result.pending};
      } catch (error) { return {covered: false, pending: ['SDK dependency source applicability rejected: ' + String((error as Error)?.message ?? error).slice(0, 512)]}; }
    }
    if (row.via === 'sdk' || row.via === 'debian') {
      // Generated-output contributors are identified by an actual prepared
      // binding; direct Debian rows have already returned above via their real
      // sourceCoordinate.
      const prepared = preparedSdkGit.get([memberPath, row.path, row.bytes, row.sha256, row.mode].join('\u0000'));
      if (!prepared && row.via === 'debian') {
        // Direct Debian row: fall through to the authenticated source
        // coordinate archive path below, never a provider-identity branch.
      } else {
      if (!prepared) return {covered: false, pending: ['SDK generated input requires prepared contributor binding: ' + row.path]};
      try {
        const inspected = prepared.inspect(verifyGrant, declarations);
        // Signed Debian contributors must resolve against the ACTUAL signed
        // package source archive members already authenticated by the native
        // Debian observation. Observed path/bytes/SHA alone is not authority.
        const debianContributors = (inspected as any).debianSourceInputs
          ?? (prepared as any).debianSourceInputs ?? [];
        let debianCovered = true;
        const debianPending: string[] = [];
        for (const contributor of debianContributors) {
          checkBudget(legalBudget);
          const coordinate = nativeMaterials?.coordinates.find(row =>
            row.name === contributor.source?.name && row.version === contributor.source?.version);
          if (!coordinate) {
            debianCovered = false;
            debianPending.push('SDK signed Debian source coordinate lacks authenticated archive: '
              + contributor.observedPath + ':' + contributor.sha256);
            continue;
          }
          const archives = packageArchives.get(coordinate.name + '\0' + coordinate.version) ?? [];
          const origin = {path: contributor.installedPath, bytes: contributor.bytes,
            sha256: contributor.sha256, mode: contributor.mode};
          const matching = archives.filter(archive => archive.members.some(member =>
            member.type === 'file' && member.bytes === contributor.bytes
            && member.sha256 === contributor.sha256));
          if (!matching.length) {
            debianCovered = false;
            debianPending.push('SDK signed Debian input has no byte-identical authenticated source member: '
              + contributor.installedPath + ':' + contributor.sha256);
            continue;
          }
          const results = matching.map(archive => inspectNativeArchiveInputApplicability({
            original: origin, memberPath, sourceSha: bound.source.sourceSha,
            members: archive.members,
            texts: [...new Map([...archive.texts, ...archive.selectedTexts].map(text => [text.path, text])).values()],
            artifact,
            check: () => { checkBudget(legalBudget); nativeMaterials!.assertCurrent(); },
            chargeReadBytes: n => legalBudget.chargeReadBytes(n), verifyGrant, declarations}));
          debianCovered &&= results.every(result => result.covered);
          debianPending.push(...results.flatMap(result => result.pending));
        }
        // A nonempty unresolved Debian contributor set can NEVER be covered on
        // postpatch evidence alone. Empty means there was nothing to resolve.
        const covered = inspected.covered && (debianContributors.length === 0 || debianCovered);
        if (debianContributors.length > 0 && !debianCovered && !debianPending.length)
          debianPending.push('SDK signed Debian contributors unresolved without concrete reason');
        return {covered, pending: [...inspected.pending, ...debianPending]};
      } catch (error) { return {covered: false, pending: ['SDK Git applicability rejected: ' + String((error as Error)?.message ?? error).slice(0, 512)]}; }
      }
    }
    // Direct Debian inputs (real `sourceCoordinate` from authenticated dpkg/
    // Packages) always use the authenticated package/source archive path.
    if(row.via==='debian'&&row.sourceCoordinate){
      const archives=packageArchives.get(row.sourceCoordinate.name+'\0'+row.sourceCoordinate.version)??[];
      const matching=archives.filter(archive=>archive.members.some(member=>member.type==='file'&&member.bytes===row.bytes&&member.sha256===row.sha256));
      if(!matching.length)return {covered:false,pending:['Native installed input has no byte-identical authenticated source member: '+row.path]};
      const results=matching.map(archive=>inspectNativeArchiveInputApplicability({original:row,memberPath,sourceSha:bound.source.sourceSha,members:archive.members,texts:[...new Map([...archive.texts,...archive.selectedTexts].map(text=>[text.path,text])).values()],artifact,check:()=>{checkBudget(legalBudget);nativeMaterials!.assertCurrent();},chargeReadBytes:n=>legalBudget.chargeReadBytes(n),verifyGrant,declarations}));
      return {covered:results.every(result=>result.covered),pending:results.flatMap(result=>result.pending)};
    }
    if(row.via!=='debian')return {covered:false,pending:['Native '+row.via+' input requires authenticated package/source applicability: '+row.path]};
    return {covered:false,pending:['Native Debian input lacks authenticated source coordinate: '+row.path]};
  };
  // Native producer retention: every applicable selected source notice must
  // have an exact byte-identical actual runtime artifact member, and the same
  // source/input/output membership is checked by the existing normative
  // parser below. No new grant table is created.
  if (nativeMaterials && sdkContext && sdkContext.sdkOriginals !== undefined) {
    const retainedNotices=[...dependencyNotices.values()];
    for (const row of retainedNotices) {
      checkBudget(legalBudget);
      // Source code is compiled, not shipped; only applicable notice texts are
      // required as byte-identical actual runtime artifact members. The
      // producer itself is owned elsewhere, so an absent copy stays pending
      // rather than being claimed as wired retention.
      if (row.requested === false) {
        const bytes = row.readTracked(row.path);
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (!artifact.members.some(member => member.bytes === bytes.length && member.sha256 === digest))
          pending.push('Native applicable source notice not retained verbatim by runtime producer: ' + row.path);
      }
    }
  }
  const coverage = inspectCandidateServiceLegalOrigins(artifact, bound.source, legalOrigins, memberPaths, pending, template, {
    nativeMaterials,nativePackageGrant,
    workspaceTransformGrant: (origin: any, memberPath: string, verifyGrant: (bytes: Buffer) => boolean, declarations: (bytes: Buffer) => string[]) => {
      if (typeof origin.sourcePath !== 'string' || !safeRelative(origin.sourcePath) || !origin.transformation
        || !Array.isArray(origin.inputs) || !origin.inputs.length)
        return {covered: false, pending: ['Workspace-transform private mapping incomplete: ' + origin.path]};
      try {
        // The transform itself must be an actual tracked immutable source file;
        // never an arbitrary caller array. Every listed input must also be the
        // same tracked source, and its actual bytes are read privately.
        if (!bound.source.trackedPaths.includes(origin.sourcePath))
          throw Error('workspace-transform source absent from immutable source');
        const actual = origin.inputs.map((input: any) => {
          const name = String(input?.path ?? '');
          if (!safeRelative(name) || !bound.source.trackedPaths.includes(name)) throw Error('workspace-transform input absent from immutable source');
          gitOriginals.readTracked(name); checkBudget(legalBudget);
          return {path: memberPath, sourcePath: name};
        });
        const mappings = actual.map((row: any) => ({path: memberPath, sourcePath: row.sourcePath}));
        const view = inspectTranspiledLegalMappingView({material: {sourceSha: bound.source.sourceSha, outputs: artifact.members,
          transpiledOutputs: mappings}, artifactSourceSha: bound.source.sourceSha, sourceSha: bound.source.sourceSha,
          trackedPaths: bound.source.trackedPaths, readTracked: name => gitOriginals.readTracked(name), artifactMembers: artifact.members,
          check: () => checkBudget(legalBudget)}, verifyGrant, declarations);
        return {covered: view.pending.length === 0 && view.coveredOutputs.includes(memberPath), pending: view.pending};
      } catch (error) {
        return {covered: false, pending: ['Workspace-transform applicability rejected: ' + String((error as Error)?.message ?? error).slice(0, 512)]};
      }
    },
    nativeReadTracked:gitOriginals.readTracked, nativeReadBudget: nativeMaterials ? input.budget as CandidateServiceLegalBudget & {chargeReadBytes(bytes:number):void;remainingReadBytes():number} : undefined, runtimeArtifact: input.runtimeMembers, originals: input.originals, source: input.source,
    grants: { mit: template, isc, apache }, check: () => checkBudget(input.budget) });
  checkBudget(input.budget);
  qualification.assertCurrent();
  if (!materialStillCurrent(material, qualification.materials) || !originsStillCurrent(qualification.origins, originRecords)) fail('private source material/origin context changed during observation');
  const facts: LegalAdmissionFacts = { artifactCustodyVerified: Boolean(artifact), immutableSourceVerified: Boolean(bound.source),
    exactFileCoverageVerified: coverage.complete,
    originalNoticesVerified: !pending.some(message => /notice|retained/iu.test(message)),
    normativeGrantVerified: !pending.some(message => /grant|copyright|license declaration|SPDX expression/iu.test(message)),
    legalQualified: false };
  facts.legalQualified = facts.artifactCustodyVerified && facts.immutableSourceVerified && facts.exactFileCoverageVerified
    && facts.originalNoticesVerified && facts.normativeGrantVerified && pending.length === 0;
  const result: CandidateServiceLegalResult = Object.freeze({ status: facts.legalQualified ? 'verified' : 'pending',
    reason: [...new Set(pending)].join('; ') || 'Complete app/SDK runtime files have applicable original grants, notices and provenance',
    pending: Object.freeze([...new Set(pending)]), facts: Object.freeze(facts), coverage,
    scope: 'mechanical service app/SDK per-member original grant, provenance and notice preservation; no external legal opinion, whole-OS or release qualification' });
  if (result.status === 'verified') {
    issued.set(result, Object.freeze({ originals: input.originals, source: input.source, runtimeMembers: input.runtimeMembers,
      sourceClosure: input.sourceClosure, sdk: input.sdk, budget: input.budget, runtimeCapability, qualification, material, originRecords, result }));
  }
  return result;
}

/** Same actual private handles, source-issued origin/material contexts and
 * current guards. Copied/frozen result objects are not capabilities. */
export function candidateServiceLegalView(value: unknown, input: {
  originals: unknown; source: unknown; runtimeMembers: unknown; sourceClosure: unknown; sdk: unknown; budget: CandidateServiceLegalBudget;
}): CandidateServiceLegalResult | undefined {
  const row = value && typeof value === 'object' ? issued.get(value) : undefined;
  if (!row || row.originals !== input.originals || row.source !== input.source || row.runtimeMembers !== input.runtimeMembers
    || row.sourceClosure !== input.sourceClosure || row.sdk !== input.sdk) return undefined;
  if (row.budget !== input.budget) return fail('same shared parent budget required');
  checkBudget(row.budget);
  requireRuntime(input.originals, input.source, input.sdk);
  const runtime = collectedCandidateServiceRuntime(row.runtimeCapability);
  if (!runtime || !same(runtime.originals, input.originals) || !same(runtime.source, input.source)) return fail('runtime artifact private handles changed');
  const qualification = sourceQualification(input.sourceClosure, input.originals, input.source, input.sdk);
  if (!qualification || !same(qualification, row.qualification) || !same(qualification.runtimeArtifact, input.runtimeMembers)
    || typeof qualification.assertCurrent !== 'function') return fail('source qualification current handle changed');
  qualification.assertCurrent();
  if (!materialStillCurrent(row.material, qualification.materials)) fail('source material reader context changed');
  if (!originsStillCurrent(qualification.origins, row.originRecords)) fail('source origin context changed');
  checkBudget(input.budget);
  return row.result;
}
