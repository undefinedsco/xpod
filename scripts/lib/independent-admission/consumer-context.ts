import {inspectInngestRuntimeOriginals,inngestRuntimeLabels,inngestRuntimeOriginalNames,inngestRuntimeAdditionalDurationMs} from './inngest-runtime-originals';
import {captureLegalFileIdentity,assertLegalFileIdentity,resolveExecutableIdentityPath} from './legal-file-custody';
import {readSignatureOriginal} from './qlever-signature-original-custody';
import {observeAfsConsumerVerifierRegistryOriginals} from './afs-consumer-registry-originals';
import {openAfsConsumerDirectoryOriginals} from './afs-consumer-directory-originals';
import {observeAfsConsumerRuntimeOriginals} from './afs-consumer-runtime-originals';
import {assertAfsConsumerDiskReservation,afsConsumerDiskLayers,assertAfsConsumerRemainingFloor} from './afs-consumer-resource';
import {reserveAfsConsumerEvidenceLayout} from './afs-consumer-public-custody';
import {finalizeAfsConsumerEvidence} from './afs-consumer-finalization';
import {afsConsumerBudget} from '../afs-consumer-budget';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { collectedArtifactView, assertCollectedPublicationCustody, collectedPublicationProjectionDirectory, preflightCollectedArchiveFiles } from './artifact-collector';
import { collectedArtifactSourceCheckout, collectedArtifactDerivedSource, assertDerivedSourceCurrent } from './source-context';
import { registryArtifactView, observeRegistryArtifact } from './registry-context';
import { planClientConsumerProfiles } from './consumer-profiles';
import { publicationPeerInputPlanView } from './peer-input-plan';
import type { CollectedArtifactIdentity, CollectedArtifactView } from './artifact-contract';
const { runPublicationCommand } = createRequire(import.meta.url)('../afs-publication-command.cjs');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fail = (message: string): never => { throw new Error('Client consumer observation: ' + message); };
const moduleCommandClosed=(row:any):boolean=>row?.actualWait===true&&row?.actualClose===true&&row?.groupAbsent===true&&row?.rawComplete===true&&row?.rawClosedBeforeHash===true&&Array.isArray(row?.pipeEOF)&&row.pipeEOF.length===2&&row.pipeEOF.every((value:unknown)=>value===true);
declare const consumerBrand: unique symbol;
export interface ClientConsumerObservation { readonly [consumerBrand]: true }
export interface ClientConsumerView {
  readonly identity: Readonly<CollectedArtifactIdentity>;
  readonly stage: 'prepublish' | 'postpublish';
  readonly baseVerified: boolean;
  readonly fullVerified: boolean;
  readonly allProfilesVerified: boolean;
  readonly registryInstallVerified: boolean;
  readonly estimatedWriteBytes: number;
  readonly maxEstimatedWriteBytes: number;
  readonly writeBudgetScope: 'estimate-not-filesystem-quota';
  readonly profiles: readonly { readonly profile: string; readonly verified: boolean; readonly pending: readonly string[] }[];
  readonly scope: 'local exact-artifact imports/exports smoke; no registry install, authentication, Pod or Chat verification'
    | 'actual registry installation and imports/exports smoke; no authentication, Pod or Chat verification'
    | 'actual collected archive public CLI module install, Node/Bun service/native probes and removal; no registry, remote Pod or Chat verification'
    | 'actual matching-host public CLI AFS install, full mounted/authenticated harness and cleanup; no actual Gateway or Chat acceptance'
    | 'actual registry public CLI module install, Node/Bun service/native probes and removal; no remote Pod or Chat verification';
}
const issued = new WeakMap<object, ClientConsumerView>();
export interface ApiInngestRuntimeOriginalView {
 readonly identity:Readonly<CollectedArtifactIdentity>;readonly stage:'prepublish'|'postpublish';readonly result:any;
 readOriginal(name:string,maximum:number):Buffer;assertCurrent():void;
}
const apiRuntimeOriginals=new WeakMap<object,ApiInngestRuntimeOriginalView>();
export function apiInngestRuntimeOriginalView(capability:unknown):ApiInngestRuntimeOriginalView|undefined{
 const view=capability&&typeof capability==='object'&&issued.has(capability)?apiRuntimeOriginals.get(capability):undefined;view?.assertCurrent();return view;
}
function rememberApiRuntimeOriginals(capability:ClientConsumerObservation,artifact:unknown,result:any,stage:'prepublish'|'postpublish',originals:readonly {path:string;data:Buffer}[],check:()=>void){
 const product=collectedArtifactView(artifact)??fail('actual API runtime product required'),source=collectedArtifactDerivedSource(artifact)??fail('actual API runtime source required');
 const rows=new Map(originals.map(row=>[row.path,Buffer.from(row.data)]));
 const read=(name:string,maximum:number)=>{const bytes=rows.get(name);if(!bytes||bytes.length>maximum)fail('registered API runtime original required');return Buffer.from(bytes!);};
 const frozen=JSON.parse(JSON.stringify(result));const freeze=(value:any):void=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}};freeze(frozen);
 inspectInngestRuntimeOriginals({product:product.identity,productMembers:product.members,result:frozen,readOriginal:read});
 const current=()=>{if(!issued.has(capability)||collectedArtifactView(artifact)!==product)fail('API runtime observation revoked');assertCollectedPublicationCustody(artifact);assertDerivedSourceCurrent(source);check();};
 apiRuntimeOriginals.set(capability,Object.freeze({identity:product.identity,stage,result:frozen,readOriginal(name:string,maximum:number){current();return read(name,maximum);},assertCurrent:current}));
}
function localApiRuntimeOriginals(directory:string,result:any,target:string){
 const references=new Map<string,{bytes:number;sha256:string}>();
 for(const runtime of ['node','bun']){const metadata=result.installedVerification?.[runtime]?.inngestRuntimeOriginal;if(metadata)references.set(metadata.path,metadata);for(const label of inngestRuntimeLabels(target)){const row=result.records.find((value:any)=>value.label===runtime+'-'+label);for(const raw of row?.raw??[])references.set(raw.path,raw);}}
 const guards:ReturnType<typeof captureLegalFileIdentity>[]=[],originals=inngestRuntimeOriginalNames(target).map(name=>{const reference=references.get(name);if(!reference)fail('actual API native execution original missing');const read=readSignatureOriginal(path.join(directory,name),reference!,65536,()=>{});guards.push(read.identity);return {path:name,data:read.bytes};});
 return {originals,assertCurrent(){for(const guard of guards)assertLegalFileIdentity(guard);}};
}
const artifactPeerPlans = new WeakMap<object, unknown>();
export function bindPublicationConsumerPeerPlan(artifact: unknown, plan: unknown): void {
  const view = collectedArtifactView(artifact), peer = publicationPeerInputPlanView(plan);
  if (!view || !peer || peer.status !== 'collection-planned' || peer.products.cli.sourceSha !== view.identity.sourceSha) return fail('real immutable artifact and peer plan required');
  if (view.identity.target === undefined && ![peer.products.cli, peer.products.client].some(identity => isDeepStrictEqual(identity, view.identity))) fail('peer plan product identity mismatch');
  artifactPeerPlans.set(artifact as object, plan);
}
function boundPeerPlan(input: RegistryInstalledProductConsumerMaterials): unknown { return input.peerPlan ?? (input.artifact && typeof input.artifact === 'object' ? artifactPeerPlans.get(input.artifact) : undefined); }
export function consumerObservationView(value: unknown): ClientConsumerView | undefined {
  return value !== null && typeof value === 'object' ? issued.get(value) : undefined;
}

/** Fixed program, not a caller script. Candidate code runs only inside the
 * materialized package roots; its output alone never proves supervisor closure. */
const probe = String.raw`
const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const spec = JSON.parse(fs.readFileSync('probe-input.json', 'utf8'));
const root = fs.realpathSync(spec.packageRoot);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (manifest.name !== spec.name || manifest.version !== spec.version) throw Error('manifest identity');
for (const name of spec.absentPeers) {
 if (fs.existsSync(path.join(process.cwd(), 'node_modules', name))) throw Error('optional peer unexpectedly installed');
 let absent = false;
 try { require.resolve(name); } catch (error) { if (error.code === 'MODULE_NOT_FOUND') absent = true; else throw error; }
 if (!absent) throw Error('optional peer resolves outside isolated base root');
}
(async () => {
 const results = [], resolutions = [];
 for (const subpath of spec.exports) {
   const name = spec.name + (subpath === '.' ? '' : subpath.slice(1));
   const resolved = MODE === 'esm' ? import.meta.resolve(name) : require.resolve(name);
   const location = fs.realpathSync(MODE === 'esm' ? require('node:url').fileURLToPath(resolved) : resolved);
   if (!location.startsWith(root + path.sep)) throw Error('export resolved outside materialized package');
   const value = location.endsWith('.json') ? require(location) : MODE === 'esm' ? await import(pathToFileURL(location).href) : require(location);
   if (value == null || (typeof value !== 'function' && Object.keys(value).length === 0)) throw Error('empty exports');
   results.push(subpath);
   resolutions.push({subpath, path:location, sha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(location)).digest('hex')});
 }
 process.stdout.write(JSON.stringify({schemaVersion:1, name:manifest.name, version:manifest.version, exports:results, resolutions}) + '\n');
})().catch(error => { process.stderr.write(String(error.stack || error)); process.exitCode = 1; });
`;
export function clientConsumerProbeSource(mode: 'esm' | 'cjs'): string {
  if (!['esm', 'cjs'].includes(mode)) return fail('invalid fixed probe mode');
  if (mode === 'cjs') return probe.replace("MODE === 'esm' ? import.meta.resolve(name) : require.resolve(name)", 'require.resolve(name)').replaceAll('MODE', "'cjs'");
  return "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);\n" + probe.replaceAll('MODE', "'esm'");
}
function runtimePath(name: 'node' | 'bun'): string {
  if ((name === 'bun') === Boolean(process.versions.bun)) return fs.realpathSync(process.execPath);
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(directory, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate); } catch { /* next installed runtime */ }
  }
  return fail('required runtime unavailable: ' + name);
}
function materialize(root: string, artifact: CollectedArtifactView, placement = 'node_modules/' + artifact.identity.package): void {
  if (!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/u.test(artifact.identity.package)) fail('unsafe package name');
  if (!placement.startsWith('node_modules/') || placement.includes('\\') || placement.split('/').some(part => !part || part === '.' || part === '..')) fail('unsafe package placement');
  const target = path.join(root, placement);
  fs.mkdirSync(target, { recursive: true });
  for (const member of artifact.members) {
    if (!member.path || member.path.includes('\\') || path.isAbsolute(member.path)
      || member.path.split('/').some(part => !part || part === '.' || part === '..')) fail('unsafe package member');
    const bytes = artifact.readMember(member.path, 16 * 1024 ** 2);
    if (bytes.length !== member.bytes || hash(bytes) !== member.sha256) fail('package member hash mismatch');
    const destination = path.join(target, member.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { flag: 'wx', mode: member.mode & 0o111 ? 0o755 : 0o644 });
  }
}

