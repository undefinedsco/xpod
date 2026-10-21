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
/** Bounded gzip byte accounting, not a tar/parser or an original issuer.
 * Concatenated gzip members are counted fully; an ISIZE footer is insufficient. */
export async function measureRegistryArchiveExpansion(archive: Buffer, maximum: number, signal: AbortSignal): Promise<number> {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > REGISTRY_LEGAL_ORIGINAL_LIMITS.packageExpandedBytes
    || archive.length > REGISTRY_LEGAL_ORIGINAL_LIMITS.packagePackedBytes || signal.aborted) fail('bounded expansion measurement required');
  const source = Readable.from([archive]), decoder = createGunzip({ chunkSize: 65536 });
  const abort = () => decoder.destroy(Error('Registry expansion deadline'));
  signal.addEventListener('abort', abort, { once: true }); source.on('error', error => decoder.destroy(error)); source.pipe(decoder);
  let bytes = 0;
  try { for await (const chunk of decoder) { bytes += chunk.length; if (bytes > maximum || signal.aborted) fail('registry expanded byte budget exceeded'); } return bytes; }
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
const serviceSelected=new WeakMap<object,WeakMap<object,{originals:unknown;source:unknown;assertCurrent():void;facts:Readonly<{officialSelectedPayloadVerified:true;name:string;version:string;members:number}>}>>();
/** Service association is current only while the same genuine selected source
 * remains active. A generic registry cap alone never establishes this axis. */
export function serviceRegistrySelectedInputView(cap:unknown,input:{pack:unknown;originals:unknown;source:unknown}){
 const binding=cap&&typeof cap==='object'&&input.pack&&typeof input.pack==='object'?serviceSelected.get(cap)?.get(input.pack):undefined;
 if(!binding||binding.originals!==input.originals||binding.source!==input.source)return undefined;
 binding.assertCurrent();return Object.freeze({facts:binding.facts,assertCurrent:binding.assertCurrent});
}
export function registryLegalOriginalView(capability: unknown): RegistryLegalOriginalView | undefined {
  return capability && typeof capability === 'object' ? issued.get(capability) : undefined;
}
export function assertRegistryLegalOriginalCustody(value: unknown): void {
  if (!registryLegalOriginalView(value)) fail('issued registry original capability required');
  // Metadata, tar and member originals are private retained Buffers. Every
  // reader returns copies; no caller or mutable disk path owns these bytes.
}
/** Parse Bun's JSONC data, never evaluate the immutable candidate lock. */
export function registryLegalLockEntries(bytes: Buffer): Map<string, string> {
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
  const lock = JSON.parse(clean), entries = new Map<string, string>();
  if (lock.lockfileVersion !== 1 || !lock.packages || typeof lock.packages !== 'object') fail('unsupported immutable Bun lock');
  for (const row of Object.values(lock.packages)) {
    if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
    const integrity = row[row.length - 1];
    if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity)) continue;
    if (entries.has(row[0]) && entries.get(row[0]) !== integrity) fail('conflicting lock identities');
    entries.set(row[0], integrity);
  }
  return entries;
}
/** Pure original-format validation. Returning these bytes never issues the
 * operational registry capability; only the fixed transport below can do so. */
export function inspectRegistryLegalArchive(identity: { name: string; version: string; integrity: string }, metadataBytes: Buffer, archive: Buffer, maximumExpanded = 32 * 1024 ** 2): { entries: any[]; manifest: any } {
  if (archive.length > 8 * 1024 ** 2 || metadataBytes.length > 256 * 1024 || !Number.isSafeInteger(maximumExpanded) || maximumExpanded < 1 || maximumExpanded > 32 * 1024 ** 2) fail('original parser byte budget exceeded');
  const metadata = JSON.parse(metadataBytes.toString());
  if (metadata.name !== identity.name || metadata.version !== identity.version || metadata.dist?.integrity !== identity.integrity) fail('original metadata identity differs');
  if ('sha512-' + digest(archive, 'sha512').toString('base64') !== identity.integrity) fail('original archive SRI differs');
  const inspected = inspectTarballBuffer(archive, { expandedBytes: maximumExpanded, members: 20000, gnuLongNames: true });
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
}
/** Service original admission shares the existing sole registry issuer. The
 * selected witness is looked up from the actual private pack observation, never
 * supplied as JSON. An original cap alone is not installed/source coverage. */
