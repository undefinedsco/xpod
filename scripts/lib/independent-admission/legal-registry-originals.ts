import moduleArtifactLimits from '../module-artifact-limits.json';
import registryOriginalLimits from '../registry-legal-original-limits.json';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { collectedArtifactView } from './artifact-collector';
import { derivedSourceView } from './source-context';
import type { CollectedArtifactMember, DerivedSourceView } from './artifact-contract';
const { inspectTarballBuffer } = createRequire(import.meta.url)('../../workspace-package-payload.cjs');
function fail(message: string): never { throw Error('Legal registry originals: ' + message); }
const digest = (bytes: Buffer, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest();
export interface RegistryLegalOriginalView {
  readonly sourceSha: string; readonly name: string; readonly version: string; readonly integrity: string;
  readonly archiveSha256: string; readonly lockSha256: string; readonly metadataSha256: string;
  readonly archiveBytes: number; readonly expandedBytes: number;
  readonly members: readonly CollectedArtifactMember[];
  readArchiveRange(offset: number, length: number): Buffer;
  readMetadata(): Buffer;
  readMember(name: string): Buffer;
  readMemberRange(name: string, offset: number, length: number): Buffer;
}
export const REGISTRY_LEGAL_ORIGINAL_LIMITS = Object.freeze(registryOriginalLimits);
export const VERIFIER_REGISTRY_ORIGINAL_PACKAGES = Object.freeze(['jose', '@inrupt/solid-client-authn-core',
  '@inrupt/solid-client-authn-browser', 'oidc-provider', '@undefineds.co/drizzle-solid', '@solid/community-server'] as const);
const scope = new Set<string>(VERIFIER_REGISTRY_ORIGINAL_PACKAGES);
/** Program-side representation roles share one validator and one issuer.
 * Held build originals use existing module bounds; online legal acquisition
 * retains its original smaller package/group policy without a caller override. */
const ORIGINAL_REPRESENTATIONS=Object.freeze({
  online:Object.freeze({packed:registryOriginalLimits.packagePackedBytes,expanded:registryOriginalLimits.packageExpandedBytes,members:20000}),
  'retained-build':Object.freeze({packed:moduleArtifactLimits.shardBytes,expanded:moduleArtifactLimits.shardBytes,members:moduleArtifactLimits.members}),
});
type OriginalRepresentation=keyof typeof ORIGINAL_REPRESENTATIONS;
/** Bounded gzip byte accounting, not a tar/parser or an original issuer.
 * Concatenated gzip members are counted fully; an ISIZE footer is insufficient. */
export async function measureRegistryArchiveExpansion(archive: Buffer, maximum: number, signal: AbortSignal, check?:()=>void): Promise<number> {
  return measureOriginalExpansion(archive,maximum,signal,'online',check);
}
async function measureOriginalExpansion(archive:Buffer,maximum:number,signal:AbortSignal,role:OriginalRepresentation,check?:()=>void):Promise<number>{
  const bounds=ORIGINAL_REPRESENTATIONS[role];
  if(!Number.isSafeInteger(maximum)||maximum<1||maximum>bounds.expanded||archive.length>bounds.packed||signal.aborted)fail('bounded expansion measurement required');
  const source = Readable.from([archive]), decoder = createGunzip({ chunkSize: 65536 });
  const abort = () => decoder.destroy(Error('Registry expansion deadline'));
  signal.addEventListener('abort', abort, { once: true }); source.on('error', error => decoder.destroy(error)); source.pipe(decoder);
  let bytes = 0;
  try { for await (const chunk of decoder) { check?.(); bytes += chunk.length; if (bytes > maximum || signal.aborted) fail('registry expanded byte budget exceeded'); } return bytes; }
  finally { signal.removeEventListener('abort', abort); source.destroy(); decoder.destroy(); }
}
interface Group { started: number; attempts: number; packed: number; expanded: number; active: boolean; caps: Map<string, object> }
const groups = new WeakMap<object, Group>();
const issued = new WeakMap<object, RegistryLegalOriginalView>();
const archiveModes=new WeakMap<object,ReadonlyMap<string,number>>();
/** Separate original-format observation; legacy member.mode and view JSON are
 * unchanged. Callers receive a copy, never the issuer's retained map. */
export function registryLegalOriginalArchiveModes(value:unknown):ReadonlyMap<string,number>|undefined{
 const modes=value&&typeof value==='object'&&issued.has(value)?archiveModes.get(value):undefined;
 return modes?new Map(modes):undefined;
}
type ServiceSelectedBinding={originals:unknown;source:unknown;coordinateInstances:number;assertCurrent():void;facts:Readonly<{officialSelectedPayloadVerified:true;name:string;version:string;members:number;installedSelection?:'actual-post-pack-runtime'|'pre-pack-selected';unmappedRuntimeFiles?:readonly Readonly<{path:string;reason:string}>[]}>};
const serviceSelected=new WeakMap<object,WeakMap<object,Map<string,ServiceSelectedBinding>>>();
/** Service association is current only while the same genuine selected source
 * remains active. A generic registry cap alone never establishes this axis. */
export function serviceRegistrySelectedInputView(cap:unknown,input:{pack:unknown;originals:unknown;source:unknown;sourceRoot?:string}){
 const instances=cap&&typeof cap==='object'&&input.pack&&typeof input.pack==='object'?serviceSelected.get(cap)?.get(input.pack):undefined;
 const binding=input.sourceRoot===undefined?(instances?.size===1?[...instances.values()][0]:undefined):instances?.get(input.sourceRoot);
 if(!binding||binding.originals!==input.originals||binding.source!==input.source)return undefined;
 binding.assertCurrent();if(input.sourceRoot===undefined&&binding.coordinateInstances!==1)return undefined;return Object.freeze({facts:binding.facts,assertCurrent:binding.assertCurrent});
}
export function registryLegalOriginalView(capability: unknown): RegistryLegalOriginalView | undefined {
  return capability && typeof capability === 'object' ? issued.get(capability) : undefined;
}
export function assertRegistryLegalOriginalCustody(value: unknown): void {
  if (!registryLegalOriginalView(value)) fail('issued registry original capability required');
  // Metadata, tar and member originals are private retained Buffers. Every
  // reader returns copies; no caller or mutable disk path owns these bytes.
}
type ImmutableBunLock = { lockfileVersion?: unknown; packages?: unknown; workspaces?: unknown };
/** Sole immutable lock parse (Bun JSONC trailing commas, never evaluation). */
function parseImmutableBunLock(bytes: Buffer): { lockfileVersion: 1; packages: Record<string, unknown>; workspaces?: Record<string, unknown> } {
  const text = bytes.toString('utf8');
  // Bun lock files contain trailing commas. Remove them only outside strings.
  let clean = '', quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) { clean += char; if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    if (char === ',' && /^\s*[}\]]/u.test(text.slice(i + 1))) continue;
    clean += char;
  }
  const lock = JSON.parse(clean) as ImmutableBunLock;
  if (lock.lockfileVersion !== 1 || !lock.packages || typeof lock.packages !== 'object') fail('unsupported immutable Bun lock');
  return lock as { lockfileVersion: 1; packages: Record<string, unknown>; workspaces?: Record<string, unknown> };
}
const REGISTRY_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const REGISTRY_PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const REGISTRY_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/u;
/** Parse Bun's JSONC data, never evaluate the immutable candidate lock. */
export function registryLegalLockEntries(bytes: Buffer): Map<string, string> {
  const lock = parseImmutableBunLock(bytes), entries = new Map<string, string>();
  for (const row of Object.values(lock.packages)) {
    if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
    const integrity = row[row.length - 1];
    if (typeof integrity !== 'string' || !REGISTRY_INTEGRITY.test(integrity)) continue;
    if (entries.has(row[0]) && entries.get(row[0]) !== integrity) fail('conflicting lock identities');
    entries.set(row[0], integrity);
  }
  return entries;
}
export interface RegistryLegalLockLayoutEntry {
  readonly logicalPath: string; readonly name: string; readonly version: string; readonly integrity: string;
}
function normalizedLockPath(value: string): boolean {
  return value.length > 0 && !value.startsWith('/') && !value.includes('\\') && !/[\u0000-\u001f\u007f]/u.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
/** Declared workspace identities only; the root workspace path "" is a valid
 * container, not a node_modules prefix. */
function lockWorkspacePaths(value: unknown): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  if (value === undefined) return result;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('unsupported immutable Bun lock workspaces');
  for (const [path, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const name = (entry as { name?: unknown }).name;
    if (name === undefined) continue;
    if (typeof name !== 'string' || !REGISTRY_PACKAGE_NAME.test(name)) fail('normalized safe workspace package name required');
    if (path !== '' && !normalizedLockPath(path)) fail('normalized safe workspace path required');
    if (result.has(name)) fail('duplicate workspace identity');
    result.set(name, path);
  }
  return result;
}
/** Declared Bun workspace identities from the same sole lock parse. The root
 * workspace path "" is excluded: it is the container, not an install target. */
export interface RegistryLegalLockWorkspaceEntry { readonly logicalPath: string; readonly name: string }
export function registryLegalLockWorkspaceEntries(bytes: Buffer): readonly RegistryLegalLockWorkspaceEntry[] {
  const lock = parseImmutableBunLock(bytes), workspaces = lockWorkspacePaths(lock.workspaces);
  const rows: RegistryLegalLockWorkspaceEntry[] = [];
  for (const [name, logicalPath] of workspaces) if (logicalPath !== '') rows.push(Object.freeze({ logicalPath, name }));
  rows.sort((left, right) => left.logicalPath < right.logicalPath ? -1 : left.logicalPath > right.logicalPath ? 1 : 0);
  return Object.freeze(rows);
}
/** Split one Bun package key into its package-name chain. Scoped names are
 * pairs; nested names are separated by the same "/" as the scope. */
function lockPackageKeyNames(key: string): readonly string[] {
  const parts = key.split('/'), names: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const name = part.startsWith('@') ? part + '/' + (parts[++index] ?? '') : part;
    if (name === 'node_modules' || !REGISTRY_PACKAGE_NAME.test(name)) fail('normalized safe registry package key required');
    names.push(name);
  }
  return names;
}
function lockLayoutPath(names: readonly string[], workspaces: ReadonlyMap<string, string>): string {
  let base: string | undefined;
  for (let index = 0; index < names.length - 1; index++) {
    const name = names[index]!, workspace = index === 0 ? workspaces.get(name) : undefined;
    if (workspace !== undefined) base = workspace;
    else if (base === undefined || base === '') base = 'node_modules/' + name;
    else base = base + '/node_modules/' + name;
  }
  const suffix = 'node_modules/' + names[names.length - 1]!;
  const logicalPath = base === undefined || base === '' ? suffix : base + '/' + suffix;
  if (!normalizedLockPath(logicalPath)) fail('normalized safe registry layout path required');
  return logicalPath;
}
function lockCoordinate(value: string): { name: string; version: string } | undefined {
  const at = value.lastIndexOf('@');
  if (at <= 0) fail('exact registry lock coordinate required');
  const name = value.slice(0, at), version = value.slice(at + 1);
  // workspace:/github: rows are not registry packages even when Bun records a
  // sha512 integrity for them; layout data never treats them as a version.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(version)) return undefined;
  if (!REGISTRY_PACKAGE_NAME.test(name) || !REGISTRY_PACKAGE_VERSION.test(version)) fail('exact registry lock coordinate required');
  return { name, version };
}
/** Deterministic layout of registry packages with sha512 lock SRI. The key is
 * the declared install identity and may alias a distinct canonical row
 * coordinate (for example string-width-cjs -> string-width@4.2.3); the alias is
 * preserved only in logicalPath while name/version/SRI stay canonical. This is
 * data for staging assembly, not build-completeness proof. */