interface ConsumerInput {
  artifact: unknown; peers?: unknown[]; dependencies?: unknown[]; peerPlan?: unknown; stage: 'prepublish' | 'postpublish';
  registryObservation?: unknown; evidenceDirectory: string;
}
interface Placement { path: string; lockKey: string; artifact: CollectedArtifactView }
interface Profile {
  profile: string; pending: readonly string[]; artifacts: readonly CollectedArtifactView[];
  exportsByMode?: { esm: readonly string[]; cjs: readonly string[] };
  absentPeers: readonly string[];
  bins?: readonly string[];
  placements?: readonly Placement[];
  rootDependencies?: Record<string, string>;
}
function checkedArtifact(input: ConsumerInput): CollectedArtifactView {
  const artifact = collectedArtifactView(input.artifact);
  if (!artifact) return fail('real collected artifact capability required');
  if (!['prepublish', 'postpublish'].includes(input.stage)) fail('invalid stage');
  if (input.stage === 'postpublish') {
    const registry = registryArtifactView(input.registryObservation);
    if (!registry || !isDeepStrictEqual(registry.identity, artifact.identity)) fail('matching real registry readback required');
  }
  return artifact;
}

/** Condition declarations, not runtime dependency inference. No require probe is
 * invented for an import-only export. Unknown conditions/patterns stay pending. */
export function cliConsumerExportModes(exports: unknown) {
  if (!exports || typeof exports !== 'object' || Array.isArray(exports)) return fail('CLI public exports map required');
  const result: { esm: string[]; cjs: string[]; pending: string[] } = { esm: [], cjs: [], pending: [] };
  function supports(value: unknown, mode: 'import' | 'require'): boolean {
    if (typeof value === 'string') return value.startsWith('./');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const conditions = value as Record<string, unknown>;
    for (const [condition, target] of Object.entries(conditions)) {
      if (condition === 'types') continue;
      if (condition === mode || condition === 'default' || condition === 'node') {
        if (supports(target, mode)) return true;
      }
    }
    return false;
  }
  for (const [subpath, target] of Object.entries(exports)) {
    if ((subpath !== '.' && !subpath.startsWith('./')) || subpath.includes('*')) { result.pending.push('Unsupported export declaration: ' + subpath); continue; }
    const esm = supports(target, 'import'), cjs = supports(target, 'require');
    if (esm) result.esm.push(subpath);
    if (cjs) result.cjs.push(subpath);
    if (!esm && !cjs) result.pending.push('No supported runtime export condition: ' + subpath);
  }
  if (!result.esm.length && !result.cjs.length) result.pending.push('No executable public exports');
  return result;
}

const REGISTRY = 'https://registry.npmjs.org/';
/** Fixed production install program. Returning arguments grants no authority. */
export function registryConsumerInstallArguments(cacheDirectory: string): string[] {
  if (!path.isAbsolute(cacheDirectory)) return fail('absolute isolated cache required');
  return ['install', '--ignore-scripts', '--no-cache', '--omit=peer', '--registry', REGISTRY,
    '--backend=copyfile', '--linker=hoisted', '--cache-dir=' + cacheDirectory];
}
/** Traverses only manifests read from real central capabilities. Exact selected
 * versions satisfy ranges; ranges never become install specifications. */
function registryProfiles(profiles: readonly Profile[], dependencies: readonly unknown[] = []): Profile[] {
  const { satisfies } = createRequire(import.meta.url)('semver') as typeof import('semver');
  if (dependencies.length > 128) fail('dependency capability count exceeds 128');
  const available = new Map<string, CollectedArtifactView>();
  for (const profile of profiles) for (const view of profile.artifacts) {
    const previous = available.get(view.identity.package);
    if (previous && !isDeepStrictEqual(previous.identity, view.identity)) fail('conflicting package capabilities');
    available.set(view.identity.package, view);
  }
  const supplied = new Set<string>();
  for (const capability of dependencies) {
    const view = collectedArtifactView(capability);
    if (!view) return fail('real collected dependency capability required');
    if (available.has(view.identity.package) || supplied.has(view.identity.package)) fail('duplicate dependency package capability');
    available.set(view.identity.package, view); supplied.add(view.identity.package);
  }
  if (available.size > 128) fail('package capability count exceeds 128');
  const reached = new Set<string>();
  const result = profiles.map(profile => {
    const selected = new Map<string, CollectedArtifactView>();
    const pending = [...profile.pending];
    const queue = [...profile.artifacts];
    for (const view of queue) {
      if (selected.has(view.identity.package)) continue;
      selected.set(view.identity.package, view); reached.add(view.identity.package);
      const manifest = JSON.parse(view.readMember('package.json', 1024 * 1024).toString());
      if (manifest.name !== view.identity.package || manifest.version !== view.identity.version) fail('install manifest identity mismatch');
      const requiredPeers = Object.fromEntries(Object.entries(manifest.peerDependencies ?? {})
        .filter(([name]) => manifest.peerDependenciesMeta?.[name]?.optional !== true));
      for (const [name, range] of [...Object.entries(manifest.dependencies ?? {}), ...Object.entries(manifest.optionalDependencies ?? {}), ...Object.entries(requiredPeers)]) {
        const dependency = available.get(name);
        if (!dependency) { pending.push('Missing collected transitive package: ' + name); continue; }
        if (typeof range !== 'string' || !satisfies(dependency.identity.version, range)) fail('transitive package version does not satisfy declaration');
        queue.push(dependency);
      }
    }
    for (const name of profile.absentPeers) if (selected.has(name)) pending.push('Base profile requires an excluded optional peer: ' + name);
    return { ...profile, pending: [...new Set(pending)], artifacts: [...selected.values()] };
  });
  for (const name of supplied) if (!reached.has(name)) fail('unrelated dependency capability: ' + name);
  return result;
}
/** Nested layouts are obtained only from the opaque immutable-lock plan. A
 * serialized placement table is never accepted as an operational plan. */
function plannedProfiles(profiles: readonly Profile[], dependencies: readonly unknown[], opaque: unknown): Profile[] {
  const plan = publicationPeerInputPlanView(opaque);
  if (!plan || plan.status !== 'collection-planned') return fail('real complete publication peer plan required');
  const available = new Map<string, CollectedArtifactView>(), supplied = new Set<string>(), used = new Set<string>();
  for (const profile of profiles) for (const view of profile.artifacts) {
    const key = view.identity.package + '@' + view.identity.version, previous = available.get(key);
    if (previous && !isDeepStrictEqual(previous.identity, view.identity)) fail('conflicting exact package capability');
    available.set(key, view);
    const expected = view.identity.package === plan.products.cli.package ? plan.products.cli
      : view.identity.package === plan.products.client.package ? plan.products.client : undefined;
    if (expected && !isDeepStrictEqual(expected, view.identity)) fail('peer plan product identity mismatch');
  }
  if (dependencies.length > 128) fail('dependency capability count exceeds 128');
  for (const capability of dependencies) {
    const view = collectedArtifactView(capability);
    if (!view) return fail('real dependency artifact capability required');
    const key = view.identity.package + '@' + view.identity.version;
    if (available.has(key)) fail('duplicate exact dependency capability');
    available.set(key, view); supplied.add(key);
  }
  if (available.size > 128) fail('package capability count exceeds 128');
  const planned = new Map(plan.placements.map(placement => [placement.lockKey, placement]));
  const { satisfies } = createRequire(import.meta.url)('semver') as typeof import('semver');
  const result = profiles.map(profile => {
    const pending = [...profile.pending], placements = new Map<string, Placement>();
    const rootDependencies: Record<string, string> = {};
    const roots = profile.artifacts.filter(view => [plan.products.cli.package, plan.products.client.package].includes(view.identity.package));
    for (const view of roots) {
      placements.set(view.identity.package, { path: 'node_modules/' + view.identity.package, lockKey: view.identity.package, artifact: view });
      rootDependencies[view.identity.package] = view.identity.version;
    }
    const roles = roots.some(view => view.identity.package === plan.products.cli.package) ? ['cli', 'client'] : ['client'];
    const queue: string[] = [];
    for (const peer of profile.artifacts.filter(view => !roots.includes(view))) {
      const matches = plan.edges.filter(edge => roles.includes(edge.from) && edge.package === peer.identity.package && edge.version === peer.identity.version);
      if (!matches.length) fail('selected peer is outside immutable plan');
      rootDependencies[peer.identity.package] = peer.identity.version;
      for (const match of matches) if (match.lockKey) queue.push(match.lockKey);
    }
    for (const lockKey of queue) {
      if (placements.has(lockKey)) continue;
      const placement = planned.get(lockKey);
      if (!placement) return fail('plan edge has no exact placement');
      const view = available.get(placement.requestKey);
      if (!view) { pending.push('Missing collected exact planned artifact: ' + placement.requestKey); continue; }
      if (view.identity.integrity !== placement.integrity || view.identity.target !== undefined) fail('planned artifact integrity mismatch');
      placements.set(lockKey, { path: placement.path, lockKey, artifact: view }); used.add(placement.requestKey);
      for (const edge of plan.edges.filter(edge => edge.from === lockKey)) if (edge.lockKey) queue.push(edge.lockKey);
    }
    // Validate actual manifest declarations against Node's nearest installed
    // ancestor resolution, rather than substituting a globally selected version.
    const byPath = new Map([...placements.values()].map(placement => [placement.path, placement]));
    for (const placement of placements.values()) {
      const manifest = JSON.parse(placement.artifact.readMember('package.json', 1024 * 1024).toString());
      const requiredPeers = Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => manifest.peerDependenciesMeta?.[name]?.optional !== true);
      for (const [name, range] of [...Object.entries(manifest.dependencies ?? {}), ...Object.entries(manifest.optionalDependencies ?? {}), ...requiredPeers]) {
        let current = placement.path, resolved: Placement | undefined;
        for (;;) {
          resolved = byPath.get(current + '/node_modules/' + name);
          if (resolved || !current) break;
          const boundary = current.lastIndexOf('/node_modules/');
          current = boundary < 0 ? '' : current.slice(0, boundary);
        }
        resolved ??= byPath.get('node_modules/' + name);
        if (!resolved) { pending.push('Missing installed dependency placement: ' + name + ' from ' + placement.lockKey); continue; }
        if (typeof range !== 'string' || !satisfies(resolved.artifact.identity.version, range)) fail('planned nearest dependency version conflict');
      }
    }
    for (const name of profile.absentPeers) if (byPath.has('node_modules/' + name)) pending.push('Base excludes planned optional peer: ' + name);
    for (const [name, version] of Object.entries(rootDependencies)) {
      const placement = byPath.get('node_modules/' + name);
      if (!placement || placement.artifact.identity.version !== version) pending.push('Direct peer cannot be pinned at planned root: ' + name);
    }
    return { ...profile, pending: [...new Set(pending)], placements: [...placements.values()],
      artifacts: [...placements.values()].map(placement => placement.artifact), rootDependencies };
  });
  for (const key of supplied) if (!used.has(key)) fail('unrelated dependency capability: ' + key);
  return result;
}
function consumerProfiles(profiles: readonly Profile[], dependencies: readonly unknown[] = [], plan?: unknown): Profile[] {
  return plan === undefined ? registryProfiles(profiles, dependencies) : plannedProfiles(profiles, dependencies, plan);
}
function packageLockDescriptor(view: Pick<CollectedArtifactView, 'identity' | 'readMember'>) {
  const manifest = JSON.parse(view.readMember('package.json', 1024 * 1024).toString());
  const descriptor: Record<string, unknown> = {};
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bin', 'os', 'cpu']) if (manifest[key] !== undefined) descriptor[key] = manifest[key];
  const optionalPeers = Object.keys(manifest.peerDependencies ?? {}).filter(name => manifest.peerDependenciesMeta?.[name]?.optional === true);
  if (optionalPeers.length) descriptor.optionalPeers = optionalPeers;
  return descriptor;
}
/** Pure frozen-lock serialization, never an issuer or execution permit. */
export function createConsumerFrozenLock(placements: readonly { lockKey: string; artifact: Pick<CollectedArtifactView, 'identity' | 'readMember'> }[], dependencies: Record<string, string>) {
  const keys = new Set<string>();
  for (const placement of placements) {
    if (!placement.lockKey || placement.lockKey.includes('\\') || placement.lockKey.split('/').some(part => !part || part === '.' || part === '..') || keys.has(placement.lockKey)) fail('invalid frozen lock placement');
    keys.add(placement.lockKey);
  }
  return { lockfileVersion: 2, configVersion: 1,
    workspaces: { '': { name: 'xpod-independent-registry-consumer', version: '0.0.0', dependencies } },
    packages: Object.fromEntries(placements.map(placement => [placement.lockKey,
      [placement.artifact.identity.package + '@' + placement.artifact.identity.version, '', packageLockDescriptor(placement.artifact), placement.artifact.identity.integrity]])),
  };
}
/** Pure arithmetic only; no capabilities, network, writes or admission result.
 * Registry runs require a newly reviewed operational budget before execution. */
