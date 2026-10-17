import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { collectedArtifactView } from './artifact-collector';
import { derivedSourceView } from './source-context';
const require = createRequire(import.meta.url);
const { valid, validRange, satisfies } = require('semver') as typeof import('semver');
const { JSONC } = require('bun') as { JSONC: { parse(value: string): unknown } };
const REGISTRY = 'https://registry.npmjs.org/';
const LOCK = 'packages/xpod-cli/publication.bun.lock';
const fail = (message: string): never => { throw new Error('Publication peer inputs: ' + message); };
const packageName = (name: string) => /^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/u.test(name);
interface Manifest { peerDependencies?: Record<string, unknown> }
interface Request { requestKey: string; package: string; version: string; integrity: string; registry: typeof REGISTRY; lockKeys: string[] }
interface Edge { from: string; package: string; range: string; kind: string; lockKey?: string; version?: string }
/** Treat scoped package names as one ancestor, never as two path levels. */
function packageSegments(key: string): string[] {
  if (!key) return [];
  const parts = key.split('/'), packages: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    const item = parts[index]!;
    const name = item.startsWith('@') ? item + '/' + (parts[++index] ?? '') : item;
    if (!packageName(name)) return fail('invalid lock scope key');
    packages.push(name);
  }
  return packages;
}
function scopeAncestors(key: string): string[] {
  const packages = packageSegments(key);
  return packages.map((_, index) => packages.slice(0, packages.length - index).join('/')).concat('');
}
/** Pure declaration analysis. It never executes lock content, resolves latest,
 * downloads bytes, issues capabilities or verifies source/legal/consumer gates. */
export function derivePublicationPeerInputPlan(cli: Manifest, client: Manifest, lockBytes: Buffer) {
  if (lockBytes.length > 4 * 1024 ** 2) fail('lock byte budget exceeded');
  const lock = JSONC.parse(lockBytes.toString()) as { lockfileVersion?: unknown; configVersion?: unknown; packages?: Record<string, unknown> };
  const pending: string[] = [], edges: Edge[] = [], requests = new Map<string, Request>();
  const visited = new Set<string>(), versions = new Map<string, Set<string>>();
  if (lock?.lockfileVersion !== 2 || lock.configVersion !== 1 || !lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) {
    return { status: 'pending' as const, pending: ['Unsupported publication lock schema'], requests: [], edges: [], placements: [], installerRequirements: { multipleVersions: [] }, sourceVerified: false as const, legalVerified: false as const, consumerVerified: false as const };
  }
  const packages = lock.packages;
  const queue: { from: string; scope: string; name: string; range: unknown; kind: string }[] = [];
  for (const [role, manifest] of [['cli', cli], ['client', client]] as const) {
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) queue.push({ from: role, scope: role === 'cli' ? '@undefineds.co/xpod-cli' : '@undefineds.co/xpod-client', name, range, kind: 'peer' });
  }
  for (const item of queue) {
    if (edges.length >= 4096) { pending.push('Dependency edge budget exceeded'); break; }
    const edge: Edge = { from: item.from, package: item.name, range: String(item.range), kind: item.kind };
    edges.push(edge);
    if (!packageName(item.name) || typeof item.range !== 'string' || !validRange(item.range)) { pending.push('Unknown dependency specification: ' + item.name); continue; }
    const key = scopeAncestors(item.scope).map(scope => scope ? scope + '/' + item.name : item.name)
      .find(candidate => Object.prototype.hasOwnProperty.call(packages, candidate));
    if (!key) { pending.push('Missing locked package: ' + item.name + ' from ' + item.from); continue; }
    edge.lockKey = key;
    const row = packages[key];
    if (!Array.isArray(row) || typeof row[0] !== 'string' || !row[0].startsWith(item.name + '@')) { pending.push('Unsupported locked identity: ' + key); continue; }
    const version = row[0].slice(item.name.length + 1);
    if (valid(version) !== version || !satisfies(version, item.range)) { pending.push('Locked version/specification conflict: ' + key + ' for ' + item.range); continue; }
    edge.version = version;
    const integrity = row[3];
    if ((row[1] !== '' && row[1] !== REGISTRY) || typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity)
      || Buffer.from(integrity.slice(7), 'base64').toString('base64') !== integrity.slice(7)) { pending.push('Missing fixed-registry SHA512 identity: ' + key); continue; }
    const identity = item.name + '@' + version;
    const previous = requests.get(identity);
    if (previous && previous.integrity !== integrity) return fail('Conflicting locked integrity: ' + identity);
    if (previous) { if (!previous.lockKeys.includes(key)) previous.lockKeys.push(key); }
    else requests.set(identity, { requestKey: identity, package: item.name, version, integrity, registry: REGISTRY, lockKeys: [key] });
    const selections = versions.get(item.name) ?? new Set<string>(); selections.add(version); versions.set(item.name, selections);
    if (visited.has(key)) continue;
    if (visited.size >= 128) { pending.push('Package capability budget exceeded'); continue; }
    visited.add(key);
    const descriptor = row[2];
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) { pending.push('Unsupported dependency descriptor: ' + key); continue; }
    for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      const declarations = descriptor[kind];
      if (declarations === undefined) continue;
      if (!declarations || typeof declarations !== 'object' || Array.isArray(declarations)) { pending.push('Unsupported dependency map: ' + key); continue; }
      for (const [name, range] of Object.entries(declarations)) queue.push({ from: key, scope: key, name, range, kind });
    }
  }
  const multipleVersions = [...versions].filter(([, selected]) => selected.size > 1)
    .map(([name, selected]) => ({ package: name, versions: [...selected].sort() }));
  const placements = [...requests.values()].flatMap(request => request.lockKeys.map(lockKey => ({
    lockKey, requestKey: request.requestKey, package: request.package, version: request.version, integrity: request.integrity,
    path: 'node_modules/' + packageSegments(lockKey).join('/node_modules/'),
  }))).sort((a, b) => a.lockKey.localeCompare(b.lockKey));
  return { status: pending.length ? 'pending' as const : 'collection-planned' as const, pending: [...new Set(pending)],
    requests: [...requests.values()].sort((a, b) => a.requestKey.localeCompare(b.requestKey)), edges, placements, installerRequirements: { multipleVersions },
    sourceVerified: false as const, legalVerified: false as const, consumerVerified: false as const };
}