export function registryLegalLockLayoutEntries(bytes: Buffer): readonly RegistryLegalLockLayoutEntry[] {
  const lock = parseImmutableBunLock(bytes), workspaces = lockWorkspacePaths(lock.workspaces);
  const rows: RegistryLegalLockLayoutEntry[] = [], paths = new Set<string>(), coordinates = new Map<string, string>();
  for (const [key, value] of Object.entries(lock.packages)) {
    if (!Array.isArray(value) || typeof value[0] !== 'string') continue;
    const integrity = value[value.length - 1];
    if (typeof integrity !== 'string' || !REGISTRY_INTEGRITY.test(integrity)) continue;
    const coordinate = lockCoordinate(value[0]);
    if (!coordinate) continue;
    const names = lockPackageKeyNames(key);
    const finalName = names[names.length - 1]!;
    if (names.length === 1 && workspaces.has(finalName)) fail('workspace identity cannot carry registry SRI');
    const logicalPath = lockLayoutPath(names, workspaces);
    if (paths.has(logicalPath)) fail('duplicate registry layout logical path');
    const prior = coordinates.get(value[0]);
    if (prior !== undefined && prior !== integrity) fail('conflicting lock identities');
    paths.add(logicalPath); coordinates.set(value[0], integrity);
    rows.push(Object.freeze({ logicalPath, name: coordinate.name, version: coordinate.version, integrity }));
  }
  return Object.freeze(rows);
}
/** Pure original-format validation. Returning these bytes never issues the
 * operational registry capability; only the fixed transport below can do so. */