export function estimateConsumerWriteBudget(input: {
  preparation: 'archive' | 'registry'; payloadBytes: number; evidenceBytes: number;
  capabilityCount: number; profileCount: number;
}) {
  if (!['archive', 'registry'].includes(input.preparation)) return fail('invalid preparation strategy');
  for (const value of [input.payloadBytes, input.evidenceBytes, input.capabilityCount, input.profileCount]) {
    if (!Number.isSafeInteger(value) || value < 0) return fail('invalid write estimate input');
  }
  if (input.capabilityCount > 128 || input.profileCount > 4) fail('consumer capability/profile count exceeds fixed limits');
  const estimatedWriteBytes = input.payloadBytes * (input.preparation === 'registry' ? 4 : 1) + input.evidenceBytes;
  const maxEstimatedWriteBytes = (input.preparation === 'registry' ? 256 : 64) * 1024 ** 2;
  if (!Number.isSafeInteger(estimatedWriteBytes) || estimatedWriteBytes > maxEstimatedWriteBytes) fail('consumer write estimate exceeds fixed budget');
  return { estimatedWriteBytes, maxEstimatedWriteBytes, writeBudgetScope: 'estimate-not-filesystem-quota' as const };
}
function executionProfilesAndBudget(profiles: readonly Profile[], preparation: 'archive' | 'registry') {
  const executionProfiles = profiles.flatMap((profile, profileIndex) => preparation === 'registry'
    ? (['node', 'bun'] as const).map(runtime => ({ ...profile, profileIndex, runtime: runtime as 'node' | 'bun' | undefined }))
    : [{ ...profile, profileIndex, runtime: undefined as 'node' | 'bun' | undefined }]);
  const runnable = executionProfiles.filter(profile => profile.pending.length === 0);
  const bytes = runnable.flatMap(profile => profile.artifacts).reduce((sum, view) => sum + view.members.reduce((total, row) => total + row.bytes, 0), 0);
  const evidenceBudget = runnable.reduce((total, profile) => total + 2 * 262144 + 4 * 65536 + 1024 * 1024 + 128 * 1024
    + 2 * Buffer.byteLength(JSON.stringify(profile.artifacts.map(view => ({ identity: view.identity, files: view.members })))), 0);
  const writeEstimate = estimateConsumerWriteBudget({ preparation, payloadBytes: bytes,
    evidenceBytes: preparation === 'registry' ? evidenceBudget : 2 * 1024 ** 2,
    capabilityCount: new Set(profiles.flatMap(profile => profile.artifacts.map(view => view.identity.package))).size,
    profileCount: executionProfiles.length });
  return { executionProfiles, runnable, writeEstimate };
}
/** Pure byte/layout checker, not an issuer. Structural expectations alone cannot
 * issue a production observation; executeConsumer supplies private collector views. */
export function verifyInstalledConsumerInventory(cwd: string, artifacts: readonly Pick<CollectedArtifactView, 'identity' | 'members' | 'readMember'>[],
  declaredPlacements?: readonly { path: string; artifact: Pick<CollectedArtifactView, 'identity' | 'members' | 'readMember'> }[]) {
  const modulesPath = path.join(cwd, 'node_modules');
  if (fs.lstatSync(modulesPath).isSymbolicLink()) return fail('installed node_modules symlink');
  const actualRoot = fs.realpathSync(cwd);
  const placements = declaredPlacements ?? artifacts.map(artifact => ({ path: 'node_modules/' + artifact.identity.package, artifact }));
  const expected = new Map<string, { member: CollectedArtifactView['members'][number]; placement: string }>();
  const binTargets = new Map<string, { target: string; sha256: string }>();
  const inventories = placements.map(placement => {
    if (!placement.path.startsWith('node_modules/') || placement.path.includes('\\') || placement.path.split('/').some(part => !part || part === '.' || part === '..')) return fail('unsafe expected installation placement');
    const manifest = JSON.parse(placement.artifact.readMember('package.json', 1024 * 1024).toString());
    if (manifest.name !== placement.artifact.identity.package || manifest.version !== placement.artifact.identity.version) fail('expected manifest identity mismatch');
    for (const member of placement.artifact.members) {
      if (!member.path || member.path.includes('\\') || path.isAbsolute(member.path) || member.path.split('/').some(part => !part || part === '.' || part === '..')) fail('unsafe expected member');
      const relative = placement.path + '/' + member.path;
      if (expected.has(relative)) fail('overlapping expected installation member');
      expected.set(relative, { member, placement: placement.path });
    }
    const declarations = typeof manifest.bin === 'string' ? { [manifest.name.split('/').pop()!]: manifest.bin } : manifest.bin ?? {};
    const binDirectory = placement.path.slice(0, placement.path.lastIndexOf('node_modules/')) + 'node_modules/.bin/';
    for (const [name, target] of Object.entries(declarations)) {
      if (typeof target !== 'string' || !target || path.isAbsolute(target) || target.includes('\\') || target.split('/').some(part => part === '..')) return fail('unsafe installed bin declaration');
      const relative = target.startsWith('./') ? target.slice(2) : target;
      const member = placement.artifact.members.find(member => member.path === relative);
      if (!member || binTargets.has(binDirectory + name)) return fail('ambiguous installed bin member');
      binTargets.set(binDirectory + name, { target: path.join(actualRoot, placement.path, relative), sha256: member.sha256 });
    }
    return { identity: placement.artifact.identity, placement: placement.path, files: [] as { path: string; bytes: number; sha256: string; mode: number }[] };
  });
  const links: { name: string; path: string; text: string; target: string; memberSha256: string }[] = [];
  const visited = new Set<string>();
  function walk(relativeDirectory: string) {
    for (const name of fs.readdirSync(path.join(actualRoot, relativeDirectory))) {
      const relative = relativeDirectory + '/' + name, absolute = path.join(actualRoot, relative), stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        const binding = binTargets.get(relative);
        if (!binding || fs.realpathSync(absolute) !== binding.target) return fail('unbound installed executable link');
        links.push({ name, path: relative, text: fs.readlinkSync(absolute), target: binding.target, memberSha256: binding.sha256 });
        continue;
      }
      if (stat.isDirectory()) {
        if (!relative.endsWith('/.bin') && ![...expected.keys()].some(key => key.startsWith(relative + '/'))) fail('uncollected installed package directory');
        walk(relative); continue;
      }
      if (!stat.isFile()) fail('nonregular installed package member');
      const binding = expected.get(relative);
      if (!binding || stat.size !== binding.member.bytes || (stat.mode & 0o777) !== (binding.member.mode & 0o777)) return fail('installed package inventory or mode mismatch');
      const bytes = fs.readFileSync(absolute), sha256 = hash(bytes);
      if (sha256 !== binding.member.sha256) fail('installed package bytes mismatch');
      visited.add(relative);
      inventories.find(row => row.placement === binding.placement)!.files.push({ path: relative.slice(binding.placement.length + 1), bytes: bytes.length, sha256, mode: stat.mode & 0o777 });
    }
  }
  walk('node_modules');
  if (visited.size !== expected.size) fail('incomplete installed package inventory');
  return { inventories: inventories.map(row => ({ ...row, files: row.files.sort((a, b) => a.path.localeCompare(b.path)) })), generatedBinLinks: links };
}

/** Client and CLI use the same supervisor, temp-root lifecycle, byte budget,
 * evidence validation and private issuer. There is no caller execution hook. */