export function planPublicationPeerInputs(input: { cli: unknown; client: unknown; source: unknown }) {
  const cli = collectedArtifactView(input.cli), client = collectedArtifactView(input.client), source = derivedSourceView(input.source);
  if (!cli || !client || !source) return fail('real collected CLI/client and derived source capabilities required');
  if (cli.identity.package !== '@undefineds.co/xpod-cli' || client.identity.package !== '@undefineds.co/xpod-client'
    || cli.identity.target !== undefined || client.identity.target !== undefined || source.sourceSha !== cli.identity.sourceSha) fail('product/source capability mismatch');
  const cliManifest = JSON.parse(cli.readMember('package.json', 1024 * 1024).toString());
  const clientManifest = JSON.parse(client.readMember('package.json', 1024 * 1024).toString());
  if (cliManifest.name !== cli.identity.package || cliManifest.version !== cli.identity.version
    || clientManifest.name !== client.identity.package || clientManifest.version !== client.identity.version
    || cliManifest.dependencies?.[client.identity.package] !== client.identity.version) fail('manifest/client identity mismatch');
  if (!source.trackedPaths.includes(LOCK)) fail('publication lock absent from immutable source');
  const bytes = source.readTracked(LOCK);
  return { ...derivePublicationPeerInputPlan(cliManifest, clientManifest, bytes),
    products: { cli: { ...cli.identity }, client: { ...client.identity } },
    lockOriginal: { path: LOCK, sourceSha: source.sourceSha, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
}

type DeepReadonly<T> = T extends readonly (infer Item)[] ? readonly DeepReadonly<Item>[]
  : T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> } : T;
export type PublicationPeerInputPlanView = DeepReadonly<ReturnType<typeof planPublicationPeerInputs>>;
declare const publicationPeerPlanBrand: unique symbol;
export interface PublicationPeerInputPlanCapability { readonly [publicationPeerPlanBrand]: true }
const issuedPlans = new WeakMap<object, PublicationPeerInputPlanView>();
function frozenCopy<T>(value: T): DeepReadonly<T> {
  const copy = JSON.parse(JSON.stringify(value));
  function freeze(node: any): any {
    if (node && typeof node === 'object') { for (const child of Object.values(node)) freeze(child); Object.freeze(node); }
    return node;
  }
  return freeze(copy);
}
/** Only actual collector + immutable Git capabilities can issue a collection
 * plan. This authorizes bounded acquisition of these exact identities, never
 * source qualification, legal clearance, execution or publication. */
export function collectPublicationPeerInputPlan(input: { cli: unknown; client: unknown; source: unknown }): PublicationPeerInputPlanCapability {
  const report = planPublicationPeerInputs(input);
  if (report.status !== 'collection-planned') return fail('Incomplete peer collection plan: ' + report.pending.join('; '));
  const capability = Object.freeze({}) as PublicationPeerInputPlanCapability;
  issuedPlans.set(capability, frozenCopy(report));
  return capability;
}
export function publicationPeerInputPlanView(value: unknown): PublicationPeerInputPlanView | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const view = issuedPlans.get(value);
  return view ? frozenCopy(view) : undefined;
}