export function inspectRegistryLegalArchive(identity: { name: string; version: string; integrity: string }, metadataBytes: Buffer, archive: Buffer, maximumExpanded = 32 * 1024 ** 2): { entries: any[]; manifest: any } {
  return inspectOriginalArchive(identity,metadataBytes,archive,maximumExpanded,'online');
}
function inspectOriginalArchive(identity:{name:string;version:string;integrity:string},metadataBytes:Buffer,archive:Buffer,maximumExpanded:number,role:OriginalRepresentation):{entries:any[];manifest:any}{
  const bounds=ORIGINAL_REPRESENTATIONS[role];
  if(archive.length>bounds.packed||metadataBytes.length>registryOriginalLimits.metadataBytes||!Number.isSafeInteger(maximumExpanded)||maximumExpanded<1||maximumExpanded>bounds.expanded)fail('original parser byte budget exceeded');
  const metadata = JSON.parse(metadataBytes.toString());
  if (metadata.name !== identity.name || metadata.version !== identity.version || metadata.dist?.integrity !== identity.integrity) fail('original metadata identity differs');
  if ('sha512-' + digest(archive, 'sha512').toString('base64') !== identity.integrity) fail('original archive SRI differs');
  const inspected = inspectTarballBuffer(archive, { expandedBytes: maximumExpanded, members: bounds.members, gnuLongNames: true });
  if (inspected.manifest.name !== identity.name || inspected.manifest.version !== identity.version) fail('original archive identity differs');
  for (const row of inspected.entries) if (!row.path.startsWith('package/')) fail('registry original outside package');
  return inspected;
}
/** Fixed official-registry GET only. Coordinates must be present in both the
 * actual collected package and its immutable Git lock. No callback can issue
 * this capability. Per request budgets keep all archives small and bounded. */
export async function observeRegistryLegalOriginal(input: { artifact: unknown; source: unknown; name: string; version: string }): Promise<object> {
  const artifact = collectedArtifactView(input.artifact), source = derivedSourceView(input.source);
  if (!artifact || !source || source.sourceSha !== artifact.identity.sourceSha) fail('bound collected archive and immutable Git required');
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(input.name)
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(input.version)) fail('exact registry identity required');
  let found = false;
  for (const member of artifact.members.filter(row => /(?:^|\/)package\.json$/u.test(row.path))) {
    if (member.bytes > 64 * 1024) continue;
    const manifest = JSON.parse(artifact.readMember(member.path, 64 * 1024).toString());
    if (manifest.name === input.name && manifest.version === input.version) { found = true; break; }
  }
  if (!found) {
    for (const member of artifact.members.filter(row => /(?:^|\/)licenses\/index\.json$/u.test(row.path)).slice(0, 64)) {
      const index = JSON.parse(artifact.readMember(member.path, 1024 * 1024).toString());
      if (index.packages?.some((row: any) => row.name === input.name && row.version === input.version)) found = true;
    }
  }
  if (!found || !source.trackedPaths.includes('bun.lock')) fail('actual package and immutable lock identity required');
  return acquireRegistryOriginal(input.artifact as object, source, input.name, input.version);
}
/** Fixed patched-verifier upstream scope only. This authenticates official
 * tar bytes under immutable Git lock SRI, never the installed/patched snapshot
 * or a tool grant. Source's mechanical reader must compare that actual input. */