async function executeConsumer(input: ConsumerInput, artifact: CollectedArtifactView, profiles: readonly Profile[], preparation: 'archive' | 'registry' = 'archive'): Promise<ClientConsumerObservation> {
  // Both strategies require the same collected dependency closure. Registry adds
  // real readback/installation; archive only materializes these verified bytes.
  profiles = consumerProfiles(profiles, input.dependencies, boundPeerPlan(input));
  const { executionProfiles, runnable, writeEstimate } = executionProfilesAndBudget(profiles, preparation);
  if (preparation === 'registry') {
    // The primary was checked by checkedArtifact. Every additional exact artifact
    // receives the same fixed central GET-only readback before installation.
    const readbackDeadline = Date.now() + 180_000;
    const observed = new Set<string>([artifact.identity.package + '@' + artifact.identity.version]);
    for (const profile of runnable) for (const dependency of profile.artifacts) {
      if (observed.has(dependency.identity.package + '@' + dependency.identity.version)) continue;
      const capability = (input as ConsumerInput & { client?: unknown }).client;
      const candidates = [capability, ...(input.peers ?? []), ...(input.dependencies ?? [])];
      const original = candidates.find(value => collectedArtifactView(value) === dependency);
      if (!original) fail('dependency readback capability unavailable');
      if (Date.now() >= readbackDeadline) fail('dependency registry readback total deadline exceeded');
      await observeRegistryArtifact(original);
      observed.add(dependency.identity.package + '@' + dependency.identity.version);
    }
    if (Date.now() > readbackDeadline) fail('dependency registry readback total deadline exceeded');
  }
  const runtimes = { node: runtimePath('node'), bun: runtimePath('bun') };
  fs.mkdirSync(input.evidenceDirectory, { recursive: true });
  const evidence = fs.realpathSync(input.evidenceDirectory);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-consumer-'));
  let retain = false;
  const deadline = Date.now() + (preparation === 'registry' ? 180_000 : 20_000);
  const results: { profile: string; verified: boolean; pending: readonly string[] }[] = [];
  try {
    for (const [index, profile] of executionProfiles.entries()) {
      if (profile.pending.length) { results.push({ profile: profile.profile, verified: false, pending: profile.pending }); continue; }
      const cwd = path.join(root, 'profile-' + index);
      fs.mkdirSync(cwd); fs.mkdirSync(path.join(cwd, 'home')); fs.mkdirSync(path.join(cwd, 'tmp'));
      if (preparation === 'archive') {
        if (profile.placements) for (const placement of profile.placements) materialize(cwd, placement.artifact, placement.path);
        else for (const view of profile.artifacts) materialize(cwd, view);
      }
      const packageRoot = path.join(cwd, 'node_modules', artifact.identity.package);
      // Verify absence before any candidate command, including CLI binaries.
      for (const name of profile.absentPeers) if (fs.existsSync(path.join(cwd, 'node_modules', name))) fail('optional peer materialized in base');
      const runtimeBins = { node: path.join(cwd, 'runtime-node'), bun: path.join(cwd, 'runtime-bun') };
      for (const runtime of ['node', 'bun'] as const) {
        fs.mkdirSync(runtimeBins[runtime]);
        fs.symlinkSync(runtimes[runtime], path.join(runtimeBins[runtime], runtime));
        for (const tool of ['dirname', 'readlink']) {
          const source = fs.realpathSync('/usr/bin/' + tool);
          fs.accessSync(source, fs.constants.X_OK);
          fs.symlinkSync(source, path.join(runtimeBins[runtime], tool));
        }
      }
      async function command(runtime: 'node' | 'bun', label: string, args: string[], install = false): Promise<string> {
        const timeoutMs = Math.min(install ? 30000 : 1600, deadline - Date.now() - 2200);
        if (timeoutMs <= 0) return fail('total consumer deadline exhausted');
        const env: NodeJS.ProcessEnv = { PATH: runtimeBins[runtime], HOME: path.join(cwd, 'home'), TMPDIR: path.join(cwd, 'tmp'), TMP: path.join(cwd, 'tmp'), TEMP: path.join(cwd, 'tmp'), LANG: 'C.UTF-8' };
        let row: any;
        try { row = await runPublicationCommand(runtimes[runtime], args, { cwd, env, evidence, label, timeoutMs, rawLimit: install ? 262144 : 65536 }); }
        catch (error: any) { retain = !error.outcome?.groupAbsent || !error.outcome?.actualClose || !error.outcome?.actualWait; throw error; }
        if (row.code !== 0 || !row.actualWait || !row.actualClose || !row.groupAbsent || !row.rawComplete
          || !row.rawClosedBeforeHash || !row.pipeEOF?.every(Boolean)) { retain = true; return fail('unverified owned closure'); }
        for (const raw of row.raw) {
          const bytes = readModuleConsumerOriginal(evidence, raw.path, 16 * 1024 ** 2);
          if (bytes.length !== raw.bytes || hash(bytes) !== raw.sha256) fail('closed raw changed after command');
        }
        const receipt = JSON.parse(fs.readFileSync(path.join(evidence, label + '.receipt.json'), 'utf8'));
        if (!isDeepStrictEqual(receipt, row)) fail('receipt changed after command');
        return fs.readFileSync(path.join(evidence, row.raw[0].path), 'utf8');
      }
      if (preparation === 'registry') {
        const dependencies = profile.rootDependencies ?? Object.fromEntries(profile.artifacts.map(view => [view.identity.package, view.identity.version]));
        const generated = { name: 'xpod-independent-registry-consumer', version: '0.0.0', private: true, dependencies, ...(profile.placements ? {} : { overrides: dependencies }) };
        fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(generated), { flag: 'wx' });
        fs.writeFileSync(path.join(cwd, 'bunfig.toml'), '[install]\nregistry = "' + REGISTRY + '"\n', { flag: 'wx' });
        fs.writeFileSync(path.join(evidence, `profile-${index}-generated-package.json`), JSON.stringify(generated, null, 2), { flag: 'wx' });
        if (profile.placements) fs.writeFileSync(path.join(cwd, 'bun.lock'), JSON.stringify(createConsumerFrozenLock(profile.placements!, dependencies)), { flag: 'wx' });
        await command('bun', `profile-${index}-registry-install`, registryConsumerInstallArguments(path.join(cwd, 'cache')).concat(profile.placements ? ['--frozen-lockfile'] : []), true);
        const inventory = verifyInstalledConsumerInventory(cwd, profile.artifacts, profile.placements);
        for (const name of profile.absentPeers) if (fs.existsSync(path.join(cwd, 'node_modules', name))) fail('optional peer installed in base');
        const lock = fs.readFileSync(path.join(cwd, 'bun.lock'));
        if (lock.length > 512 * 1024) fail('installed lock budget exceeded');
        fs.writeFileSync(path.join(evidence, `profile-${index}-bun.lock`), lock, { flag: 'wx' });
        fs.writeFileSync(path.join(evidence, `profile-${index}-installed-inventory.json`), JSON.stringify({ ...writeEstimate, ...inventory,
          lock: { bytes: lock.length, sha256: hash(lock) }, registry: REGISTRY, runtime: profile.runtime }), { flag: 'wx' });
      }
      if (profile.bins) {
        if (profile.bins.length !== 1) fail('CLI consumer currently supports one declared binary within eight-command budget');
        const bin = profile.bins[0]!;
        if (!bin.startsWith('./') || bin.includes('\\') || bin.slice(2).split('/').some(part => !part || part === '.' || part === '..')) fail('unsafe CLI bin path');
        const originalBin = fs.realpathSync(path.join(packageRoot, bin));
        const manifest = JSON.parse(artifact.readMember('package.json', 1024 * 1024).toString());
        const binName = typeof manifest.bin === 'string' ? artifact.identity.package.split('/').pop()!
          : Object.entries(manifest.bin).find(([, target]) => target === bin)?.[0];
        const location = preparation === 'registry' ? path.join(cwd, 'node_modules', '.bin', binName ?? '') : originalBin;
        if (fs.realpathSync(location) !== originalBin) fail('installed CLI bin does not resolve to collected member');
        if (!originalBin.startsWith(fs.realpathSync(packageRoot) + path.sep)) fail('CLI bin escapes package');
        // Wrapper checks package identity and missing optional peers, then starts
        // only the fixed --version/--help arguments inside its owned group.
        const launcher = String.raw`const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process');
const s=JSON.parse(fs.readFileSync('bin-input.json','utf8'));
const m=JSON.parse(fs.readFileSync(p.join(s.root,'package.json'),'utf8'));
if(m.name!==s.name||m.version!==s.version)throw Error('CLI identity');
for(const n of s.absent){let absent=false;try{require.resolve(n)}catch(e){if(e.code==='MODULE_NOT_FOUND')absent=true;else throw e}if(!absent)throw Error('optional peer present')}
const arg=process.argv[2];if(!['--version','--help'].includes(arg))throw Error('fixed CLI argument');
const r=cp.spawnSync('/bin/sh',[s.bin,arg],{stdio:'inherit',env:process.env});if(r.error)throw r.error;process.exitCode=r.status===null?1:r.status;`;
        fs.writeFileSync(path.join(cwd, 'bin-probe.cjs'), launcher, { flag: 'wx' });
        fs.writeFileSync(path.join(cwd, 'bin-input.json'), JSON.stringify({ root: packageRoot, name: artifact.identity.package,
          version: artifact.identity.version, bin: location, absent: profile.absentPeers }), { flag: 'wx' });
        for (const runtime of profile.runtime ? [profile.runtime] : ['node', 'bun'] as const) {
          const version = await command(runtime, `profile-${index}-${runtime}-version`, ['bin-probe.cjs', '--version']);
          if (version.trim() !== artifact.identity.version) fail('CLI version output mismatch');
          const help = await command(runtime, `profile-${index}-${runtime}-help`, ['bin-probe.cjs', '--help']);
          if (!/xpod/iu.test(help) || !/usage|commands?/iu.test(help)) fail('CLI help output missing command usage');
        }
      } else {
        for (const mode of ['esm', 'cjs'] as const) {
          const exports = profile.exportsByMode![mode];
          if (!exports.length) continue;
          const expected = { schemaVersion: 1, name: artifact.identity.package, version: artifact.identity.version, exports };
          const probeInput = JSON.stringify({ ...expected, packageRoot, absentPeers: profile.absentPeers });
          if (Buffer.byteLength(probeInput) > 32768) fail('probe declaration budget exceeded');
          fs.writeFileSync(path.join(cwd, 'probe-input.json'), probeInput);
          const script = 'probe.' + (mode === 'esm' ? 'mjs' : 'cjs');
          fs.writeFileSync(path.join(cwd, script), clientConsumerProbeSource(mode), { flag: 'wx' });
          for (const runtime of profile.runtime ? [profile.runtime] : ['node', 'bun'] as const) {
            const stdout = await command(runtime, `profile-${index}-${runtime}-${mode}`, [script]);
            const { resolutions, ...reported } = JSON.parse(stdout);
            if (!isDeepStrictEqual(reported, expected) || !Array.isArray(resolutions) || resolutions.length !== exports.length) fail('probe result mismatch');
            for (const [resolutionIndex, resolution] of resolutions.entries()) {
              if (resolution.subpath !== exports[resolutionIndex] || typeof resolution.path !== 'string'
                || !resolution.path.startsWith(fs.realpathSync(packageRoot) + path.sep)) fail('probe resolution outside actual installation');
              const relative = path.relative(fs.realpathSync(packageRoot), resolution.path).split(path.sep).join('/');
              const member = artifact.members.find(member => member.path === relative);
              if (!member || resolution.sha256 !== member.sha256) fail('probe resolution not bound to collected member');
            }
            fs.writeFileSync(path.join(evidence, `profile-${index}-${runtime}-${mode}-resolutions.json`), JSON.stringify(resolutions, null, 2), { flag: 'wx' });
          }
        }
      }
      results.push({ profile: profile.profile, verified: true, pending: [] });
    }
    const combined = profiles.map((profile, index) => ({ profile: profile.profile,
      verified: results.filter((_, resultIndex) => executionProfiles[resultIndex]!.profileIndex === index).every(row => row.verified),
      pending: [...new Set(results.filter((_, resultIndex) => executionProfiles[resultIndex]!.profileIndex === index).flatMap(row => row.pending))],
    }));
    const view: ClientConsumerView = Object.freeze({ ...writeEstimate, identity: Object.freeze({ ...artifact.identity }), stage: input.stage,
      baseVerified: combined[0]?.verified === true, fullVerified: combined[1]?.verified === true,
      allProfilesVerified: combined.length === 2 && combined.every(row => row.verified),
      registryInstallVerified: preparation === 'registry' && combined.length === 2 && combined.every(row => row.verified),
      profiles: Object.freeze(combined.map(row => Object.freeze({ ...row, pending: Object.freeze([...row.pending]) }))),
      scope: preparation === 'registry' ? 'actual registry installation and imports/exports smoke; no authentication, Pod or Chat verification'
        : 'local exact-artifact imports/exports smoke; no registry install, authentication, Pod or Chat verification',
    });
    fs.writeFileSync(path.join(evidence, 'consumer-observation.json'), JSON.stringify(view, null, 2), { flag: 'wx' });
    // Complete owned cleanup before issuing any observation capability.
    fs.rmSync(root, { recursive: true, force: true });
    const capability = Object.freeze({}) as ClientConsumerObservation;
    issued.set(capability, view);
    return capability;
  } finally {
    if (!retain) fs.rmSync(root, { recursive: true, force: true });
    else fs.writeFileSync(path.join(evidence, 'retained-root.json'), JSON.stringify({ root, reason: 'owned closure unknown' }), { flag: 'wx' });
  }
}

