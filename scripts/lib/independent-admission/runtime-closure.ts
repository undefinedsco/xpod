import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isBuiltin, createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { externalRuntimeLauncher } from '../../../packages/xpod-cli/src/launcher';
import type { AdmissionContext, CollectedAdmissionContext, OriginalReference } from './index';
import type { RuntimeClosureFacts as CentralRuntimeClosureFacts, RuntimeClosureResult as CentralRuntimeClosureResult, CollectedArtifactView, DerivedSourceView } from './artifact-contract';
import { moduleDefinition, modulePackageName, MODULE_TARGETS, MODULE_API_VERSION } from '../../../packages/xpod-cli/src/module-catalog';
import { safeMaterialPath, sourceFileIndex } from '../../../packages/xpod-cli/src/source-materials';
import { verifyNativeMaterialTarget } from '../physical-module-native';
import { collectedArtifactView, publicationMaterialView } from './artifact-collector';
import { derivedSourceView } from './source-context';
import * as sourceExecution from './source-execution';
import { moduleSourceMaterialView } from './module-source-admission';
import { collectedRuntimeMembers, RuntimeReadPending } from './runtime-member-input';

type Mode = 'import' | 'require';
type Runtime = 'node' | 'bun';
class ResolutionPending extends Error {}
interface Member { path: string; type: string; mode: number; size: number; content: Buffer; sha256: string; readPrefix?: () => Buffer; readNativeMaterial?: () => Buffer }
export interface RuntimeEdge {
  from: string; request: string; kind: Mode | 'resource'; resolved?: string; builtin?: string; optionalPeer?: boolean;
}
export interface RuntimeClosureResult extends CentralRuntimeClosureResult {
  status: 'pending' | 'verified'; reason: string; pending: string[]; edges: RuntimeEdge[];
  diagnostics: Array<{ reason: string; from: string; line: number; column: number; expression: string }>;
  runtimeDataAccess: Array<{ from: string; line: number; expression: string }>;
  facts: { -readonly [Key in keyof CentralRuntimeClosureFacts]: CentralRuntimeClosureFacts[Key] } & {
    archiveBindingVerified: boolean; manifestInventoryVerified: boolean;
    entrypoints: string[]; inspectedScripts: string[]; literalResolutionVerified: boolean;
    originalMetafilesRehashed: number; nativeTargetsChecked: string[]; unvisitedScripts: string[];
    derivedSourceVerified: boolean;
    runtimeExecutionVerified: false; originAdmissionVerified: false; sourceQualified: false;
  };
}
interface Materials {
  schemaVersion: 1; kind: 'independent-runtime-closure-materials'; runtime: Runtime;
  product: { sourceSha: string; runHeadSha: string; package: string; version: string; target?: string;
    archive: { sha256: string; integrity: string; bytes: number } };
  metafiles?: OriginalReference[];
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fail = (reason: string): never => { throw new Error('Independent runtime closure: ' + reason); };
const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const root = 'package';
const script = (name: string) => /\.(?:[cm]?js|jsx|ts|tsx)$/u.test(name) && !name.endsWith('.d.ts');

/** Pure full-graph inspection, not a capability issuer or admission result.
 * Call after all lazy mounts; the same member/ancestor rules apply regardless
 * of insertion order. Native bytes reuse the existing format verifier. */
export function inspectRuntimeGraph(members: Iterable<{ path: string; content: Buffer; mode: number; readPrefix?: () => Buffer; readNativeMaterial?: () => Buffer }>, target?: string, nativePending?: (reason: string) => void) {
  const files = new Map<string, { path: string; content: Buffer; mode: number; readPrefix?: () => Buffer; readNativeMaterial?: () => Buffer }>();
  for (const member of members) {
    if (!safeMaterialPath(member.path) || !member.path.startsWith(root + '/') || files.has(member.path)) fail('conflicting or unsafe runtime graph member');
    files.set(member.path, member);
  }
  const identities = new Map<string, string>();
  const duplicateIdentities: string[] = [], unknownIdentities: string[] = [], nativeMembers: string[] = [];
  for (const member of files.values()) {
    let ancestor = path.posix.dirname(member.path);
    while (ancestor !== '.') {
      if (files.has(ancestor)) fail('runtime graph file/directory conflict');
      ancestor = path.posix.dirname(ancestor);
    }
    if (member.path === root + '/package.json' || member.path.includes('/node_modules/') && member.path.endsWith('/package.json')) {
      const value = JSON.parse(member.content.toString('utf8'));
      if (!object(value) || typeof value.name !== 'string' || typeof value.version !== 'string') unknownIdentities.push(member.path);
      else {
        const key = value.name + '@' + value.version;
        if (identities.has(key)) duplicateIdentities.push(key);
        identities.set(key, member.path);
      }
    }
    if (/\.(?:node|wasm|so|dylib|dll)$/u.test(member.path) || (member.mode & 0o111) && !script(member.path) && (member.readPrefix ? member.readPrefix() : member.content.subarray(0, 2)).toString() !== '#!') {
      nativeMembers.push(member.path);
      try {
        const bytes = member.readNativeMaterial ? member.readNativeMaterial() : member.content;
        if (member.path.endsWith('.wasm')) verifyNativeMaterialTarget(bytes, 'portable-wasm');
        else if (target) verifyNativeMaterialTarget(bytes, target);
      } catch (error) { if (!(error instanceof RuntimeReadPending) || !nativePending) throw error; nativePending(error.message); }
    }
  }
  return { duplicateIdentities, unknownIdentities, nativeMembers };
}

/** Observes actual packed bytes without executing them. This is not an origin,
 * source-derivation, native or legal admission capability. The central registry
 * owns attachment and final admission; missing authority cannot become true here. */
export function verifyRuntimeClosure(evidence: unknown, context: AdmissionContext): RuntimeClosureResult {
  return inspectRuntimeClosure(evidence, context);
}
interface CollectedRuntimeInput {
  view: CollectedArtifactView;
  members: Member[];
  metafiles: ReadonlyMap<string, { sha256: string; read(): Buffer }>;
  pending: readonly string[];
}
function inspectRuntimeClosure(evidence: unknown, context: Omit<AdmissionContext, 'archive'> & { archive?: Buffer }, bound?: CollectedRuntimeInput): RuntimeClosureResult {
  const pending = new Set<string>();
  const edges: RuntimeEdge[] = [];
  const diagnostics: RuntimeClosureResult['diagnostics'] = [];
  const runtimeDataAccess: RuntimeClosureResult['runtimeDataAccess'] = [];
  const facts: RuntimeClosureResult['facts'] = { physicalInventoryVerified: false, runtimeImportsVerified: false,
    dataAndNativeResolutionVerified: false, packageIdentityDeduplicated: false, artifactCustodyVerified: false, runtimeClosureVerified: false, derivedSourceVerified: false, archiveBindingVerified: false, manifestInventoryVerified: false,
    entrypoints: [], inspectedScripts: [], literalResolutionVerified: false, originalMetafilesRehashed: 0,
    nativeTargetsChecked: [], unvisitedScripts: [], runtimeExecutionVerified: false, originAdmissionVerified: false, sourceQualified: false };
  const finish = (): RuntimeClosureResult => ({ status: facts.runtimeClosureVerified ? 'verified' : 'pending', reason: pending.size ? [...pending].sort().join('; ') : 'Packed runtime closure mechanically verified; source/native/legal/release admission is separate',
    pending: [...pending].sort(), edges, diagnostics, runtimeDataAccess, facts });
  if (!object(evidence) || evidence.schemaVersion !== 1 || evidence.kind !== 'independent-runtime-closure-materials') {
    pending.add('runtime-material-schema-unverified'); return finish();
  }
  if (Object.keys(evidence).some(key => !['schemaVersion', 'kind', 'runtime', 'product', 'metafiles'].includes(key))) fail('unexpected material fields');
  const material = evidence as unknown as Materials;
  if (!['node', 'bun'].includes(material.runtime)) fail('unknown runtime profile');
  const product = material.product;
  if ((!bound && !Buffer.isBuffer(context.archive)) || !object(product) || !object(product.archive) || product.sourceSha !== context.sourceSha
    || product.runHeadSha !== context.runHeadSha || product.package !== context.package || product.version !== context.version
    || product.target !== context.target || !/^[a-f0-9]{40}$/u.test(context.sourceSha)
    || !/^[a-f0-9]{40}$/u.test(context.runHeadSha) || product.archive.bytes !== (bound ? bound.view.identity.archiveBytes : context.archive!.length)
    || product.archive.sha256 !== (bound ? bound.view.identity.archiveSha256 : hash(context.archive!))
    || product.archive.integrity !== (bound ? bound.view.identity.integrity : 'sha512-' + createHash('sha512').update(context.archive!).digest('base64'))) fail('source/product/archive binding mismatch');
  const archiveHash = bound ? bound.view.identity.archiveSha256 : hash(context.archive!);
  facts.archiveBindingVerified = true;
  // Same bounded strict binary reader as existing package verification. A larger
  // artifact requires the central bounded member collector, not an unbounded unzip.
  if (!bound && context.archive!.length > 128 * 1024 ** 2) { pending.add('bounded-archive-collector-required'); return finish(); }
  const require = createRequire(import.meta.url);
  const { inspectTarballBuffer } = require('../../workspace-package-payload.cjs');
  let inspected: { manifest: any; entries: Member[] };
  try { inspected = bound ? { manifest: JSON.parse(bound.members.find(row => row.path === 'package/package.json')!.content.toString()), entries: bound.members }
    : inspectTarballBuffer(context.archive, { expandedBytes: 256 * 1024 ** 2, members: 100000, gnuLongNames: true }); }
  catch (error) {
    if (/Unsupported tar entry type "[xg]"|budget exceeded/u.test(String((error as Error).message))) {
      pending.add('bounded-archive-format-collector-required'); return finish();
    }
    throw error;
  }
  const files = new Map<string, Member>(); const logicalNames = new Set<string>();
  for (const entry of inspected.entries) {
    const logical = entry.type === 'directory' ? entry.path.replace(/\/$/u, '') : entry.path;
    if (logicalNames.has(logical)) fail('conflicting packed directory/file'); logicalNames.add(logical);
    if (!safeMaterialPath(entry.type === 'directory' ? entry.path.replace(/\/$/u, '') : entry.path)) fail('unsafe packed member path');
    if (entry.path !== root && !entry.path.startsWith(root + '/')) fail('archive member escaped package root');
    if (entry.type === 'file') files.set(entry.path, entry);
  }
  const directories = new Set<string>([root]);
  for (const name of files.keys()) {
    let ancestor = path.posix.dirname(name);
    while (ancestor === root || ancestor.startsWith(root + '/')) {
      if (files.has(ancestor)) fail('non-directory packed member ancestor');
      directories.add(ancestor);
      ancestor = path.posix.dirname(ancestor);
    }
  }
  facts.physicalInventoryVerified = true;
  const pkg = inspected.manifest;
  if (pkg.name !== context.package || pkg.version !== context.version) fail('packed identity differs');
  if (context.target !== undefined) {
    const target = MODULE_TARGETS.find(row => row.platform + '-' + row.arch === context.target);
    const module = pkg.xpodModule;
    if (!target || !object(module) || module.schemaVersion !== 1 || module.cliApiVersion !== MODULE_API_VERSION || moduleDefinition(module.id)?.id !== module.id
      || module.platform !== target.platform || module.arch !== target.arch
      || modulePackageName(module.id, target.platform, target.arch) !== context.package || !Array.isArray(module.files) || !module.files.length || !safeMaterialPath(module.entry) || !module.entry.endsWith('.mjs')) fail('catalog/target binding mismatch');
    if (module.files.some((file: any) => !object(file))) fail('invalid packed inventory');
    sourceFileIndex(module.files.map((file: any) => ({ path: file.path, sha256: file.sha256, sizeBytes: file.size })));
    const declared = new Set<string>();
    for (const row of module.files) {
      const file = files.get(root + '/' + row.path);
      if (row.path === 'package.json' || ![0o644, 0o755].includes(row.mode) || !file || file.size !== row.size
        || file.sha256 !== row.sha256 || (file.mode & 0o777) !== row.mode) fail('packed inventory bytes/mode mismatch');
      declared.add(root + '/' + row.path);
    }
    if ([...files.keys()].some(name => name !== root + '/package.json' && !declared.has(name))) fail('unbound packed file');
    facts.manifestInventoryVerified = true;
  } else if (pkg.xpodModule !== undefined) fail('platform module missing target context');

  // Resolve the one central issuer, without a callback/public constructor. A
  // development worktree may not yet contain the collector dependency; that is
  // an explicit pending capability. Once present, loading/verification errors
  // propagate instead of silently falling back to arbitrary callbacks.
  const centralView = <T>(file: string, getter: string, value: unknown): T | undefined => {
    let resolved: string;
    try { resolved = require.resolve(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return undefined; throw error; }
    return require(resolved)[getter](value) as T | undefined;
  };
  const collected = bound?.view ?? centralView<CollectedArtifactView>('./artifact-collector.ts', 'collectedArtifactView', context.collectedArtifact);
  const derived = centralView<DerivedSourceView>('./source-context.ts', 'derivedSourceView', context.derivedSource);
  if (collected) {
    const identity = collected.identity;
    if (identity.sourceSha !== context.sourceSha || identity.package !== context.package || identity.version !== context.version
      || identity.target !== context.target || identity.archiveSha256 !== archiveHash || identity.archiveBytes !== (bound ? bound.view.identity.archiveBytes : context.archive!.length)
      || identity.integrity !== product.archive.integrity || collected.members.length !== files.size) fail('collected artifact identity/member mismatch');
    const observed = new Set<string>();
    for (const member of collected.members) {
      const file = files.get(root + '/' + member.path);
      if (!safeMaterialPath(member.path) || observed.has(member.path) || !file || member.sha256 !== file.sha256
        || member.bytes !== file.size || member.mode !== file.mode
        || (!bound && !collected.readMember(member.path, file.size).equals(file.content))) fail('collected member differs from runtime archive');
      observed.add(member.path);
    }
    facts.artifactCustodyVerified = true;
  } else pending.add('controlled-archive-custody-capability-unavailable');
  if (derived) {
    if (derived.sourceSha !== context.sourceSha) fail('derived source identity mismatch');
    facts.derivedSourceVerified = true;
  } else pending.add('source-admission-capability-unavailable');
  // Associated archives remain capabilities of the central collector. Mount
  // only a requested exact dependency, never a host/workspace package path.
  const related = new Map<string, CollectedArtifactView>();
  if ((context.relatedArtifacts?.length ?? 0) > 64) fail('related artifact count budget exceeded');
  for (const capability of context.relatedArtifacts ?? []) {
    const view = centralView<CollectedArtifactView>('./artifact-collector.ts', 'collectedArtifactView', capability);
    if (!view) { pending.add('related-artifact-capability-unavailable'); continue; }
    const identity = view.identity;
    if (!/^(?:@[a-z\d._-]+\/)?[a-z\d._-]+$/iu.test(identity.package)
      || !/^[a-f0-9]{40}$/u.test(identity.sourceSha) || !/^[a-f0-9]{64}$/u.test(identity.archiveSha256)) fail('invalid related artifact identity');
    const previous = related.get(identity.package);
    if (previous && (previous.identity.version !== identity.version || previous.identity.archiveSha256 !== identity.archiveSha256
      || previous.identity.sourceSha !== identity.sourceSha || previous.identity.integrity !== identity.integrity)) fail('conflicting related artifact identity');
    related.set(identity.package, view);
  }
  for (const reason of bound?.pending ?? []) pending.add(reason);
  let relatedBytes = 0;
  const mounted = new Set<string>();
  const mountRelated = (name: string, version: string, directory: string): void => {
    const view = related.get(name);
    if (!view) throw new ResolutionPending('related-artifact-required:' + name + '@' + version);
    if (view.identity.version !== version) fail('related artifact exact version mismatch: ' + name);
    // A historical published dependency needs its own controlled registry/source
    // policy. Do not silently assume either approval or the current producer SHA.
    if (view.identity.sourceSha !== context.sourceSha) {
      if (collected) {
        const producer = JSON.parse(collected.readProducerOriginal('result.json', 1024 ** 2).toString('utf8'));
        if (Object.values(producer.products ?? {}).some((row: any) => row?.package === name && row?.version === version)) fail('related artifact expected producer source mismatch');
      }
      throw new ResolutionPending('related-artifact-historical-registry-source-required:' + name + '@' + version);
    }
    if (collected) {
      const producer = JSON.parse(collected.readProducerOriginal('result.json', 1024 ** 2).toString('utf8'));
      const expected: any = Object.values(producer.products ?? {}).find((row: any) => row?.package === name && row?.version === version);
      if (expected && (expected.archive?.sha256 !== view.identity.archiveSha256 || expected.archive?.integrity !== view.identity.integrity
        || expected.archive?.bytes !== view.identity.archiveBytes)) fail('related artifact producer archive mismatch');
    }
    if (mounted.has(directory)) return;
    if (view.members.length > 20000) fail('related artifact member count budget exceeded');
    const rows = new Map<string, Member>();
    for (const row of view.members) {
      if (!safeMaterialPath(row.path) || rows.has(row.path) || !Number.isSafeInteger(row.bytes) || row.bytes < 0
        || row.bytes > 8 * 1024 ** 2 || (relatedBytes += row.bytes) > 16 * 1024 ** 2) fail('unsafe or unbounded related member');
      const content = view.readMember(row.path, row.bytes);
      if (!Buffer.isBuffer(content) || content.length !== row.bytes || hash(content) !== row.sha256) fail('related member hash/size mismatch');
      rows.set(row.path, {path: directory + '/' + row.path, type: 'file', mode: row.mode, size: row.bytes, content, sha256: row.sha256});
    }
    const manifest = rows.get('package.json');
    if (!manifest) return fail('related package manifest missing');
    const value = JSON.parse(manifest.content.toString('utf8'));
    if (value.name !== name || value.version !== version) fail('related package manifest identity mismatch');
    for (const row of rows.values()) {
      let ancestor = path.posix.dirname(row.path);
      while (ancestor.startsWith(root + '/')) {
        if (files.has(ancestor) || rows.has(ancestor.slice(directory.length + 1))) fail('related member non-directory ancestor');
        directories.add(ancestor); ancestor = path.posix.dirname(ancestor);
      }
      if (files.has(row.path) || directories.has(row.path)) fail('related member collides with packed installation file/directory');
    }
    for (const row of rows.values()) files.set(row.path, row);
    mounted.add(directory);
  };

  const boundary = (name: string): string => {
    if (name.includes('\\') || /[\u0000-\u001f\u007f]/u.test(name)) fail('unsafe runtime path');
    const normal = path.posix.normalize(name).replace(/\/$/u, '');
    if (normal !== root && !normal.startsWith(root + '/')) fail('runtime resolution escaped package root');
    return normal;
  };
  const jsonCache = new Map<string, any>();
  const json = (name: string): any => {
    if (jsonCache.has(name)) return jsonCache.get(name);
    const file = files.get(name); if (!file) fail('missing packed manifest: ' + name);
    try { const value = JSON.parse(file!.content.toString('utf8')); if (!object(value)) fail('invalid packed manifest'); jsonCache.set(name, value); return value; }
    catch { return fail('invalid packed manifest: ' + name); }
  };
  const packageScope = (from: string): { directory: string; manifest: any } => {
    let directory = path.posix.dirname(from);
    while (directory === root || directory.startsWith(root + '/')) {
      if (files.has(directory + '/package.json')) return { directory, manifest: json(directory + '/package.json') };
      directory = path.posix.dirname(directory);
    }
    return { directory: root, manifest: pkg };
  };
  const selected = (value: any, mode: Mode): string | null | undefined => {
    if (typeof value === 'string' || value === null) return value;
    if (Array.isArray(value)) {
      // Fallback array semantics depend on error classification in the actual
      // interpreter. Never silently select a convenient valid-looking branch.
      pending.add('package-target-array-resolution-unverified'); return undefined;
    }
    if (!object(value)) return fail('invalid package target');
    for (const [condition, target] of Object.entries(value)) {
      if (['default', mode, 'node', ...(material.runtime === 'node' ? ['node-addons'] : ['bun'])].includes(condition)) return selected(target, mode);
    }
    return null;
  };
  const patternsCache = new WeakMap<object, string[]>();
  const mapping = (map: any, key: string, mode: Mode): string | null | undefined => {
    if (typeof map === 'string' || map === null || Array.isArray(map)) return key === '.' ? selected(map, mode) : null;
    if (!object(map)) fail('invalid package mapping');
    const keys = Object.keys(map);
    if (!keys.some(name => name.startsWith('.') || name.startsWith('#'))) return key === '.' ? selected(map, mode) : null;
    if (Object.prototype.hasOwnProperty.call(map, key)) return selected(map[key], mode);
    if (keys.length > 4096) throw new ResolutionPending('bounded-package-mapping-capability-required');
    let patterns = patternsCache.get(map);
    if (!patterns) {
      patterns = keys.filter(name => name.includes('*') && name.split('*').length === 2)
        .sort((a, b) => b.indexOf('*') - a.indexOf('*') || b.length - a.length);
      patternsCache.set(map, patterns);
    }
    for (const pattern of patterns) {
      const [prefix, suffix] = pattern.split('*');
      if (key.startsWith(prefix) && key.endsWith(suffix) && key.length >= prefix.length + suffix.length) {
        const target = selected(map[pattern], mode);
        return typeof target !== 'string' ? target : target.replaceAll('*', key.slice(prefix.length, key.length - suffix.length));
      }
    }
    return null;
  };
  let resolutionSteps = 0;
  const exact = (name: string): string => { name = boundary(name); if (!files.has(name)) fail('missing packed runtime member: ' + name); return name; };
  const legacyFile = (name: string, depth = 0): string => {
    if (depth > 32 || ++resolutionSteps > 100000) return fail('runtime resolution cycle/budget');
    name = boundary(name);
    for (const candidate of [name, name + '.js', name + '.json', name + '.node']) if (files.has(candidate)) return candidate;
    if (files.has(name + '/package.json')) {
      const manifest = json(name + '/package.json');
      if (typeof manifest.main === 'string') return legacyFile(path.posix.join(name, manifest.main), depth + 1);
    }
    for (const suffix of ['/index.js', '/index.json', '/index.node']) if (files.has(name + suffix)) return name + suffix;
    return fail('missing packed runtime member: ' + name);
  };
  const exportFile = (directory: string, target: string): string => {
    if (!target.startsWith('./') || !safeMaterialPath(target.slice(2)) || target.split('/').includes('node_modules')) fail('unsafe package export target');
    const candidate = boundary(path.posix.join(directory, target));
    if (!candidate.startsWith(directory + '/')) fail('package export escaped own root');
    return exact(candidate);
  };
  const resolve = (from: string, request: string, mode: Mode, depth = 0): string => {
    if (depth > 32 || ++resolutionSteps > 100000) return fail('runtime resolution cycle/budget');
    if (!request || request.includes('\\') || /[\u0000-\u001f\u007f]/u.test(request)) fail('unsafe module specifier');
    if (request.startsWith('/') || /^[a-z][a-z\d+.-]*:/iu.test(request)) fail('external URL/absolute code dependency');
    if (request.startsWith('.')) {
      let name = request;
      if (mode === 'import') {
        if (/%(?:2f|5c)/iu.test(name)) fail('encoded module separator');
        if (/[?#]/u.test(name)) { pending.add('URL-module-instance-identity-unverified'); name = name.split(/[?#]/u)[0]; }
        try { name = decodeURIComponent(name); } catch { fail('invalid encoded module path'); }
      }
      const candidate = boundary(path.posix.join(path.posix.dirname(from), name));
      return mode === 'require' || material.runtime === 'bun' && !files.has(candidate) ? legacyFile(candidate) : exact(candidate);
    }
    const scope = packageScope(from);
    if (request.startsWith('#')) {
      const target = mapping(scope.manifest.imports ?? {}, request, mode);
      if (target === undefined) throw new ResolutionPending('package-target-array-resolution-unverified');
      if (target === null) return fail('unresolved package import: ' + request);
      return target.startsWith('./') ? exportFile(scope.directory, target) : resolve(from, target, mode, depth + 1);
    }
    const parts = request.split('/'); const count = request.startsWith('@') ? 2 : 1;
    const name = parts.slice(0, count).join('/'), subpath = parts.length === count ? '.' : './' + parts.slice(count).join('/');
    if (!/^(?:@[a-z\d._-]+\/)?[a-z\d._-]+$/iu.test(name) || parts.slice(count).some(part => !part || part === '.' || part === '..')) fail('unsafe bare module request');
    const inPackage = (directory: string, manifest: any): string => {
      if (manifest.exports !== undefined) {
        const target = mapping(manifest.exports, subpath, mode);
        if (target === undefined) throw new ResolutionPending('package-target-array-resolution-unverified');
        if (target === null) return fail('package subpath is not exported: ' + request);
        return exportFile(directory, target);
      }
      return legacyFile(path.posix.join(directory, subpath === '.' ? manifest.main ?? 'index.js' : subpath.slice(2)));
    };
    if (scope.manifest.name === name && scope.manifest.exports !== undefined) return inPackage(scope.directory, scope.manifest);
    let directory = path.posix.dirname(from);
    while (directory === root || directory.startsWith(root + '/')) {
      if (path.posix.basename(directory) !== 'node_modules') {
        const candidate = directory + '/node_modules/' + name;
        if (files.has(candidate + '/package.json')) return inPackage(candidate, json(candidate + '/package.json'));
        if ([candidate + '.js', candidate + '/index.js'].some(file => files.has(file))) return legacyFile(candidate);
      }
      directory = path.posix.dirname(directory);
    }
    const declared = scope.manifest.dependencies?.[name];
    if (typeof declared === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(declared)) {
      const directory = scope.directory + '/node_modules/' + name;
      mountRelated(name, declared, directory);
      return inPackage(directory, json(directory + '/package.json'));
    }
    return fail('dependency absent from packed root: ' + request);
  };

  const queue: Array<{ name: string; mode: Mode }> = [];
  const scheduled = new Set<string>();
  const add = (name: string, mode: Mode) => { name = exact(name); const key = name + ':' + mode;
    if (!scheduled.has(key)) { scheduled.add(key); queue.push({ name, mode }); } };
  const entry = (target: unknown, mode: Mode) => {
    if (typeof target !== 'string' || !safeMaterialPath(target.replace(/^\.\//u, ''))) fail('invalid packed entrypoint');
    add(root + '/' + (target as string).replace(/^\.\//u, ''), mode);
  };
  if (typeof pkg.main === 'string') entry(pkg.main, 'require');
  if (typeof pkg.module === 'string') entry(pkg.module, 'import');
  if (typeof pkg.bin === 'string') entry(pkg.bin, 'require');
  else if (pkg.bin !== undefined) { if (!object(pkg.bin)) fail('invalid packed bin map'); for (const target of Object.values(pkg.bin)) entry(target, 'require'); }
  if (pkg.xpodModule) entry(pkg.xpodModule.entry, 'import');
  if (pkg.exports !== undefined) {
    if (object(pkg.exports) && Object.keys(pkg.exports).length > 4096) { pending.add('bounded-package-mapping-capability-required'); return finish(); }
    const keys = object(pkg.exports) && Object.keys(pkg.exports).some(key => key.startsWith('.')) ? Object.keys(pkg.exports) : ['.'];
    for (const key of keys) for (const mode of ['import', 'require'] as const) {
      const target = mapping(pkg.exports, key, mode); if (target == null) continue;
      if (target.includes('*')) {
        if (target.split('*').length !== 2 || !target.startsWith('./')) fail('unsupported export pattern');
        const [prefix, suffix] = (root + '/' + target.slice(2)).split('*');
        const matches = [...files.keys()].filter(name => name.startsWith(prefix) && name.endsWith(suffix));
        if (!matches.length) fail('export pattern has no packed targets');
        for (const name of matches) { exportFile(root, './' + name.slice(root.length + 1)); add(name, mode); }
      } else add(exportFile(root, target), mode);
    }
  }
  if (!queue.length) {
    if (files.has(root + '/index.js')) add(root + '/index.js', 'require');
    else pending.add('runtime-entrypoint-unverified');
  }
  facts.entrypoints = [...new Set(queue.map(row => row.name))].sort();
  const edgeKeys = new Set<string>();
  const record = (edge: RuntimeEdge) => {
    const key = JSON.stringify(edge); if (edgeKeys.has(key)) return;
    if (edges.length >= 100000) fail('runtime edge budget exceeded'); edgeKeys.add(key); edges.push(edge);
  };
  let uncertain = [...pending].some(reason => !bound?.pending.includes(reason) && !['controlled-archive-custody-capability-unavailable', 'source-admission-capability-unavailable'].includes(reason)), parsedBytes = 0;
  const native = new Set<string>();
  const launchers = new Map<string, string>();
  for (const file of files.values()) if (file.size <= 16384 && ((file.mode & 0o111) || facts.entrypoints.includes(file.path) || file.path.startsWith('package/bin/'))) for (const payload of ['xpod.mjs', 'lib/xpodcli.mjs'] as const) {
    if (file.content.toString('utf8') === externalRuntimeLauncher({ payload })) {
      const target = boundary(path.posix.join(path.posix.dirname(file.path), '..', payload));
      add(target, 'import'); launchers.set(file.path, target);
    }
  }
  const checkNative = (file: Member) => {
    if (native.has(file.path)) return; native.add(file.path);
    if (!context.target && !file.path.endsWith('.wasm')) { pending.add('native-target-context-unverified'); return; }
    try { verifyNativeMaterialTarget(file.readNativeMaterial ? file.readNativeMaterial() : file.content, file.path.endsWith('.wasm') ? 'portable-wasm' : context.target!); }
    catch (error) { if (!(error instanceof RuntimeReadPending)) throw error; pending.add(error.message); return; }
    facts.nativeTargetsChecked.push(file.path); if (!bound) pending.add('native-source-ABI-origin-admission-unverified');
  };
  for (const file of files.values()) {
    if (/^package\/(?:source|provenance)\//u.test(file.path)) continue;
    if (/\.(?:node|wasm|so|dylib|dll)$/u.test(file.path)) checkNative(file);
    else if ((file.mode & 0o111) && !script(file.path)) {
      if (launchers.has(file.path)) continue;
      if ((file.readPrefix ? file.readPrefix() : file.content.subarray(0, 2)).toString() === '#!') pending.add('executable-script-interpreter-unverified');
      else checkNative(file);
    }
  }
  const parsedScripts = new Set<string>(); let nextScript = 0;
  while (nextScript < queue.length) {
    const { name, mode } = queue[nextScript++]; const file = files.get(name)!;
    if (name.endsWith('.json')) { JSON.parse(file.content.toString('utf8')); continue; }
    if (/\.(?:node|wasm|so|dylib|dll)$/u.test(name)) checkNative(file);
    if (launchers.has(name)) continue;
    if (!script(name)) { pending.add('non-JavaScript-entry-resolver-unverified'); uncertain = true; continue; }
    if (file.size > 16 * 1024 ** 2 || (parsedBytes += file.size) > 64 * 1024 ** 2) {
      pending.add('bounded-script-parser-capability-required'); uncertain = true; continue;
    }
    const source = ts.createSourceFile(name, file.content.toString('utf8'), ts.ScriptTarget.Latest, true,
      /\.tsx?$/u.test(name) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    if ((source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) fail('invalid packed JavaScript syntax');
    facts.inspectedScripts.push(name); parsedScripts.add(name);
    let shadowedRequire = false;
    const resourceFunctions = new Set(['readFile', 'readFileSync', 'createReadStream', 'readdir', 'readdirSync', 'spawn', 'spawnSync', 'exec', 'execFile', 'fork', 'dlopen']);
    const aliases = new Map<string, string>();
    const fsBindings = new Set<string>();
    const fsFunctions = new Set<string>();
    const isFs = (name: string) => ['fs', 'node:fs', 'fs/promises', 'node:fs/promises'].includes(name);
    const bindings = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'require'
        || ts.isFunctionDeclaration(node) && node.name?.text === 'require'
        || ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && node.left.text === 'require') shadowedRequire = true;
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)
        && ['node:fs', 'fs', 'node:fs/promises', 'fs/promises', 'node:child_process', 'child_process', 'node:module', 'module'].includes(node.moduleSpecifier.text)) {
        const named = node.importClause?.namedBindings;
        if (named && ts.isNamedImports(named)) for (const item of named.elements) aliases.set(item.name.text, item.propertyName?.text ?? item.name.text);
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && isFs(node.moduleSpecifier.text)) {
        if (node.importClause?.name) fsBindings.add(node.importClause.name.text);
        const named = node.importClause?.namedBindings;
        if (named && ts.isNamespaceImport(named)) fsBindings.add(named.name.text);
        if (named && ts.isNamedImports(named)) for (const item of named.elements) fsFunctions.add(item.name.text);
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)
        && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'require'
        && node.initializer.arguments[0] && ts.isStringLiteralLike(node.initializer.arguments[0]) && isFs(node.initializer.arguments[0].text)) fsBindings.add(node.name.text);
      ts.forEachChild(node, bindings);
    };
    bindings(source);
    // Resolve lexical declaration origins; method spelling alone carries no
    // filesystem, process or loader authority.
    const scopes = new WeakMap<ts.Node, Map<string, ts.Expression | string | null>>();
    const mutations = new Set<string>();
    const scopeNode = (node: ts.Node, functionOnly = false): ts.Node => {
      let current: ts.Node | undefined = node;
      while (current && !ts.isSourceFile(current) && !ts.isFunctionLike(current) && (functionOnly || !ts.isBlock(current))) current = current.parent;
      return current ?? source;
    };
    const declare = (scope: ts.Node, key: string, value: ts.Expression | string | null) => {
      let map = scopes.get(scope); if (!map) {map = new Map(); scopes.set(scope, map);}
      map.set(key, map.has(key) ? null : value);
    };
    const collectBindings = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const list = ts.isVariableDeclarationList(node.parent) ? node.parent : undefined;
        declare(scopeNode(node.parent, Boolean(list && !(list.flags & ts.NodeFlags.BlockScoped))), node.name.text, node.initializer ?? null);
      }
      if (ts.isParameter(node) && ts.isIdentifier(node.name)) declare(scopeNode(node.parent), node.name.text, null);
      if (ts.isFunctionDeclaration(node) && node.name) declare(scopeNode(node.parent), node.name.text, null);
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const module = node.moduleSpecifier.text.replace(/^node:/u, '');
        if (node.importClause?.name) declare(source, node.importClause.name.text, 'module:' + module);
        const named = node.importClause?.namedBindings;
        if (named && ts.isNamespaceImport(named)) declare(source, named.name.text, 'module:' + module);
        if (named && ts.isNamedImports(named)) for (const item of named.elements) declare(source, item.name.text, 'module:' + module + '#' + (item.propertyName?.text ?? item.name.text));
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(node.left)) mutations.add(node.left.text);
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && ts.isIdentifier(node.operand)
        && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) mutations.add(node.operand.text);
      ts.forEachChild(node, collectBindings);
    };
    collectBindings(source);
    const origin = (expression: ts.Expression, depth = 0): string | undefined => {
      if (depth > 16) return undefined;
      if (ts.isParenthesizedExpression(expression)) return origin(expression.expression, depth + 1);
      if (ts.isRegularExpressionLiteral(expression)) return 'regexp';
      if (ts.isIdentifier(expression)) {
        if (mutations.has(expression.text)) return undefined;
        let current: ts.Node | undefined = expression.parent;
        while (current) {
          const map = scopes.get(current);
          if (map?.has(expression.text)) { const value = map.get(expression.text); return typeof value === 'string' ? value : value ? origin(value, depth + 1) : undefined; }
          current = current.parent;
        }
        return undefined;
      }
      if (ts.isPropertyAccessExpression(expression)) {
        const parent = origin(expression.expression, depth + 1);
        return parent?.startsWith('module:') ? parent + '#' + expression.name.text : undefined;
      }
      if (ts.isCallExpression(expression)) {
        if (ts.isIdentifier(expression.expression) && expression.expression.text === 'require' && !shadowedRequire
          && expression.arguments[0] && ts.isStringLiteralLike(expression.arguments[0]) && isBuiltin(expression.arguments[0].text)) return 'module:' + expression.arguments[0].text.replace(/^node:/u, '');
        if (origin(expression.expression, depth + 1) === 'module:module#createRequire' && expression.arguments.length === 1
          && expression.arguments[0].getText(source) === 'import.meta.url') return 'anchored-require';
      }
      return undefined;
    };

    const unknown = (reason: string, node: ts.Node = source) => {
      pending.add(reason); uncertain = true;
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      if (diagnostics.length < 10000) diagnostics.push({reason, from: name, line: position.line + 1, column: position.character + 1, expression: node.getText(source).slice(0, 400)});
    };
    const dependency = (node: ts.Node | undefined, edgeMode: Mode, conditional: boolean) => {
      if (edgeMode === 'require' && shadowedRequire && !(node?.parent && ts.isCallExpression(node.parent) && origin(node.parent.expression) === 'anchored-require')) { unknown('noncanonical-require-binding-unverified', node); return; }
      if (!node || !ts.isStringLiteralLike(node)) { unknown('computed-module-resolution-unverified', node); return; }
      const request = node.text;
      if (request === 'bun:sqlite') {
        if (material.runtime !== 'bun') { if (conditional) { unknown('runtime-conditional-builtin-unverified', node); return; } fail('Bun-only builtin on Node'); }
        record({ from: name, request, kind: edgeMode, builtin: request }); return;
      }
      if (isBuiltin(request)) { record({ from: name, request, kind: edgeMode, builtin: request }); return; }
      if (request.startsWith('node:')) fail('unknown Node builtin');
      let resolved: string;
      try { resolved = resolve(name, request, edgeMode); } catch (error) {
        if (error instanceof ResolutionPending) { unknown(error.message, node); record({ from: name, request, kind: edgeMode }); return; }
        if (conditional && /dependency absent from packed root|missing packed runtime member|package subpath is not exported/u.test((error as Error).message)) {
          const scope = packageScope(name);
          const peer = request.startsWith('@') ? request.split('/').slice(0, 2).join('/') : request.split('/')[0];
          const optionalPeer = typeof scope.manifest.peerDependencies?.[peer] === 'string' && scope.manifest.peerDependenciesMeta?.[peer]?.optional === true;
          unknown(optionalPeer ? 'optional-peer-capability-required:' + peer : 'conditional-dependency-requiredness-unverified', node);
          record({ from: name, request, kind: edgeMode, ...(optionalPeer ? {optionalPeer: true} : {}) }); return;
        }
        throw error;
      }
      if (edgeMode === 'import' && resolved.endsWith('.json')) unknown('JSON-import-runtime-attributes-unverified', node);
      record({ from: name, request, kind: edgeMode, resolved }); add(resolved, edgeMode);
    };
    const visit = (node: ts.Node, conditional = false): void => {
      const nested = conditional || ts.isFunctionLike(node) || ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isTryStatement(node)
        || ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind);
      if (ts.isImportDeclaration(node)) { if (!node.importClause?.isTypeOnly) dependency(node.moduleSpecifier, 'import', false); }
      else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) dependency(node.moduleSpecifier, 'import', false);
      else if (ts.isCallExpression(node)) {
        const fn = node.expression;
        if (fn.kind === ts.SyntaxKind.ImportKeyword) dependency(node.arguments[0], 'import', nested);
        else if (origin(fn) === 'anchored-require') dependency(node.arguments[0], 'require', nested);
        else if (ts.isIdentifier(fn) && fn.text === 'require') dependency(node.arguments[0], 'require', nested);
        else if (ts.isPropertyAccessExpression(fn) && ts.isIdentifier(fn.expression) && fn.expression.text === 'require' && fn.name.text === 'resolve') dependency(node.arguments[0], 'require', nested);
        else if (ts.isPropertyAccessExpression(fn) && fn.name.text === 'require') unknown('nonlocal-require-binding-unverified', node);
        else if (origin(fn) === 'module:module#createRequire' && node.arguments.length === 1 && node.arguments[0].getText(source) === 'import.meta.url') { /* bound factory; its consumers are inspected */ }
        else if (ts.isIdentifier(fn) && ['eval', 'Function', 'createRequire'].includes(aliases.get(fn.text) ?? fn.text)) unknown('dynamic-code-or-require-scope-unverified', node);
        else if (ts.isPropertyAccessExpression(fn) && resourceFunctions.has(fn.name.text)
          || ts.isIdentifier(fn) && resourceFunctions.has(aliases.get(fn.text) ?? fn.text)) {
          // RegExp.exec parses text; it is not child_process.exec.
          if (ts.isPropertyAccessExpression(fn) && fn.name.text === 'exec' && !origin(fn)?.startsWith('module:child_process#')) {
            ts.forEachChild(node, child => visit(child, nested)); return;
          }
          const argument = node.arguments[0];
          const binding = origin(fn);
          const dataRead = Boolean(binding && /^module:fs(?:\/promises)?#/u.test(binding));
          if (dataRead && !['spawn', 'spawnSync', 'exec', 'execFile', 'fork'].includes(ts.isPropertyAccessExpression(fn) ? fn.name.text : ts.isIdentifier(fn) ? aliases.get(fn.text) ?? fn.text : '')) {
            const position = source.getLineAndCharacterOfPosition(node.getStart(source));
            if (runtimeDataAccess.length < 10000) runtimeDataAccess.push({from: name, line: position.line + 1, expression: node.getText(source).slice(0, 400)});
            if (argument && ts.isStringLiteralLike(argument) && /^\.\.?\//u.test(argument.text)) unknown('relative-filesystem-resource-scope-unverified', node);
          } else if (!argument || !ts.isNewExpression(argument) || argument.expression.getText(source) !== 'URL') unknown('resource-or-child-lookup-ownership-unverified', node);
        }
      } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.expression.text === 'Function' || node.expression.text === 'Worker') unknown('computed-worker-or-code-unverified', node);
        if (node.expression.text === 'URL' && node.arguments?.[1]?.getText(source) === 'import.meta.url') {
          const argument = node.arguments[0];
          if (!ts.isStringLiteralLike(argument)) unknown('computed-package-resource-unverified', node);
          else {
            if (!argument.text.startsWith('.')) unknown('resource-URL-ownership-unverified', node);
            else {
              const resolved = boundary(path.posix.join(path.posix.dirname(name), argument.text));
              if (!files.has(resolved)) {
                if (!directories.has(resolved)) fail('missing packed resource: ' + resolved);
                unknown('directory-resource-lookup-unverified', node);
              }
              record({ from: name, request: argument.text, kind: 'resource', resolved });
            }
          }
        }
      }
      if (ts.isIdentifier(node) && ['require', 'eval'].includes(node.text)
        && !(ts.isCallExpression(node.parent) && node.parent.expression === node)
        && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node && node.parent.initializer && origin(node.parent.initializer) === 'anchored-require')
        && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && node.parent.name.text === 'resolve')) unknown('indirect-code-loader-binding-unverified', node);
      if (ts.isIdentifier(node) && origin(node) === 'anchored-require'
        && !(ts.isCallExpression(node.parent) && node.parent.expression === node)
        && !(ts.isVariableDeclaration(node.parent) && (node.parent.name === node || node.parent.initializer === node))) unknown('escaped-anchored-loader-unverified', node);
      ts.forEachChild(node, child => visit(child, nested));
    };
    visit(source);
    if (mode === 'require' && name.endsWith('.mjs')) pending.add('actual-require-ESM-interop-unverified');
  }
  // Lazy related mounts can add native files and nested package manifests
  // during traversal. Only this final graph can establish inventory facts.
  const graph = inspectRuntimeGraph([...files.values()].filter(file => !/^package\/(?:sources?|provenance|licenses)\//u.test(file.path)), context.target, reason => pending.add(reason));
  for (const name of graph.nativeMembers) checkNative(files.get(name)!);
  for (const file of files.values()) {
    if (!/^package\/(?:sources?|provenance|licenses)\//u.test(file.path) && (file.mode & 0o111) && !script(file.path) && (file.readPrefix ? file.readPrefix() : file.content.subarray(0, 2)).toString() === '#!' && !launchers.has(file.path)) pending.add('executable-script-interpreter-unverified');
  }
  if (graph.unknownIdentities.length) pending.add('packed-dependency-identity-unverified');
  if (graph.duplicateIdentities.length) pending.add('duplicate-physical-package-identity-unverified');
  facts.packageIdentityDeduplicated = graph.unknownIdentities.length === 0 && graph.duplicateIdentities.length === 0;
  facts.unvisitedScripts = [...files.keys()].filter(name => script(name) && !/^package\/(?:sources?|provenance|licenses)\//u.test(name) && !parsedScripts.has(name)).sort();
  if (facts.unvisitedScripts.length) { pending.add('unvisited-runtime-script-members'); uncertain = true; }
  const references = material.metafiles ?? [];
  if (!Array.isArray(references) || references.length > 16) fail('invalid metafile references');
  let materialBytes = 0; const seen = new Set<string>();
  for (const ref of references) {
    if (!ref || !safeMaterialPath(ref.path) || !/^[a-f0-9]{64}$/u.test(ref.sha256) || seen.has(ref.path)) fail('invalid metafile reference');
    seen.add(ref.path); const bytes = bound?.metafiles.get(ref.path)?.read() ?? (collected ? collected.readProducerOriginal(ref.path, 8 * 1024 ** 2) : context.readOriginal(ref));
    if (!Buffer.isBuffer(bytes)) fail('metafile original is not bytes');
    if (bytes.length > 8 * 1024 ** 2 || (materialBytes += bytes.length) > 16 * 1024 ** 2) fail('metafile byte budget exceeded');
    if (hash(bytes) !== ref.sha256) fail('metafile original hash mismatch');
    const value = JSON.parse(bytes.toString('utf8'));
    if (!object(value) || !object(value.inputs) || !object(value.outputs)) pending.add('metafile-format-unverified');
    // Source graph imports (including relative externals) are not runtime
    // imports. Only the actual packed output AST above contributes edges.
    facts.originalMetafilesRehashed++;
  }
  if (context.archive && hash(context.archive) !== archiveHash) fail('archive changed during observation');
  facts.literalResolutionVerified = !uncertain && facts.entrypoints.length > 0;
  facts.inspectedScripts = [...new Set(facts.inspectedScripts)].sort(); facts.nativeTargetsChecked.sort();
  facts.runtimeImportsVerified = facts.literalResolutionVerified;
  facts.dataAndNativeResolutionVerified = graph.nativeMembers.every(name => facts.nativeTargetsChecked.includes(name))
    && ![...pending].some(reason => /resource|native|worker|child|interpreter/u.test(reason));
  facts.runtimeClosureVerified = facts.physicalInventoryVerified && facts.runtimeImportsVerified && facts.dataAndNativeResolutionVerified
    && facts.packageIdentityDeduplicated && facts.artifactCustodyVerified && facts.derivedSourceVerified && pending.size === 0;
  return finish();
}

/** Operational entry: ignores caller material JSON and derives every reference
 * from real collector/source capabilities. Neither a whole tgz nor an empty
 * surrogate Buffer is created for a platform product. */
export function verifyCollectedRuntimeClosure(_evidence: unknown, context: CollectedAdmissionContext): RuntimeClosureResult {
  const unavailable = (reason: string): RuntimeClosureResult => {
    const result = inspectRuntimeClosure(undefined, context);
    return { ...result, reason, pending: [reason] };
  };
  const view = collectedArtifactView(context.collectedArtifact), source = derivedSourceView(context.derivedSource);
  const material = publicationMaterialView(context.collectedArtifact);
  if (!view || !material) return unavailable('controlled-runtime-publication-materials-required');
  const identity = view.identity;
  if (identity.sourceSha !== context.sourceSha || identity.package !== context.package || identity.version !== context.version
    || identity.target !== context.target || material.producer.runHeadSha !== context.runHeadSha
    || !isDeepStrictEqual(material.identity, identity)) fail('collected runtime context identity mismatch');
  if (!source || source.sourceSha !== identity.sourceSha) return unavailable('immutable-runtime-source-capability-required');
  const producer = material.readOriginal(material.producerReceipt.path, 4 * 1024 ** 2);
  if (producer.length !== material.producerReceipt.bytes || hash(producer) !== material.producerReceipt.sha256) fail('runtime producer original binding mismatch');
  const pending: string[] = [];
  const metafiles = new Map<string, { sha256: string; read(): Buffer }>();
  const readPortable = (sourceExecution as unknown as { portableSourceMaterialView?: (artifact: unknown) => {
    identity: { sourceSha: string; package: string; version: string; archiveSha256: string };
    outputs: readonly { path: string; bytes: number; sha256: string; inputUniverseComplete: boolean;
      metafile: { path: string; bytes: number; sha256: string }; readMetafile(): Buffer }[];
    pending: readonly string[];
  } | undefined }).portableSourceMaterialView;
  const graph = readPortable?.(context.collectedArtifact);
  if (identity.target !== undefined) {
    const central = createRequire(import.meta.url)('./index.ts') as { collectedPublicationSourceMaterials?: (artifact: unknown, source: unknown) => unknown };
    const moduleSource = moduleSourceMaterialView(central.collectedPublicationSourceMaterials?.(context.collectedArtifact, context.derivedSource));
    if (!moduleSource) pending.push('private-module-runtime-source-materials-required');
    else {
      if (moduleSource.sourceSha !== identity.sourceSha) fail('module runtime source revision mismatch');
      const outputs = new Map(moduleSource.outputs.map(row => [row.path, row]));
      if (outputs.size !== view.members.length) fail('module runtime source output inventory mismatch');
      for (const row of view.members) {
        const output = outputs.get(row.path);
        if (!output || output.bytes !== row.bytes || output.sha256 !== row.sha256 || output.mode !== row.mode)
          fail('module runtime source output differs from collected member');
      }
      const mapped = new Set<string>();
      for (const row of moduleSource.transpiledOutputs) {
        if (mapped.has(row.path) || !outputs.has(row.path) || !moduleSource.trackedSourcePaths.includes(row.sourcePath))
          fail('module runtime compiler source/output binding mismatch');
        source.readTracked(row.sourcePath); mapped.add(row.path);
      }
      for (const row of moduleSource.outputs) if (script(row.path) && !/^(?:sources?|provenance|licenses)\//u.test(row.path)
        && !row.path.startsWith('node_modules/') && !mapped.has(row.path))
        pending.push('module-runtime-output-source-graph-required:' + row.path);
    }
  } else if (!graph) pending.push('private-portable-runtime-source-graph-required');
  if (graph) {
    if (graph.identity.sourceSha !== identity.sourceSha || graph.identity.package !== identity.package
      || graph.identity.version !== identity.version || graph.identity.archiveSha256 !== identity.archiveSha256) fail('runtime source graph identity mismatch');
    if (!graph.outputs.length || graph.outputs.length > 64) fail('runtime source output graph bound');
    pending.push(...graph.pending);
    for (const output of graph.outputs) {
      const member = view.members.find(row => row.path === output.path);
      if (!member || member.bytes !== output.bytes || member.sha256 !== output.sha256) fail('runtime metafile output differs from collected member');
      if (!output.inputUniverseComplete) pending.push('runtime-bundle-input-originals-unresolved:' + output.path);
      const ref = output.metafile;
      if (!safeMaterialPath(ref.path) || !/^[a-f0-9]{64}$/u.test(ref.sha256) || ref.bytes > 8 * 1024 ** 2) fail('runtime source metafile bound');
      const read = () => {
        const bytes = output.readMetafile();
        if (!Buffer.isBuffer(bytes) || bytes.length !== ref.bytes || hash(bytes) !== ref.sha256) fail('runtime source metafile original mismatch');
        const metadata = JSON.parse(bytes.toString());
        const target = output.path.startsWith('dist/') ? './' + output.path.slice(5) : './' + output.path;
        if (!object(metadata.inputs) || !object(metadata.outputs) || Object.keys(metadata.outputs).length !== 1
          || metadata.outputs[target]?.bytes !== output.bytes) fail('runtime metafile compiled output binding mismatch');
        return bytes;
      };
      const previous = metafiles.get(ref.path);
      if (previous && previous.sha256 !== ref.sha256) fail('runtime metafile original collision');
      metafiles.set(ref.path, { sha256: ref.sha256, read });
    }
  }
  try {
    const members = collectedRuntimeMembers(view);
    const evidence: Materials = { schemaVersion: 1, kind: 'independent-runtime-closure-materials', runtime: 'node',
      product: { sourceSha: identity.sourceSha, runHeadSha: material.producer.runHeadSha, package: identity.package, version: identity.version,
        ...(identity.target ? { target: identity.target } : {}), archive: { bytes: identity.archiveBytes, sha256: identity.archiveSha256, integrity: identity.integrity } },
      metafiles: [...metafiles].map(([path, row]) => ({ path, sha256: row.sha256 })) };
    const bound = { view, members, metafiles, pending };
    const node = inspectRuntimeClosure(evidence, context, bound);
    const bun = inspectRuntimeClosure({ ...evidence, runtime: 'bun' }, context, bound);
    const gaps = [...new Set([...node.pending.map(reason => 'node:' + reason), ...bun.pending.map(reason => 'bun:' + reason)])].sort();
    const facts = { ...node.facts };
    for (const key of ['physicalInventoryVerified', 'runtimeImportsVerified', 'dataAndNativeResolutionVerified', 'packageIdentityDeduplicated',
      'artifactCustodyVerified', 'runtimeClosureVerified', 'derivedSourceVerified', 'archiveBindingVerified', 'manifestInventoryVerified', 'literalResolutionVerified'] as const)
      facts[key] = node.facts[key] && bun.facts[key];
    for (const key of ['entrypoints', 'inspectedScripts', 'nativeTargetsChecked', 'unvisitedScripts'] as const)
      facts[key] = [...new Set([...node.facts[key], ...bun.facts[key]])].sort();
    facts.originalMetafilesRehashed += bun.facts.originalMetafilesRehashed;
    return { status: facts.runtimeClosureVerified ? 'verified' : 'pending', reason: gaps.length ? gaps.join('; ')
      : 'Actual collected Node and Bun runtime closure inspected; source/native/legal admissions remain separate', pending: gaps,
      edges: [...new Map([...node.edges, ...bun.edges].map(edge => [JSON.stringify(edge), edge])).values()],
      diagnostics: [...node.diagnostics, ...bun.diagnostics], runtimeDataAccess: [...node.runtimeDataAccess, ...bun.runtimeDataAccess], facts };
  } catch (error) {
    if (!(error instanceof RuntimeReadPending)) throw error;
    return unavailable(error.message);
  }
}