export async function observeVerifierRegistryOriginal(input: { source: unknown; name: string; version: string }): Promise<object> {
  if (!scope.has(input.name)) fail('package is outside fixed six-package verifier scope');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(input.version)) fail('exact verifier registry version required');
  const source = derivedSourceView(input.source);
  if (!source) fail('private immutable Git source required for verifier originals');
  return acquireRegistryOriginal(input.source as object, source, input.name, input.version);
}
export interface ServiceRegistryAcquisitionBudget {
  check():void;remainingMs():number;
  /** Parent accounting only, never an identity or capability assertion. The
   * complete ceiling remains consumed on failure; no partial-absence refund. */
  reserveBytes(bytes:number):void;
  /** Optional existing-parent token pair. The issuer never invents a ledger. */
  reserveOriginalMaximum?(maximum:number):object;
  settleOriginalReservation?(token:object,actual:number,unusedOriginalsAbsent:boolean):void;
}
async function serviceRegistryOriginalGuard(input:{originals:unknown;source:unknown;budget:ServiceRegistryAcquisitionBudget},native:NonNullable<ReturnType<typeof import('./native-original-collector').nativeOriginalsView>>,source:DerivedSourceView,runtime=false){
  const {assertCollectedNativeOriginalCustody,nativeOriginalsView}=await import('./native-original-collector');
  const {assertDerivedSourceCurrent}=await import('./source-context');
  const {readFileSync}=await import('node:fs');
  const files=[['scripts/lib/independent-admission/legal-registry-originals.ts',new URL(import.meta.url)],['scripts/lib/registry-legal-original-limits.json',new URL('../registry-legal-original-limits.json',import.meta.url)]] as const;
  const runtimeFiles=[['scripts/lib/independent-admission/candidate-service-installed-source.ts',new URL('./candidate-service-installed-source.ts',import.meta.url)],['scripts/lib/independent-admission/candidate-service-runtime-artifact.ts',new URL('./candidate-service-runtime-artifact.ts',import.meta.url)]] as const;
  const master=native.members.find(row=>row.path==='service-image-materials.json');if(!master)fail('same retained service master required');
  return ()=>{
    input.budget.check();if(input.budget.remainingMs()<=0)fail('service parent deadline exhausted');
    assertCollectedNativeOriginalCustody(input.originals);assertDerivedSourceCurrent(input.source);
    if(nativeOriginalsView(input.originals)!==native||derivedSourceView(input.source)!==source)fail('private service inputs changed');
    native.readOriginalRange(master.path,0,0);
    for(const [path,url] of files)if(!source.trackedPaths.includes(path)||!source.readTracked(path).equals(readFileSync(url)))fail('immutable registry issuer executable closure differs');
    if(runtime)for(const [path,url] of runtimeFiles)if(!source.trackedPaths.includes(path)||!source.readTracked(path).equals(readFileSync(url)))fail('immutable actual runtime installed issuer executable closure differs');
  };
}
function serviceRegistryTransportBudget(input:{budget:ServiceRegistryAcquisitionBudget},check:()=>void){
  if(Boolean(input.budget.reserveOriginalMaximum)!==Boolean(input.budget.settleOriginalReservation))fail('complete existing-parent reservation token pair required');
  return {check,remainingMs:()=>input.budget.remainingMs(),reserveBytes(count:number){check();input.budget.reserveBytes(count);check();},reservationOwner:input.budget as object,...(input.budget.reserveOriginalMaximum?{reserveOriginalMaximum:(maximum:number)=>input.budget.reserveOriginalMaximum!(maximum),settleOriginalReservation:(token:object,actual:number,absent:boolean)=>input.budget.settleOriginalReservation!(token,actual,absent)}:{})};
}
interface ServiceOriginalReservation {owner:object;token:object;actual:number;settled:boolean;settle(token:object,actual:number,unusedOriginalsAbsent:boolean):void}
const serviceOriginalReservations=new WeakMap<object,ServiceOriginalReservation>();

/** Service original admission shares the existing sole registry issuer. The
 * selected witness is looked up from the actual private pack observation, never
 * supplied as JSON. An original cap alone is not installed/source coverage. */