function clientExecutionPlan(input: Pick<ConsumerInput, 'artifact' | 'peers'>) {
  const artifact = collectedArtifactView(input.artifact);
  if (!artifact) return fail('real collected artifact capability required');
  const plan = planClientConsumerProfiles(input.artifact, input.peers);
  const peerViews = (input.peers ?? []).map(value => collectedArtifactView(value)!);
  return { artifact, profiles: plan.profiles.map(profile => ({ profile: profile.profile, pending: profile.pending,
    artifacts: [artifact, ...profile.installs.map(row => peerViews.find(peer => peer.identity.package === row.package)!)],
    exportsByMode: { esm: profile.exports, cjs: profile.exports },
    absentPeers: plan.profiles[1].peers.filter(peer => peer.optional && !profile.peers.some(row => row.name === peer.name)).map(peer => peer.name),
  })) };
}

function cliExecutionPlan(input: Pick<ConsumerInput, 'artifact' | 'peers'> & { client: unknown }) {
  const artifact = collectedArtifactView(input.artifact);
  if (!artifact) return fail('real collected artifact capability required');
  const client = collectedArtifactView(input.client);
  if (artifact.identity.package !== '@undefineds.co/xpod-cli' || artifact.identity.target !== undefined
    || !client || client.identity.package !== '@undefineds.co/xpod-client' || client.identity.target !== undefined) return fail('real CLI and client capabilities required');
  const manifest = JSON.parse(artifact.readMember('package.json', 1024 * 1024).toString());
  if (manifest.name !== artifact.identity.package || manifest.version !== artifact.identity.version
    || manifest.dependencies?.[client.identity.package] !== client.identity.version) fail('CLI requires exact collected client version');
  const clientManifest = JSON.parse(client.readMember('package.json', 1024 * 1024).toString());
  if (clientManifest.name !== client.identity.package || clientManifest.version !== client.identity.version) fail('client manifest identity mismatch');
  const peerNames = Object.keys(manifest.peerDependencies ?? {});
  const clientPeerNames = Object.keys(clientManifest.peerDependencies ?? {});
  const peerViews: CollectedArtifactView[] = [];
  const seen = new Set<string>();
  const { satisfies, valid } = createRequire(import.meta.url)('semver') as typeof import('semver');
  for (const capability of input.peers ?? []) {
    const peer = collectedArtifactView(capability);
    if (!peer) return fail('real collected peer capability required');
    if (seen.has(peer.identity.package)) fail('duplicate peer capability');
    seen.add(peer.identity.package);
    if (!valid(peer.identity.version)) fail('exact peer version required');
    const declarations = [manifest.peerDependencies?.[peer.identity.package], clientManifest.peerDependencies?.[peer.identity.package]]
      .filter(range => range !== undefined);
    if (!declarations.length) fail('undeclared CLI/client peer capability');
    for (const range of declarations) if (typeof range !== 'string' || !satisfies(peer.identity.version, range)) fail('peer capability does not satisfy CLI/client declaration');
    peerViews.push(peer);
  }
  const clientPlan = planClientConsumerProfiles(input.client, (input.peers ?? [])
    .filter(capability => clientPeerNames.includes(collectedArtifactView(capability)!.identity.package)));
  const modeExports = cliConsumerExportModes(manifest.exports);
  const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
  if (bins.some(bin => typeof bin !== 'string') || bins.length !== 1) fail('one declared CLI binary required');
  const profiles: Profile[] = clientPlan.profiles.map((profile, index) => {
    const selectedPeers = peerNames.filter(name => index === 1 || manifest.peerDependenciesMeta?.[name]?.optional !== true);
    const pending = [...profile.pending]; // The shared closure resolves all declared dependencies.
    for (const name of selectedPeers) if (!peerViews.some(peer => peer.identity.package === name)) pending.push('Missing collected exact CLI peer: ' + name);
    if (index === 1) pending.push(...modeExports.pending);
    return { profile: index === 0 ? 'cli-binaries-without-optional-peers' : 'cli-all-public-exports-with-peers', pending,
      artifacts: [artifact, client, ...peerViews.filter(peer => selectedPeers.includes(peer.identity.package)
        || profile.installs.some(row => row.package === peer.identity.package))],
      absentPeers: [...new Set([...peerNames, ...clientPeerNames])].filter(name => !selectedPeers.includes(name)
        && !profile.installs.some(row => row.package === name)),
      ...(index === 0 ? { bins: bins as string[] } : { exportsByMode: modeExports }),
    };
  });
  return { artifact, profiles };
}

type RegistryMaterials = Pick<ConsumerInput, 'artifact' | 'peers' | 'dependencies' | 'peerPlan'>;
/** Read-only material readiness, not a release permit or consumer observation. */
function preflightProfiles(profiles: readonly Profile[], dependencies?: unknown[], peerPlan?: unknown) {
  const complete = consumerProfiles(profiles, dependencies, peerPlan);
  const pending = complete.flatMap(profile => profile.pending.map(reason => profile.profile + ': ' + reason));
  if (pending.length) fail('Registry consumer material gaps: ' + pending.join('; '));
  const { writeEstimate } = executionProfilesAndBudget(complete, 'registry');
  return Object.freeze({ status: 'materials-ready' as const, consumerVerified: false as const, ...writeEstimate });
}
export function preflightRegistryInstalledClientConsumer(input: RegistryMaterials) {
  return preflightProfiles(clientExecutionPlan(input).profiles, input.dependencies, input.peerPlan);
}
export function preflightRegistryInstalledCliConsumer(input: RegistryMaterials & { client: unknown }) {
  return preflightProfiles(cliExecutionPlan(input).profiles, input.dependencies, input.peerPlan);
}
async function observeClient(input: ConsumerInput, preparation: 'archive' | 'registry') {
  checkedArtifact(input);
  const { artifact, profiles } = clientExecutionPlan(input);
  return executeConsumer(input, artifact, profiles, preparation);
}
async function observeCli(input: ConsumerInput & { client: unknown }, preparation: 'archive' | 'registry') {
  checkedArtifact(input);
  const { artifact, profiles } = cliExecutionPlan(input);
  return executeConsumer(input, artifact, profiles, preparation);
}
export function observeClientConsumer(input: ConsumerInput): Promise<ClientConsumerObservation> { return observeClient(input, 'archive'); }
export function observeCliConsumer(input: ConsumerInput & { client: unknown }): Promise<ClientConsumerObservation> { return observeCli(input, 'archive'); }
export function observeRegistryInstalledClientConsumer(input: ConsumerInput & { stage: 'postpublish' }): Promise<ClientConsumerObservation> {
  if (input.stage !== 'postpublish') return Promise.reject(new Error('Registry install requires postpublish stage'));
  return observeClient(input, 'registry');
}
export function observeRegistryInstalledCliConsumer(input: ConsumerInput & { client: unknown; stage: 'postpublish' }): Promise<ClientConsumerObservation> {
  if (input.stage !== 'postpublish') return Promise.reject(new Error('Registry install requires postpublish stage'));
  return observeCli(input, 'registry');
}

export type RegistryInstalledProductConsumerMaterials = RegistryMaterials & { client?: unknown };
/** One dispatcher for publication. Product selection comes from the private
 * collector identity, never a caller supplied module/version switch. */