export function canonicalServiceRegistryTarball(name:string,version:string):string {
  if(!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name)||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version))fail('exact service registry identity required');
  return 'https://registry.npmjs.org/'+name+'/-/'+name.split('/').pop()+'-'+version+'.tgz';
}
export async function observeCandidateServiceRegistryOriginal(input:{originals:unknown;source:unknown;pack:unknown;name:string;version:string;budget:ServiceRegistryAcquisitionBudget}):Promise<object>{
  const {nativeOriginalsView,assertCollectedNativeOriginalCustody}=await import('./native-original-collector');
  const {assertDerivedSourceCurrent}=await import('./source-context');
  const native=nativeOriginalsView(input.originals),source=derivedSourceView(input.source);
  if(!native||!source||native.originFacts.sourceSha!==source.sourceSha)fail('same private service/source originals required');
  if(!source.trackedPaths.includes('scripts/lib/independent-admission/candidate-service-pack-output.ts'))fail('current immutable private pack reader required');
  const {candidateServicePackSelectedInputView}=await import('./candidate-service-pack-output');
  const selected=candidateServicePackSelectedInputView(input.pack,input.originals,input.source);
  if(!selected)fail('actual private completed selected source required');
  const {readFileSync}=await import('node:fs');
  const files=[['scripts/lib/independent-admission/legal-registry-originals.ts',new URL(import.meta.url)],['scripts/lib/registry-legal-original-limits.json',new URL('../registry-legal-original-limits.json',import.meta.url)]] as const;
  const master=native.members.find(row=>row.path==='service-image-materials.json');if(!master)fail('same retained service master required');
  const check=()=>{
    input.budget.check();if(input.budget.remainingMs()<=0)fail('service parent deadline exhausted');
    assertCollectedNativeOriginalCustody(input.originals);assertDerivedSourceCurrent(input.source);
    if(nativeOriginalsView(input.originals)!==native||derivedSourceView(input.source)!==source)fail('private service inputs changed');
    // Zero range verifies active lifetime and held/named master identity without
    // spending or resetting the shared source ZIP byte allowance.
    native.readOriginalRange(master.path,0,0);
    for(const [path,url] of files)if(!source.trackedPaths.includes(path)||!source.readTracked(path).equals(readFileSync(url)))fail('immutable registry issuer executable closure differs');
  };
  check();canonicalServiceRegistryTarball(input.name,input.version);
  const before=selected.read(input.name,input.version);
  const transportBudget={check,remainingMs:()=>input.budget.remainingMs(),reserveBytes(count:number){check();input.budget.reserveBytes(count);check();}};
  const cap=await acquireRegistryOriginal(input.originals as object,source,input.name,input.version,transportBudget);
  check();const after=selected.read(input.name,input.version);if(after!==before)fail('selected source witness changed');
  const original=registryLegalOriginalView(cap),modes=archiveModes.get(cap);
  if(!original||!modes)fail('sole registry issuer did not retain original');
  for(const member of after.members){
    check();if(member.type!=='file'||!member.path.startsWith('package/'))fail('actual selected file required');
    const relative=member.path.slice(8),row=original.members.find(row=>row.path===relative);
    if(!row||row.bytes!==member.bytes||row.sha256!==member.sha256||modes.get(relative)!==member.mode)fail('selected source differs from official original bytes or mode; transform proof required');
  }
  if(!after.members.length||!after.members.some(row=>row.path==='package/package.json'))fail('selected manifest source closure required');
  check();const bindings=serviceSelected.get(cap)??new WeakMap();serviceSelected.set(cap,bindings);
  const facts=Object.freeze({officialSelectedPayloadVerified:true as const,name:input.name,version:input.version,members:after.members.length});
  bindings.set(input.pack as object,Object.freeze({originals:input.originals,source:input.source,facts,assertCurrent(){check();if(selected.read(input.name,input.version)!==after)fail('private selected source witness changed');}}));
  return cap;
}
async function acquireRegistryOriginal(owner: object, source: DerivedSourceView, name: string, version: string, parent?:ServiceRegistryAcquisitionBudget): Promise<object> {
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
  if(parent)parent.reserveBytes(2*policy.metadataBytes+2*policy.packagePackedBytes+2*policy.packageExpandedBytes);
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

  checkParent();const originals = new Map<string, Buffer>(),actualModes=new Map<string,number>();
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
  archiveModes.set(cap,new Map(actualModes));group.caps.set(key, cap); return cap;
  } finally { group.active = false; }
}