export function canonicalServiceRegistryTarball(name:string,version:string):string {
  if(!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name)||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version))fail('exact service registry identity required');
  return 'https://registry.npmjs.org/'+name+'/-/'+name.split('/').pop()+'-'+version+'.tgz';
}
type CandidateServiceRegistryInput={originals:unknown;source:unknown;pack:unknown;name:string;version:string;sourceRoot?:string;budget:ServiceRegistryAcquisitionBudget;/** Same actual runtime cap and its separately issued installed inventory. */runtime?:unknown;installed?:unknown};
export async function observeCandidateServiceRegistryOriginal(input:CandidateServiceRegistryInput):Promise<object>{return observeServiceInstalledOriginal(input,false);}
/** Same sole issuer, with the immutable reviewed installer transform replay. */
export async function observeCandidateServiceInstalledOriginal(input:CandidateServiceRegistryInput):Promise<object>{return observeServiceInstalledOriginal(input,true);}
async function observeServiceInstalledOriginal(input:CandidateServiceRegistryInput,projectInstalled:boolean):Promise<object>{
  const {nativeOriginalsView,assertCollectedNativeOriginalCustody}=await import('./native-original-collector');
  const {assertDerivedSourceCurrent}=await import('./source-context');
  const native=nativeOriginalsView(input.originals),source=derivedSourceView(input.source);
  if(!native||!source||native.originFacts.sourceSha!==source.sourceSha)fail('same private service/source originals required');
  if(!source.trackedPaths.includes('scripts/lib/independent-admission/candidate-service-pack-output.ts'))fail('current immutable private pack reader required');
  const {candidateServicePackSelectedInputView}=await import('./candidate-service-pack-output');
  if(input.runtime!==undefined&&!projectInstalled)fail('actual runtime installed selection requires the reviewed installed issuer');
  const installed=input.runtime!==undefined?await import('./candidate-service-installed-source'):undefined;
  const runtime=installed?.candidateServiceInstalledSourceView(input.installed,input.originals,input.source,input.runtime);
  if(input.runtime!==undefined&&!runtime)fail('same issued actual post-pack runtime installed source required');
  const selected=runtime?undefined:candidateServicePackSelectedInputView(input.pack,input.originals,input.source);
  if(!runtime&&!selected)fail('actual private completed selected source required');
  const {readFileSync}=await import('node:fs');
  const check=await serviceRegistryOriginalGuard(input,native,source,Boolean(runtime));
  check();canonicalServiceRegistryTarball(input.name,input.version);
  const runtimePackages=runtime?.packages.filter(row=>row.name===input.name&&row.version===input.version&&(input.sourceRoot===undefined||row.sourceRoot===input.sourceRoot));
  if(runtimePackages&&runtimePackages.length!==1)fail('actual installed package selection is missing or ambiguous');
  const runtimePackage=runtimePackages?.[0];
  if(runtime&&!runtimePackage)fail('actual post-pack runtime installed package missing or ambiguous');
  const before=runtimePackage?undefined:selected!.read(input.name,input.version,input.sourceRoot);if(before&&before.inputKind!=='installed')fail('workspace inputs require immutable workspace build source, not registry identity');
  const transportBudget=serviceRegistryTransportBudget(input,check);
  const cap=await acquireRegistryOriginal(input.originals as object,source,input.name,input.version,transportBudget);
  check();
  let installedSourceRoot:string,installedMembers:number,installedLogicalPaths:readonly string[],installedMissing:readonly {path:string;reason:string}[]=[],actualWitness:()=>void;
  if(!runtimePackage){
    const after=selected!.read(input.name,input.version,input.sourceRoot);if(after!==before)fail('selected source witness changed');
    const original=registryLegalOriginalView(cap),modes=archiveModes.get(cap);
    if(!original||!modes)fail('sole registry issuer did not retain original');
    let projected:ReturnType<typeof import('./afs-verifier-patch-originals').projectReviewedInstalledPackage>|undefined;
    if(projectInstalled){
      const relative='scripts/lib/independent-admission/afs-verifier-patch-originals.ts',url=new URL('./afs-verifier-patch-originals.ts',import.meta.url);
      if(!source.trackedPaths.includes(relative)||!source.readTracked(relative).equals(readFileSync(url)))fail('immutable installed projection reader differs');
      const projection=await import('./afs-verifier-patch-originals');check();
      projected=projection.projectReviewedInstalledPackage({source:input.source,original:cap,logicalPaths:after.logicalPaths??[]});
    }
    for(const member of after.members){
      check();if(member.type!=='file'||!member.path.startsWith('package/'))fail('actual selected file required');
      const relative=member.path.slice(8),row=projected?.members.get(relative)??original.members.find(row=>row.path===relative);
      if(!row||row.bytes!==member.bytes||row.sha256!==member.sha256||modes.get(relative)!==member.mode)fail('selected source differs from official original bytes or mode; transform proof required');
    }
    if(!after.members.length||!after.members.some(row=>row.path==='package/package.json'))fail('selected manifest source closure required');
    installedSourceRoot=after.sourceRoot;installedMembers=after.members.length;installedLogicalPaths=after.logicalPaths??[];
    actualWitness=()=>{if(selected!.read(input.name,input.version,input.sourceRoot)!==after)fail('private selected source witness changed');};
  }else{
    // Actual post-pack installed selection: same sole registry issuer cap, the
    // reviewed installer projection and the complete actual runtime file set.
    const view=installed!.candidateServiceInstalledSourceView(input.installed,input.originals,input.source,input.runtime);
    const pkg=view?.packages.find(row=>row.name===input.name&&row.version===input.version&&row.sourceRoot===runtimePackage.sourceRoot);
    if(!view||!pkg)fail('actual post-pack runtime installed package changed');
    const original=registryLegalOriginalView(cap),modes=archiveModes.get(cap);
    if(!original||!modes)fail('sole registry issuer did not retain original');
    if(!source.trackedPaths.includes('scripts/lib/independent-admission/afs-verifier-patch-originals.ts')||!source.readTracked('scripts/lib/independent-admission/afs-verifier-patch-originals.ts').equals(readFileSync(new URL('./afs-verifier-patch-originals.ts',import.meta.url))))fail('immutable installed projection reader differs');
    const projection=await import('./afs-verifier-patch-originals');check();
    const projected=projection.projectReviewedInstalledPackage({source:input.source,original:cap,logicalPaths:[pkg.logicalPath]});
    if(!projected.members.has('package.json'))fail('projected installed manifest required');
    const compared=installed!.compareCandidateServiceInstalledPackage({pkg,expected:projected.members,modes});
    if(compared.missing.length)fail('actual installed files have no verified official projection');
    check();
    installedSourceRoot=pkg.sourceRoot;installedMembers=pkg.members.length;installedLogicalPaths=Object.freeze([pkg.logicalPath]);installedMissing=compared.missing;
    actualWitness=()=>{
      const current=installed!.candidateServiceInstalledSourceView(input.installed,input.originals,input.source,input.runtime)?.packages.find(row=>row.name===input.name&&row.version===input.version&&row.sourceRoot===pkg.sourceRoot);
      if(!current||current.manifest.sha256!==pkg.manifest.sha256||current.members.length!==pkg.members.length||current.members.some((row,index)=>row.absolutePath!==pkg.members[index]!.absolutePath||row.sha256!==pkg.members[index]!.sha256||row.bytes!==pkg.members[index]!.bytes||row.mode!==pkg.members[index]!.mode))fail('actual post-pack installed package changed');
    };
  }
  check();const bindings=serviceSelected.get(cap)??new WeakMap();serviceSelected.set(cap,bindings);
  const selectionOwner=(runtimePackage?input.runtime:input.pack) as object;const instances=bindings.get(selectionOwner)??new Map<string,ServiceSelectedBinding>();bindings.set(selectionOwner,instances);const prior=instances.get(installedSourceRoot);if(prior)prior.assertCurrent();
  const reservation=serviceOriginalReservations.get(cap);if(reservation&&!reservation.settled){if(reservation.owner!==input.budget)fail('same existing parent reservation owner required');check();reservation.settle(reservation.token,reservation.actual,true);reservation.settled=true;}
  const facts=Object.freeze({officialSelectedPayloadVerified:true as const,name:input.name,version:input.version,members:installedMembers,installedSelection:runtimePackage?'actual-post-pack-runtime':'pre-pack-selected',unmappedRuntimeFiles:Object.freeze([...installedMissing])});
  const coordinateInstances=runtimePackage?runtime!.packages.filter(row=>row.name===input.name&&row.version===input.version).length:selected!.list().filter(row=>row.name===input.name&&row.version===input.version).length;
  instances.set(installedSourceRoot,Object.freeze({coordinateInstances,originals:input.originals,source:input.source,facts,assertCurrent(){check();actualWitness();}}));
  return cap;
}
type CandidateServiceBuildDependencyOriginalInput={originals:unknown;source:unknown;name:string;version:string;budget:ServiceRegistryAcquisitionBudget};
/** Compiler/build dependency originals are not selected installed runtime
 * packages. This shares the same sole registry issuer, executable closure and
 * parent reservation/settlement token contract. It records no used-in-build,
 * transform or source axis; the final transform replay must prove actual use. */