function registryProductPlan(input: RegistryInstalledProductConsumerMaterials) {
  const artifact = collectedArtifactView(input.artifact);
  if (!artifact) return fail('real collected artifact capability required');
  if (artifact.identity.target !== undefined) return moduleRegistryExecutionPlan(input);
  if (artifact.identity.package === '@undefineds.co/xpod-client') {
    if (input.client !== undefined) fail('client consumer cannot receive a second primary client');
    return clientExecutionPlan(input);
  }
  if (artifact.identity.package === '@undefineds.co/xpod-cli') return cliExecutionPlan({ ...input, client: input.client });
  return fail('unregistered publication consumer product');
}
/** The bound includes the 180s dependency readback window plus one in-flight
 * 30s readback, the shared 180s Node/Bun profile window, supervisor close, and
 * owned cleanup allowance. This read-only plan grants no consumer authority. */
export function preflightRegistryInstalledProductConsumer(input: RegistryInstalledProductConsumerMaterials): Readonly<{ maximumDurationMs: number }> {
  const artifact = collectedArtifactView(input.artifact);
  if (artifact?.identity.target !== undefined) { const plan=moduleRegistryExecutionPlan(input); return Object.freeze({ maximumDurationMs: plan.module==='afs'?afsConsumerBudget('postpublish').maximumDurationSeconds*1000:840_000+(plan.module==='api'?inngestRuntimeAdditionalDurationMs:0) }); }
  const { profiles } = registryProductPlan(input);
  preflightProfiles(profiles, input.dependencies, boundPeerPlan(input));
  return Object.freeze({ maximumDurationMs: 420_000 });
}
export async function observeRegistryInstalledProductConsumer(input: RegistryInstalledProductConsumerMaterials & {
  stage: 'postpublish'; registryObservation: unknown; evidenceDirectory: string;
}): Promise<ClientConsumerObservation> {
  if (input.stage !== 'postpublish') return Promise.reject(new Error('Registry install requires postpublish stage'));
  const artifact = checkedArtifact(input);
  if (artifact.identity.target !== undefined) return observeModuleRegistryConsumer(input);
  const { profiles } = registryProductPlan(input);
  preflightProfiles(profiles, input.dependencies, boundPeerPlan(input));
  return executeConsumer(input, artifact, profiles, 'registry');
}


/** Read-only fixed command expectations for remote original validation. */
export function portableConsumerOriginalExpectations(input:RegistryInstalledProductConsumerMaterials,stage:'prepublish'|'postpublish'){
  const {profiles}=registryProductPlan(input);
  const resolved=consumerProfiles(profiles,input.dependencies,boundPeerPlan(input));
  const {executionProfiles}=executionProfilesAndBudget(resolved,stage==='postpublish'?'registry':'archive');
  if(executionProfiles.some(profile=>profile.pending.length))return fail('complete portable original profile closure required');
  const labels:string[]=[];
  for(const [index,profile] of executionProfiles.entries()){
    if(stage==='postpublish')labels.push(`profile-${index}-registry-install`);
    for(const runtime of profile.runtime?[profile.runtime]:['node','bun']){
      if(profile.bins?.length)labels.push(`profile-${index}-${runtime}-version`,`profile-${index}-${runtime}-help`);
      else for(const mode of ['esm','cjs'] as const)if(profile.exportsByMode?.[mode].length)labels.push(`profile-${index}-${runtime}-${mode}`);
    }
  }
  return Object.freeze({labels:Object.freeze(labels),profiles:Object.freeze(profiles.map(profile=>profile.profile)),installations:stage==='postpublish'?executionProfiles.length:0});
}

/** Matching-host archive preconsumer uses the same fixed lifecycle and issuer.
 * No registry observation can be inferred from archive transport. */
export function preflightArchiveInstalledProductConsumer(input:RegistryInstalledProductConsumerMaterials):Readonly<{maximumDurationMs:number}>{
  const artifact=collectedArtifactView(input.artifact);
  if(artifact?.identity.target!==undefined){const plan=moduleRegistryExecutionPlan(input);return Object.freeze({maximumDurationMs:plan.module==='afs'?afsConsumerBudget('prepublish').maximumDurationSeconds*1000:630_000+(plan.module==='api'?inngestRuntimeAdditionalDurationMs:0)});}
  const {profiles}=registryProductPlan(input);preflightProfiles(profiles,input.dependencies,boundPeerPlan(input));
  return Object.freeze({maximumDurationMs:210_000});
}
export async function observeArchiveInstalledProductConsumer(input:RegistryInstalledProductConsumerMaterials & {stage:'prepublish';evidenceDirectory:string}):Promise<ClientConsumerObservation>{
  if(input.stage!=='prepublish') return fail('archive consumer requires prepublish stage');
  const artifact=checkedArtifact(input);
  if(artifact.identity.target!==undefined)return observeModuleRegistryConsumer(input,'archive');
  const {profiles}=registryProductPlan(input);preflightProfiles(profiles,input.dependencies,boundPeerPlan(input));
  return executeConsumer(input,artifact,profiles,'archive');
}

/** Fixed consumers introduce tool dependencies in addition to package runtime
 * dependencies. Return their real capabilities so publication can derive its
 * ordering graph before its first mutation. No caller-supplied edge is trusted. */
export function publicationConsumerDependencyArtifacts(input: {
  artifact: unknown; client?: unknown; dependencies?: readonly unknown[];
}): readonly unknown[] {
  const artifact = collectedArtifactView(input.artifact);
  if (!artifact) return fail('real collected artifact capability required');
  const candidates = [...new Set([input.client, ...(input.dependencies ?? [])].filter(value => value !== undefined))];
  const unique = (name: string): unknown => {
    const matches = candidates.filter(value => collectedArtifactView(value)?.identity.package === name);
    if (matches.length !== 1 || collectedArtifactView(matches[0])!.identity.target !== undefined) fail('one real consumer tool capability required: ' + name);
    return matches[0];
  };
  if (artifact.identity.package === '@undefineds.co/xpod-client' && artifact.identity.target === undefined) return Object.freeze([]);
  const cli = artifact.identity.package === '@undefineds.co/xpod-cli' && artifact.identity.target === undefined
    ? input.artifact : unique('@undefineds.co/xpod-cli');
  const client = unique('@undefineds.co/xpod-client');
  const cliView = collectedArtifactView(cli)!, clientView = collectedArtifactView(client)!;
  const manifest = JSON.parse(cliView.readMember('package.json', 1024 * 1024).toString());
  if (manifest.name !== cliView.identity.package || manifest.version !== cliView.identity.version
    || manifest.dependencies?.[clientView.identity.package] !== clientView.identity.version) fail('consumer CLI requires exact collected client version');
  if (artifact.identity.target === undefined && cli !== input.artifact) fail('unregistered publication consumer product');
  if (artifact.identity.target !== undefined) {
    const { MODULE_TARGETS, modulePackageName } = createRequire(import.meta.url)('../../../packages/xpod-cli/src/module-catalog.ts') as typeof import('../../../packages/xpod-cli/src/module-catalog');
    if (!(['api', 'css', 'afs'] as const).some(module => MODULE_TARGETS.some(row => modulePackageName(module, row.platform, row.arch) === artifact.identity.package && `${row.platform}-${row.arch}` === artifact.identity.target))) fail('unregistered platform consumer product');
  }
  return Object.freeze(cli === input.artifact ? [client] : [cli, client]);
}


function moduleRegistryExecutionPlan(input: RegistryInstalledProductConsumerMaterials,mode:'local-execution'|'remote-originals'='local-execution') {
  const artifact = collectedArtifactView(input.artifact);
  if (!artifact?.identity.target) return fail('real collected platform artifact required');
  const {MODULE_TARGETS,modulePackageName}=createRequire(import.meta.url)('../../../packages/xpod-cli/src/module-catalog.ts') as typeof import('../../../packages/xpod-cli/src/module-catalog');
  const module = (['api','css','afs'] as const).find(module=>MODULE_TARGETS.some(row=>modulePackageName(module,row.platform,row.arch)===artifact.identity.package&&`${row.platform}-${row.arch}`===artifact.identity.target));
  if (!module) return fail('registered module registry lifecycle consumer required');
  if (mode==='local-execution' && artifact.identity.target !== `${process.platform}-${process.arch}`) fail('matching native consumer host required before publication');
  const tools = publicationConsumerDependencyArtifacts(input);
  const cli = tools.find(value => collectedArtifactView(value)!.identity.package === '@undefineds.co/xpod-cli')!;
  const client = tools.find(value => collectedArtifactView(value)!.identity.package === '@undefineds.co/xpod-client')!;
  const cliView = collectedArtifactView(cli)!, clientView = collectedArtifactView(client)!;
  if (cliView.identity.sourceSha !== artifact.identity.sourceSha || clientView.identity.sourceSha !== artifact.identity.sourceSha) fail('module and public CLI consumer require same immutable source');
  const checkout = collectedArtifactSourceCheckout(input.artifact);
  const productProjection = collectedPublicationProjectionDirectory(input.artifact), cliProjection = collectedPublicationProjectionDirectory(cli);
  if (!checkout || !productProjection || !cliProjection) return fail('controlled source and projection bindings required for module consumer');
  const peerCapabilities = [...new Set(input.peers ?? [])];
  const extra = [...new Set(input.dependencies ?? [])].filter(value => !tools.includes(value) && !peerCapabilities.includes(value));
  const fullProfile = cliExecutionPlan({ artifact: cli, client, peers: peerCapabilities }).profiles[1]!;
  const profiles = consumerProfiles([fullProfile], extra, boundPeerPlan(input));
  const pending = profiles.flatMap(profile => profile.pending);
  if (pending.length) fail('Module registry tool closure gaps: ' + pending.join('; '));
  const toolViews = profiles[0]!.artifacts;
  const expanded = artifact.members.reduce((total, member) => total + member.bytes, 0)
    + toolViews.reduce((total, tool) => total + tool.members.reduce((sum, member) => sum + member.bytes, 0), 0);
  const estimatedWriteBytes = expanded * 4 + 64 * 1024 ** 2;
  if (!Number.isSafeInteger(estimatedWriteBytes) || estimatedWriteBytes > 2 * 1024 ** 3) fail('module registry consumer fixed write estimate exceeded');
  preflightCollectedArchiveFiles([input.artifact, cli, client]);
  return { module, artifact, cli, client, checkout, productProjection, cliProjection, toolViews, tools, profiles, estimatedWriteBytes };
}