export async function observeCandidateServiceBuildDependencyOriginal(input:CandidateServiceBuildDependencyOriginalInput):Promise<object>{
  const {nativeOriginalsView,assertCollectedNativeOriginalCustody}=await import('./native-original-collector');
  const {assertDerivedSourceCurrent}=await import('./source-context');
  const {isCandidateServiceImageGitHubOrigin}=await import('./github-origin');
  const native=nativeOriginalsView(input.originals),source=derivedSourceView(input.source);
  if(!native||!source||native.originFacts.sourceSha!==source.sourceSha)fail('same private service/source originals required');
  if(!isCandidateServiceImageGitHubOrigin(native.origin))fail('actual candidate service origin required');
  canonicalServiceRegistryTarball(input.name,input.version);
  const check=await serviceRegistryOriginalGuard(input,native,source,false);
  check();
  const transportBudget=serviceRegistryTransportBudget(input,check);
  const cap=await acquireRegistryOriginal(input.originals as object,source,input.name,input.version,transportBudget);
  check();if(!registryLegalOriginalView(cap)||!archiveModes.get(cap))fail('sole registry issuer did not retain original');
  const reservation=serviceOriginalReservations.get(cap);if(reservation&&!reservation.settled){if(reservation.owner!==input.budget)fail('same existing parent reservation owner required');check();reservation.settle(reservation.token,reservation.actual,true);reservation.settled=true;}
  return cap;
}
type RetainedBuildInput={originals:unknown;source:unknown;name:string;version:string;budget:ServiceRegistryAcquisitionBudget};
type RetainedBuildGroup={source:unknown;budget:ServiceRegistryAcquisitionBudget;active:boolean;attempts:number;packed:number;expanded:number;caps:Map<string,object>};
const retainedBuildGroups=new WeakMap<object,RetainedBuildGroup>();
/** Program-declared held build-input role, using the same official-original
 * issuer. No HTTP or online-owner reset occurs here. Closed receipt bytes are
 * evidence only: immutable lock SRI and actual archive/manifest prove identity.
 * The fixed retained-build representation uses existing module shard bounds.
 * This proves an input original, never actual build use or whole source closure. */
export async function observeCandidateServiceRetainedBuildDependencyOriginal(input:RetainedBuildInput):Promise<object>{
  const {nativeOriginalsView}=await import('./native-original-collector');
  const {isCandidateServiceImageGitHubOrigin}=await import('./github-origin');
  const native=nativeOriginalsView(input.originals),source=derivedSourceView(input.source);
  if(!native||!source||native.originFacts.sourceSha!==source.sourceSha)fail('same private service/source originals required');
  if(!isCandidateServiceImageGitHubOrigin(native.origin))fail('actual candidate service origin required');
  const url=canonicalServiceRegistryTarball(input.name,input.version),baseCheck=await serviceRegistryOriginalGuard(input,native,source,false);
  const {readFileSync}=await import('node:fs');
  const check=()=>{baseCheck();const name='scripts/lib/module-artifact-limits.json';if(!source.trackedPaths.includes(name)||!source.readTracked(name).equals(readFileSync(new URL('../module-artifact-limits.json',import.meta.url))))fail('immutable retained build limits differ');};
  check();const lockBytes=source.readTracked('bun.lock'),key=input.name+'@'+input.version,integrity=registryLegalLockEntries(lockBytes).get(key);
  if(!integrity)fail('immutable registry SRI missing');
  const group=retainedBuildGroups.get(input.originals as object)??{source:input.source,budget:input.budget,active:false,attempts:0,packed:0,expanded:0,caps:new Map<string,object>()};
  if(group.source!==input.source||group.budget!==input.budget)fail('same retained source and parent budget required');
  retainedBuildGroups.set(input.originals as object,group);
  const existing=group.caps.get(key);if(existing){check();return existing;}
  if(group.active||group.attempts>=moduleArtifactLimits.sourceMaterialFiles)fail('retained input count or concurrent acquisition bound');
  group.attempts++;group.active=true;
  try{
    const prefix='build-inputs/registry/'+Buffer.from(integrity.slice(7),'base64').toString('hex')+'/';
    const policy=REGISTRY_LEGAL_ORIGINAL_LIMITS,bounds=ORIGINAL_REPRESENTATIONS['retained-build'];
    const member=(name:string,maximum:number)=>{const rows=native.members.filter(row=>row.path===prefix+name);if(rows.length!==1||!Number.isSafeInteger(rows[0]!.bytes)||rows[0]!.bytes<1||rows[0]!.bytes>maximum)fail('bounded genuine retained input absent: '+name);return rows[0]!;};
    const archiveRow=member('archive.tgz',bounds.packed),metadataRow=member('metadata.json',policy.metadataBytes),receiptRow=member('transport.json',policy.metadataBytes);
    if(group.packed+archiveRow.bytes>moduleArtifactLimits.dependencyBytes)fail('existing dependency byte bound');
    // Reserve copies before allocation. Expanded parser/member representations
    // are reserved after a streaming count and before the full parser runs.
    input.budget.reserveBytes(2*(archiveRow.bytes+metadataRow.bytes+receiptRow.bytes));check();
    const read=(row:typeof archiveRow)=>{check();const result=Buffer.alloc(row.bytes);for(let at=0;at<row.bytes;at+=moduleArtifactLimits.rangeBytes){input.budget.check();const n=Math.min(moduleArtifactLimits.rangeBytes,row.bytes-at),bytes=native.readOriginalRange(row.path,at,n);if(bytes.length!==n)fail('complete retained input range required');result.set(bytes,at);input.budget.check();}if(digest(result).toString('hex')!==row.sha256)fail('actual retained member SHA differs');check();return result;};
    const archive=read(archiveRow),metadataBytes=read(metadataRow),receiptBytes=read(receiptRow),receipt=JSON.parse(receiptBytes.toString('utf8'));
    if(receipt.schemaVersion!==1||receipt.kind!=='registry-build-input-transport'||receipt.sourceSha!==source.sourceSha||receipt.url!==url||receipt.status!==200||receipt.completed!==true||receipt.bytes!==archive.length||receipt.sha256!==digest(archive).toString('hex'))fail('actual closed retained transport binding differs');
    const metadata=JSON.parse(metadataBytes.toString('utf8'));
    if(metadata.dist?.tarball!==url||metadata.name!==input.name||metadata.version!==input.version||metadata.dist?.integrity!==integrity||'sha512-'+digest(archive,'sha512').toString('base64')!==integrity)fail('immutable official input identity differs');
    const remaining=input.budget.remainingMs();if(!Number.isFinite(remaining)||remaining<=0)fail('shared retained input deadline exhausted');
    const expandedBytes=await measureOriginalExpansion(archive,bounds.expanded,AbortSignal.timeout(Math.max(1,Math.floor(remaining))),'retained-build',()=>input.budget.check());check();
    if(group.expanded+expandedBytes>moduleArtifactLimits.dependencyBytes||group.expanded+group.packed+expandedBytes+archive.length>moduleArtifactLimits.sourceMaterialBytes)fail('existing aggregate source input bound');
    input.budget.reserveBytes(2*expandedBytes);check();
    const inspected=inspectOriginalArchive({name:input.name,version:input.version,integrity},metadataBytes,archive,bounds.expanded,'retained-build');check();
    const cap=issueRegistryOriginal({source,name:input.name,version:input.version,integrity,lockBytes,metadataBytes,archive,expandedBytes,inspected});check();
    group.packed+=archive.length;group.expanded+=expandedBytes;group.caps.set(key,cap);return cap;
  }finally{group.active=false;}
}

async function acquireRegistryOriginal(owner: object, source: DerivedSourceView, name: string, version: string, parent?:(ServiceRegistryAcquisitionBudget&{reservationOwner?:object})): Promise<object> {
  if (!source.trackedPaths.includes('bun.lock')) fail('immutable Bun lock required');
  const lockBytes = source.readTracked('bun.lock');
  const integrity = registryLegalLockEntries(lockBytes).get(name + '@' + version);
  if (!integrity) fail('immutable registry SRI missing');
  const policy = REGISTRY_LEGAL_ORIGINAL_LIMITS;
  const group = groups.get(owner) ?? { started: Date.now(), attempts: 0, packed: 0, expanded: 0, active: false, caps: new Map<string, object>() };
  groups.set(owner, group);
  const checkParent=()=>{if(parent){parent.check();if(!Number.isFinite(parent.remainingMs())||parent.remainingMs()<=0)fail('inherited service acquisition deadline exhausted');}};checkParent();
  const key = name + '@' + version;
  const existing = group.caps.get(key); if (existing) return existing;
  if (group.active || group.attempts >= policy.groupAttempts || group.packed >= policy.groupPackedBytes || group.expanded >= policy.groupExpandedBytes || Date.now() - group.started >= policy.groupTimeoutMs) fail('artifact group budget exhausted or acquisition already active; original admission pending');
  group.attempts++; group.active = true;
  try {
  checkParent();
  // Two packed representations (stream chunks/concatenation), two expanded
  // parser/member representations, and metadata are all reserved before HTTP.
  // This is debited against the caller's existing parent, not new allowance.
  const maximum=2*policy.metadataBytes+2*policy.packagePackedBytes+2*policy.packageExpandedBytes;
  const token=parent?.reserveOriginalMaximum?.(maximum);
  if(parent?.reserveOriginalMaximum&&(!token||typeof token!=='object'))fail('actual existing parent reservation token required');
  if(parent&&!parent.reserveOriginalMaximum)parent.reserveBytes(maximum);
  const signal = AbortSignal.timeout(Math.max(1,Math.floor(Math.min(policy.requestTimeoutMs, policy.groupTimeoutMs - (Date.now() - group.started),parent?parent.remainingMs():Infinity))));
  const read = async (url: string, maximum: number, packed = false): Promise<Buffer> => {
    checkParent();const parsed = new URL(url);
    if (parsed.origin !== 'https://registry.npmjs.org' || parsed.username || parsed.password || parsed.hash) fail('noncanonical registry origin');
    let response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,primary:unknown;
    const chunks:Buffer[]=[];let size=0,hadPrimary=false;
    try {
      response=await fetch(url,{redirect:'error',signal});checkParent();
      if(response.body)reader=response.body.getReader();
      if(response.status!==200||!reader){
        // Only the new service contract retains a bounded error-body prefix.
        // Historical acquisition keeps its original HTTP rejection behavior.
        if(parent&&reader){for(;;){checkParent();const next=await reader.read();checkParent();if(next.done)break;const remaining=Math.min(maximum,65536)-size;if(remaining<=0)break;const block=Buffer.from(next.value.subarray(0,remaining));chunks.push(block);size+=block.length;if(size>=Math.min(maximum,65536))break;}}
        fail('registry HTTP status '+response.status);
      }
      for(;;){
        checkParent();const next=await reader.read();checkParent();if(next.done)break;
        if(packed)group.packed+=next.value.length;
        if(size+next.value.length>maximum||group.packed>policy.groupPackedBytes)fail('registry byte budget exceeded; original admission pending');
        chunks.push(Buffer.from(next.value));size+=next.value.length;
      }
      return Buffer.concat(chunks,size);
    }catch(error){
      primary=error;hadPrimary=true;
      if(parent&&error&&typeof error==='object'){
        // Diagnostic bytes never issue an original cap. Keep the complete
        // ceiling charged and the original exception object on every failure.
        try{const headers:string[][]=[];let headerBytes=0;if(response)for(const [name,value] of response.headers){headerBytes+=Buffer.byteLength(name)+Buffer.byteLength(value);if(headerBytes>policy.metadataBytes)break;headers.push([name,value]);}Object.defineProperty(error,'serviceRegistryOriginalFailure',{value:Object.freeze({schemaVersion:1,kind:'failed-service-registry-original-request',url,status:response?.status??null,headers:Object.freeze(headers.map(row=>Object.freeze(row))),headersRepresentation:'fetch parsed headers',retainedPrefix:Buffer.concat(chunks,size),prefixBytes:size,completeBody:false,capabilityIssued:false}),enumerable:false});}catch{/* Diagnostic allocation/cleanup cannot replace the original rejection. */}
      }
      throw error;
    }finally{
      try{if(reader)await reader.cancel();}catch(error){if(!hadPrimary)throw error;}
      try{checkParent();}catch(error){if(!hadPrimary)throw error;}
    }
  };
  const metadataBytes = await read('https://registry.npmjs.org/' + encodeURIComponent(name) + '/' + encodeURIComponent(version), policy.metadataBytes);
  checkParent();const metadata = JSON.parse(metadataBytes.toString());
  if (metadata.name !== name || metadata.version !== version || metadata.dist?.integrity !== integrity) fail('registry metadata conflicts with immutable lock');
  if(parent&&metadata.dist.tarball!==canonicalServiceRegistryTarball(name,version))fail('fixed canonical service registry tarball required');
  const archive = await read(metadata.dist.tarball, Math.min(policy.packagePackedBytes, policy.groupPackedBytes - group.packed), true);
  const expansionBudget = Math.min(policy.packageExpandedBytes, policy.groupExpandedBytes - group.expanded);
  // Reserve the full expansion ceiling even on malformed gzip/parser failure.
  group.expanded += expansionBudget;
  const inspected = inspectRegistryLegalArchive({ name: name, version: version, integrity }, metadataBytes, archive, expansionBudget);
  const expandedBytes = await measureRegistryArchiveExpansion(archive, expansionBudget, signal);
  // Keep full reservation on parser/measurement failure. Successful originals
  // debit their actual complete tar expansion, retaining all hard group bounds.
  group.expanded -= expansionBudget - expandedBytes;

  checkParent();const cap = issueRegistryOriginal({ source, name, version, integrity, lockBytes, metadataBytes, archive, expandedBytes, inspected });
  if(token){if(!parent?.settleOriginalReservation||!parent.reservationOwner)fail('same existing parent token owner required');const actual=2*metadataBytes.length+2*archive.length+2*expandedBytes;if(!Number.isSafeInteger(actual)||actual<=0||actual>maximum)fail('actual complete original representation byte settlement bound');serviceOriginalReservations.set(cap,{owner:parent.reservationOwner,token,actual,settled:false,settle:parent.settleOriginalReservation});}
  group.caps.set(key, cap); return cap;
  } finally { group.active = false; }
}
/** Sole issuance tail for one already-validated original. Keeps the legacy
 * member JSON shape, 0644 view modes, archive-format modes and copied readers. */