async function observeModuleRegistryConsumer(input: RegistryInstalledProductConsumerMaterials & {
  stage: 'prepublish'|'postpublish'; registryObservation?: unknown; evidenceDirectory: string;
}, preparation:'archive'|'registry'='registry'): Promise<ClientConsumerObservation> {
  const plan = moduleRegistryExecutionPlan(input);
  const candidates = [...new Set([plan.cli, plan.client, ...(input.peers ?? []), ...(input.dependencies ?? [])])];
  const readbackDeadline = Date.now() + (plan.module==='afs'?afsConsumerBudget('postpublish').registryReadbackSeconds*1000:180_000);
  if(preparation==='registry') {
  for (const view of plan.toolViews) {
    if (Date.now() >= readbackDeadline) fail('module tool registry readback deadline exceeded');
    const capability = candidates.find(value => collectedArtifactView(value) === view);
    if (!capability) fail('module consumer tool capability missing');
    await observeRegistryArtifact(capability);
  }
  if (Date.now() > readbackDeadline) fail('module tool registry readback deadline exceeded');
  }
  const requestedEvidence = path.resolve(input.evidenceDirectory);
  const afsLayout=plan.module==='afs'?reserveAfsConsumerEvidenceLayout(requestedEvidence):undefined;
  const evidence=afsLayout?.privateDirectory??requestedEvidence;
  if (fs.existsSync(evidence)) fail('new module consumer evidence directory required');
  if(afsLayout) assertAfsConsumerDiskReservation({evidenceParent:path.dirname(evidence),temporaryParent:os.tmpdir(),consumerWriteBytes:plan.estimatedWriteBytes,stage:input.stage});
  const runtimeOriginals=plan.module==='afs'?await observeAfsConsumerRuntimeOriginals(plan.artifact.identity.target!,input.stage):undefined;
  // Official ZIP originals remain retained; reserve the live layers again after their download.
  if(afsLayout) assertAfsConsumerDiskReservation({evidenceParent:path.dirname(evidence),temporaryParent:os.tmpdir(),consumerWriteBytes:plan.estimatedWriteBytes,stage:input.stage});
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-registry-module-consumer-')); fs.chmodSync(parent, 0o700);
  let retain = false, preserveControl=false;
  const reference = (file: string) => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 20 * 1024 ** 2) fail('bounded collector projection original required');
    return { path: file, sha256: hash(fs.readFileSync(file)) };
  };
  const archive = (directory: string, name: string, view: CollectedArtifactView) => ({ path: path.join(directory, name),
    sha256: view.identity.archiveSha256, integrity: view.identity.integrity,bytes:view.identity.archiveBytes });
  const driver = plan.module==='afs'?path.resolve(import.meta.dir,'../afs-module-consumer.py'):path.resolve(import.meta.dir, '../../' + plan.module + '-module-consumer.py');
  const lifecycle = path.resolve(import.meta.dir, '../module-consumer.py');
  const originals = [driver, lifecycle].map(file => ({ path: file, sha256: hash(fs.readFileSync(file)) }));
  const afsLayers=plan.module==='afs'?afsConsumerDiskLayers(plan.estimatedWriteBytes,input.stage):undefined;
  const estimatedPeakBytes=afsLayers?Number(afsLayers.originals+afsLayers.live):plan.estimatedWriteBytes;
  const request = { schemaVersion: 1, target: plan.artifact.identity.target, sourceSha: plan.artifact.identity.sourceSha,
    checkout: plan.checkout, sourceRoots: [...new Set([plan.checkout, path.resolve(import.meta.dir, '../../..')])], node: runtimePath('node'), bun: runtimePath('bun'),
    temporaryParent: parent, output: evidence, transport: preparation==='registry'?'production-npm-registry':'collected-product-archives', timeoutSeconds: plan.module==='afs'?afsConsumerBudget(input.stage).ordinaryCommandSeconds:30,
    budget: { estimatedPeakBytes, remainingFloorBytes: 1024 ** 3, cushionBytes: 128 * 1024 ** 2 },
    [plan.module + 'Receipt']: reference(path.join(plan.productProjection, 'projection.receipt.json')),
    cliReceipt: reference(path.join(plan.cliProjection, 'projection.receipt.json')),
    [plan.module + 'Archive']: archive(plan.productProjection, 'product.tgz', plan.artifact),
    cliArchive: archive(plan.cliProjection, 'cli.tgz', collectedArtifactView(plan.cli)!),
    clientArchive: archive(plan.cliProjection, 'client.tgz', collectedArtifactView(plan.client)!),
    ...(plan.module==='afs'?{afsPreflightDriver:reference(path.join(plan.productProjection,'module-admission.mjs'))}:{}),
    registryTools: plan.toolViews.map(view => ({ package: view.identity.package, version: view.identity.version, files: view.members })),
  };
  const requestPath = path.join(parent, 'plan.json');
  fs.writeFileSync(requestPath, JSON.stringify(request), { flag: 'wx', mode: 0o400 });
  const supervision = path.join(parent, 'supervision'); fs.mkdirSync(supervision, { mode: 0o700 });
  try {
    let row: any;
    try { row = await runPublicationCommand(resolveExecutableIdentityPath('/usr/bin/python3'), [driver, requestPath, '--run'], {
      cwd: parent, env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, evidence: supervision,
      label: 'module-registry-consumer', timeoutMs: plan.module==='afs'?afsConsumerBudget(input.stage).consumerRunSeconds*1000:600_000+(plan.module==='api'?inngestRuntimeAdditionalDurationMs:0), rawLimit: 2 * 1024 ** 2,
    }); } catch (error) { const outcome=(error as {outcome?:any}).outcome;retain=!moduleCommandClosed(outcome);preserveControl=plan.module==='afs';throw error; }
    if (row.code !== 0 || !row.actualWait || !row.actualClose || !row.groupAbsent || !row.rawComplete
      || !row.rawClosedBeforeHash || !row.pipeEOF?.every(Boolean)) { retain = true; fail('module consumer supervisor closure unavailable'); }
    const resultGuard=plan.module==='api'?captureLegalFileIdentity(path.join(evidence,'result.json')):undefined;
    const result = JSON.parse(readModuleConsumerOriginal(evidence, 'result.json', 2 * 1024 ** 2).toString('utf8'));
    if(resultGuard)assertLegalFileIdentity(resultGuard);
    if (result.status !== 'passed' || result.transport !== (preparation==='registry'?'production-npm-registry':'collected-product-archives') || result.sourceSha !== plan.artifact.identity.sourceSha
      || result.realConsumerValidated !== true || result.ownedTemporaryRootRemoved !== true || result.forcedCleanup !== false
      || result.signal !== null || result.processGroupsUnknown !== false || result.driverSourcesUnchanged !== true) {
      retain = result.processGroupsUnknown !== false || result.ownedTemporaryRootRemoved !== true;
      fail('module registry lifecycle incomplete');
    }
    for (const original of originals) if (hash(fs.readFileSync(original.path)) !== original.sha256) fail('module consumer driver changed');
    if(afsLayout){
      preserveControl=true;
      const deadline=Date.now()+afsConsumerBudget(input.stage).safeExportSeconds*1000;
      const safe=path.join(path.dirname(evidence),'safe-evidence','afs-checked-originals');
      let exported:any;try{exported=await runPublicationCommand(resolveExecutableIdentityPath('/usr/bin/python3'),[driver,requestPath,'--export-safe-originals',safe],{
        cwd:parent,env:{PATH:process.env.PATH,LANG:'C.UTF-8'},evidence:supervision,label:'module-afs-safe-export',timeoutMs:Math.max(1,deadline-Date.now()),rawLimit:2*1024**2,
      });}catch(error){retain=!moduleCommandClosed((error as {outcome?:any}).outcome);throw error;}
      if(exported.code!==0||!exported.actualWait||!exported.actualClose||!exported.groupAbsent||!exported.rawComplete||!exported.rawClosedBeforeHash||!exported.pipeEOF?.every(Boolean)){retain=true;fail('AFS safe export supervisor closure unavailable');}
      fs.mkdirSync(path.join(evidence,'safe-evidence'),{mode:0o700});
      fs.renameSync(safe,path.join(evidence,'safe-evidence','afs-checked-originals'));
      fs.cpSync(supervision,path.join(evidence,'central-supervision'),{recursive:true,errorOnExist:true,force:false});
      const registryStarted=Date.now();
      const registryDeadline=registryStarted+afsConsumerBudget(input.stage).verifierRegistryObservationSeconds*1000;
      const registryOriginals=openAfsConsumerDirectoryOriginals(evidence,registryDeadline);
      let verifierRegistryOriginals:readonly unknown[];
      try{verifierRegistryOriginals=await observeAfsConsumerVerifierRegistryOriginals({runtimeOriginals,source:collectedArtifactDerivedSource(input.artifact),stage:input.stage,sourceSha:plan.artifact.identity.sourceSha,target:plan.artifact.identity.target!,product:plan.artifact.identity,productMembers:plan.artifact.members,tools:plan.tools.map(value=>collectedArtifactView(value)!.identity),originals:registryOriginals.members,readOriginal:registryOriginals.readOriginal,readOriginalRange:registryOriginals.readOriginalRange},registryDeadline);}finally{registryOriginals.close();}
      assertAfsConsumerRemainingFloor([evidence,parent]);
      // This separately budgeted observation is not safe-export active I/O.
      const finalizationDeadline=deadline+(Date.now()-registryStarted);
      finalizeAfsConsumerEvidence({verifierRegistryOriginals,runtimeOriginals,source:collectedArtifactDerivedSource(input.artifact),layout:afsLayout,deadline:finalizationDeadline,stage:input.stage,product:plan.artifact.identity,productMembers:plan.artifact.members,tools:plan.tools.map(value=>collectedArtifactView(value)!.identity)});
      preserveControl=false;
    }else{
    const required = ['runtime-version', 'runtime-target', 'probe', 'normal-cli-install', 'install-' + plan.module,
      'list-' + plan.module, plan.module + '-service', ...(plan.module === 'api' ? [...inngestRuntimeLabels(plan.artifact.identity.target!),'pglite', 'api-rdf'] : []), 'remove-' + plan.module];
    const labels = ['node', 'bun'].flatMap(runtime => required.map(label => runtime + '-' + label));
    if (!Array.isArray(result.records) || result.records.length !== labels.length || labels.some(label => result.records.filter((record: any) => record.label === label).length !== 1)) fail('module registry fixed profile records incomplete');
    for (const record of result.records) {
      if (record.status !== 'passed' || record.returncode !== 0 || record.waitStatus !== 'known' || record.rawClosed !== true
        || record.rawClosedBeforeHash !== true || record.rawEligible !== true || record.ownedGroupAbsent !== true || record.rawHandlesClosed !== true) fail('module registry command closure incomplete');
      if (!Array.isArray(record.raw) || record.raw.length !== 2
        || record.raw[0]?.path !== record.label + '.stdout.raw.log' || record.raw[1]?.path !== record.label + '.stderr.raw.log') fail('module registry requires both exact raw streams');
      for (const raw of record.raw) {
        if (typeof raw.path !== 'string' || path.basename(raw.path) !== raw.path || raw.sizeIsFinal !== true || raw.bytes > 16 * 1024 ** 2) fail('module registry raw reference invalid');
        const bytes = readModuleConsumerOriginal(evidence, raw.path, 16 * 1024 ** 2);
        if (bytes.length !== raw.bytes || hash(bytes) !== raw.sha256) fail('module registry raw changed');
      }
    }
    }
    preflightCollectedArchiveFiles([input.artifact, plan.cli, plan.client]);
    const view: ClientConsumerView = Object.freeze({ identity: plan.artifact.identity, stage: preparation==='registry'?'postpublish':'prepublish', baseVerified: true,
      fullVerified: true, allProfilesVerified: true, registryInstallVerified: preparation==='registry',
      estimatedWriteBytes: plan.estimatedWriteBytes, maxEstimatedWriteBytes: 2 * 1024 ** 3, writeBudgetScope: 'estimate-not-filesystem-quota',
      profiles: Object.freeze(['node', 'bun'].map(runtime => Object.freeze({ profile: runtime + '-'+preparation+'-public-cli-service-native', verified: true, pending: Object.freeze([]) }))),
      scope: afsLayout?'actual matching-host public CLI AFS install, full mounted/authenticated harness and cleanup; no actual Gateway or Chat acceptance':preparation==='registry'?'actual registry public CLI module install, Node/Bun service/native probes and removal; no remote Pod or Chat verification'
        :'actual collected archive public CLI module install, Node/Bun service/native probes and removal; no registry, remote Pod or Chat verification' });
    if(!afsLayout)fs.cpSync(supervision, path.join(evidence, 'central-supervision'), { recursive: true, errorOnExist: true, force: false });
    fs.writeFileSync(path.join(requestedEvidence, 'consumer-observation.json'), JSON.stringify(view, null, 2), { flag: 'wx', mode: 0o400 });
    fs.rmSync(parent, { recursive: true, force: true });
    const capability = Object.freeze({}) as ClientConsumerObservation; issued.set(capability, view);
    if(plan.module==='api'){const originals=localApiRuntimeOriginals(evidence,result,plan.artifact.identity.target!);if(resultGuard)assertLegalFileIdentity(resultGuard);rememberApiRuntimeOriginals(capability,input.artifact,result,view.stage,originals.originals,()=>{if(resultGuard)assertLegalFileIdentity(resultGuard);originals.assertCurrent();});}
    return capability;
  } catch (error) {
    if (retain) throw Object.assign(new Error('Module registry consumer closure unknown; retained evidence', { cause: error }),
      { retainArchiveSnapshot: true, evidenceDirectory: evidence, retainedConsumerDirectory: parent });
    if(preserveControl)throw Object.assign(new Error('AFS consumer original evidence retained: '+(error instanceof Error?error.message:'fixed validation failed'),{cause:error}),{evidenceDirectory:(error as {evidenceDirectory?:string}).evidenceDirectory??evidence,retainedConsumerDirectory:parent,retainedPrivateConsumerDirectory:evidence,retainedPublicConsumerDirectory:requestedEvidence});
    throw error;
  } finally { if (!retain&&!preserveControl) fs.rmSync(parent, { recursive: true, force: true }); }
}


/** Evidence is never followed through a link and is read from one fixed fd.
 * This helper checks bytes only; it cannot restore a consumer observation. */
function readModuleConsumerOriginal(directory: string, name: string, maximumBytes: number): Buffer {
  if (path.basename(name) !== name || !name || name === '.' || name === '..') return fail('unsafe module consumer original name');
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) fail('linked module consumer evidence ancestor');
    if (path.dirname(current) === current) break;
  }
  const file = path.join(directory, name), before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximumBytes) fail('bounded single-link module consumer original required');
  const same = (stat: fs.Stats) => before.dev === stat.dev && before.ino === stat.ino && before.size === stat.size
    && before.mode === stat.mode && before.nlink === stat.nlink && before.mtimeMs === stat.mtimeMs && before.ctimeMs === stat.ctimeMs;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!same(fs.fstatSync(fd))) fail('module consumer original changed before reading');
    const bytes = Buffer.alloc(before.size); let used = 0;
    while (used < bytes.length) { const count = fs.readSync(fd, bytes, used, bytes.length - used, used); if (!count) fail('module consumer original truncated'); used += count; }
    if (!same(fs.fstatSync(fd)) || !same(fs.lstatSync(file))) fail('module consumer original changed during reading');
    return bytes;
  } finally { fs.closeSync(fd); }
}

/** Cross-job originals are re-observed and parsed; only this existing private
 * issuer can turn their actual fixed execution into a consumer observation. */
async function observeRemoteProductConsumer(input:import('./registry-consumer-originals').GitHubRegistryInstalledProductConsumerInput & {peerPlan?:unknown},stage:'prepublish'|'postpublish'):Promise<ClientConsumerObservation>{
  const artifact=collectedArtifactView(input.artifact);if(!artifact)return fail('real collected product capability required');
  const materials={...input,peers:input.peers?[...input.peers]:undefined,dependencies:input.dependencies?[...input.dependencies]:undefined};
  const tools=publicationConsumerDependencyArtifacts(materials);
  const candidates=[...new Set([input.artifact,input.client,...(input.peers??[]),...(input.dependencies??[])].filter(value=>value!==undefined))];
  let estimatedWriteBytes:number,portableExpectations:ReturnType<typeof portableConsumerOriginalExpectations>|undefined;
  let installed:readonly CollectedArtifactView[];
  if(artifact.identity.target!==undefined){
    const plan=moduleRegistryExecutionPlan(materials,'remote-originals');estimatedWriteBytes=plan.estimatedWriteBytes;installed=[artifact,...plan.toolViews];
  }else{
    portableExpectations=portableConsumerOriginalExpectations(materials,stage);
    const profiles=consumerProfiles(registryProductPlan(materials).profiles,materials.dependencies,boundPeerPlan(materials));
    const budget=executionProfilesAndBudget(profiles,stage==='postpublish'?'registry':'archive');
    estimatedWriteBytes=budget.writeEstimate.estimatedWriteBytes;installed=profiles.flatMap(profile=>profile.artifacts);
  }
  if(stage==='postpublish'){
    const afs=/^@undefineds\.co\/xpod-afs-(?:linux|darwin)-(?:x64|arm64)$/u.test(artifact.identity.package);
    const deadline=Date.now()+(afs?afsConsumerBudget('postpublish').registryReadbackSeconds*1000:180_000);
    for(const view of new Set(installed)){
      if(Date.now()>=deadline)return fail('remote consumer current registry readback deadline exceeded');
      const capability=candidates.find(value=>collectedArtifactView(value)===view);if(!capability)return fail('remote installed tool handle missing');
      await observeRegistryArtifact(capability);
    }
    if(Date.now()>deadline)return fail('remote consumer current registry readback deadline exceeded');
  }
  const {MODULE_TARGETS,modulePackageName}=await import('../../../packages/xpod-cli/src/module-catalog');
  const module=artifact.identity.package==='@undefineds.co/xpod-client'?'client':artifact.identity.package==='@undefineds.co/xpod-cli'?'cli'
    :(['api','css','afs'] as const).find(name=>MODULE_TARGETS.some(target=>modulePackageName(name,target.platform,target.arch)===artifact.identity.package));
  if(!module)return fail('registered remote consumer product required');
  const {inspectRemoteProductConsumerOriginals}=await import('./remote-consumer-originals');
  const runtimeOriginals=module==='afs'?await observeAfsConsumerRuntimeOriginals(artifact.identity.target!,stage):undefined;
  const report=await inspectRemoteProductConsumerOriginals({runtimeOriginals,source:collectedArtifactDerivedSource(input.artifact),product:artifact.identity,productMembers:artifact.members,module,
    tools:tools.map(value=>collectedArtifactView(value)!.identity),consumerRun:input.consumerRun,stage,evidenceDirectory:input.evidenceDirectory,
    token:input.token,portableExpectations});
  preflightCollectedArchiveFiles([input.artifact,...tools]);
  const profiles=portableExpectations?report.result.profiles:['node','bun'].map(runtime=>({profile:runtime+'-'+(stage==='postpublish'?'registry':'archive')+'-public-cli-service-native',verified:true,pending:[]}));
  const view:ClientConsumerView=Object.freeze({identity:artifact.identity,stage,baseVerified:true,fullVerified:true,allProfilesVerified:true,
    registryInstallVerified:stage==='postpublish',estimatedWriteBytes,maxEstimatedWriteBytes:2*1024**3,writeBudgetScope:'estimate-not-filesystem-quota',
    profiles:Object.freeze(profiles.map((row:any)=>Object.freeze({...row,pending:Object.freeze([...row.pending])}))),
    scope:module==='afs'?'actual matching-host public CLI AFS install, full mounted/authenticated harness and cleanup; no actual Gateway or Chat acceptance':stage==='postpublish'?(artifact.identity.target===undefined?'actual registry installation and imports/exports smoke; no authentication, Pod or Chat verification'
      :'actual registry public CLI module install, Node/Bun service/native probes and removal; no remote Pod or Chat verification')
      :(artifact.identity.target===undefined?'local exact-artifact imports/exports smoke; no registry install, authentication, Pod or Chat verification'
      :'actual collected archive public CLI module install, Node/Bun service/native probes and removal; no registry, remote Pod or Chat verification')});
  const capability=Object.freeze({}) as ClientConsumerObservation;issued.set(capability,view);
  if(module==='api'){const originals=report.inngestRuntimeOriginals??fail('remote API runtime original custody missing');rememberApiRuntimeOriginals(capability,input.artifact,report.result,stage,originals.originals,originals.assertCurrent);}
  return capability;
}
export function observeGitHubRegistryInstalledProductConsumer(input:import('./registry-consumer-originals').GitHubRegistryInstalledProductConsumerInput & {peerPlan?:unknown}):Promise<ClientConsumerObservation>{return observeRemoteProductConsumer(input,'postpublish');}
export function observeGitHubArchiveProductConsumer(input:import('./archive-consumer-originals').GitHubArchiveProductConsumerInput):Promise<ClientConsumerObservation>{return observeRemoteProductConsumer(input,'prepublish');}