function issueRegistryOriginal(input:{source:DerivedSourceView;name:string;version:string;integrity:string;lockBytes:Buffer;metadataBytes:Buffer;archive:Buffer;expandedBytes:number;inspected:{entries:any[]}}):object{
  const {source,name,version,integrity,lockBytes,metadataBytes,archive,expandedBytes,inspected}=input;
  const originals = new Map<string, Buffer>(),actualModes=new Map<string,number>();
  for (const row of inspected.entries) if (row.type === 'file') {
    if (!row.path.startsWith('package/')) fail('registry original outside package');
    originals.set(row.path.slice(8), Buffer.from(row.content));actualModes.set(row.path.slice(8),row.mode);
  }
  const members = Object.freeze([...originals].map(([name, bytes]) => Object.freeze({ path: name, bytes: bytes.length, sha256: digest(bytes).toString('hex'), mode: 0o644 })));
  const cap = Object.freeze({});
  issued.set(cap, Object.freeze({ sourceSha: source.sourceSha, name: name, version: version, integrity, members, archiveSha256: digest(archive).toString('hex'), lockSha256: digest(lockBytes).toString('hex'), metadataSha256: digest(metadataBytes).toString('hex'), archiveBytes: archive.length, expandedBytes,
    readMetadata() { return Buffer.from(metadataBytes); },
    readArchiveRange(offset: number, length: number) { if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > 65536 || offset + length > archive.length) return fail('bounded original archive range required'); return Buffer.from(archive.subarray(offset, offset + length)); },
    readMemberRange(name: string, offset: number, length: number) { const bytes = originals.get(name); if (!bytes || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > 65536 || offset + length > bytes.length) return fail('bounded original member range required'); return Buffer.from(bytes.subarray(offset, offset + length)); },
    readMember(name: string) { const bytes = originals.get(name); if (!bytes) return fail('original member absent'); return Buffer.from(bytes); } }));
  archiveModes.set(cap,new Map(actualModes));return cap;
}
