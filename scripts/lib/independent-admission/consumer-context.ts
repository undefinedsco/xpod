import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { collectedArtifactView } from './artifact-collector';
import { registryArtifactView, observeRegistryArtifact } from './registry-context';
import { planClientConsumerProfiles } from './consumer-profiles';
import type { CollectedArtifactIdentity, CollectedArtifactView } from './artifact-contract';
const { runPublicationCommand } = createRequire(import.meta.url)('../afs-publication-command.cjs');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fail = (message: string): never => { throw new Error('Client consumer observation: ' + message); };
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
    | 'actual registry installation and imports/exports smoke; no authentication, Pod or Chat verification';
}
const issued = new WeakMap<object, ClientConsumerView>();
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
function materialize(root: string, artifact: CollectedArtifactView): void {
  if (!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/u.test(artifact.identity.package)) fail('unsafe package name');
  const target = path.join(root, 'node_modules', artifact.identity.package);
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
  artifact: unknown; peers?: unknown[]; dependencies?: unknown[]; stage: 'prepublish' | 'postpublish';
  registryObservation?: unknown; evidenceDirectory: string;
}
interface Profile {
  profile: string; pending: readonly string[]; artifacts: readonly CollectedArtifactView[];
  exportsByMode?: { esm: readonly string[]; cjs: readonly string[] };
  absentPeers: readonly string[];
  bins?: readonly string[];
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
export function verifyInstalledConsumerInventory(cwd: string, artifacts: readonly Pick<CollectedArtifactView, 'identity' | 'members' | 'readMember'>[]) {
  const modulesPath = path.join(cwd, 'node_modules');
  if (fs.lstatSync(modulesPath).isSymbolicLink()) return fail('installed node_modules symlink');
  const modules = fs.realpathSync(modulesPath);
  const names: string[] = [];
  for (const name of fs.readdirSync(modules)) {
    if (name === '.bin') continue;
    const entry = path.join(modules, name);
    if (fs.lstatSync(entry).isSymbolicLink()) fail('installed package symlink');
    if (name.startsWith('@')) for (const member of fs.readdirSync(entry)) names.push(name + '/' + member);
    else names.push(name);
  }
  if (!isDeepStrictEqual(names.sort(), artifacts.map(view => view.identity.package).sort())) fail('uncollected installed package');
  const inventories = artifacts.map(view => {
    const root = path.join(modules, view.identity.package);
    const expected = new Map(view.members.map(member => [member.path, member]));
    const files: { path: string; bytes: number; sha256: string; mode: number }[] = [];
    function walk(directory: string, prefix: string) {
      for (const name of fs.readdirSync(directory)) {
        const relative = prefix + name, absolute = path.join(directory, name), stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) fail('installed package member symlink');
        if (stat.isDirectory()) { walk(absolute, relative + '/'); continue; }
        if (!stat.isFile()) fail('nonregular installed package member');
        const member = expected.get(relative);
        if (!member || stat.size !== member.bytes || (stat.mode & 0o777) !== (member.mode & 0o777)) return fail('installed package inventory or mode mismatch');
        const bytes = fs.readFileSync(absolute);
        if (hash(bytes) !== member.sha256) fail('installed package bytes mismatch');
        files.push({ path: relative, bytes: bytes.length, sha256: hash(bytes), mode: stat.mode & 0o777 });
      }
    }
    walk(root, '');
    if (files.length !== expected.size) fail('incomplete installed package inventory');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (manifest.name !== view.identity.package || manifest.version !== view.identity.version) fail('installed manifest identity mismatch');
    return { identity: view.identity, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
  });
  // Bun generates executable links outside package payloads. Verify each against
  // a declared, already hash-checked member and retain as installation metadata.
  const bins = path.join(modules, '.bin');
  const links: { name: string; text: string; target: string; memberSha256: string }[] = [];
  if (fs.existsSync(bins)) {
    if (fs.lstatSync(bins).isSymbolicLink()) fail('installed bin directory symlink');
    const expected = new Map<string, string>();
    for (const view of artifacts) {
      const manifest = JSON.parse(view.readMember('package.json', 1024 * 1024).toString());
      const declarations = typeof manifest.bin === 'string'
        ? { [view.identity.package.split('/').pop()!]: manifest.bin } : manifest.bin ?? {};
      for (const [name, target] of Object.entries(declarations)) {
        if (typeof target !== 'string' || !target || path.isAbsolute(target) || target.includes('\\')
          || target.split('/').some(part => part === '..')) return fail('unsafe installed bin declaration');
        const memberPath = target.startsWith('./') ? target.slice(2) : target;
        if (!view.members.some(member => member.path === memberPath) || expected.has(name)) fail('ambiguous installed bin member');
        expected.set(name, fs.realpathSync(path.join(modules, view.identity.package, memberPath)));
      }
    }
    for (const name of fs.readdirSync(bins)) {
      const entry = path.join(bins, name), target = expected.get(name);
      if (!fs.lstatSync(entry).isSymbolicLink() || !target || fs.realpathSync(entry) !== target) return fail('unbound installed executable link');
      const member = inventories.flatMap(row => row.files.map(file => ({ ...file, absolute: path.join(modules, row.identity.package, file.path) })))
        .find(file => file.absolute === target);
      if (!member) return fail('installed executable target not inventoried');
      links.push({ name, text: fs.readlinkSync(entry), target, memberSha256: member.sha256 });
    }

  }
  return { inventories, generatedBinLinks: links };
}

/** Client and CLI use the same supervisor, temp-root lifecycle, byte budget,
 * evidence validation and private issuer. There is no caller execution hook. */
async function executeConsumer(input: ConsumerInput, artifact: CollectedArtifactView, profiles: readonly Profile[], preparation: 'archive' | 'registry' = 'archive'): Promise<ClientConsumerObservation> {
  // Both strategies require the same collected dependency closure. Registry adds
  // real readback/installation; archive only materializes these verified bytes.
  profiles = registryProfiles(profiles, input.dependencies);
  const { executionProfiles, runnable, writeEstimate } = executionProfilesAndBudget(profiles, preparation);
  if (preparation === 'registry') {
    // The primary was checked by checkedArtifact. Every additional exact artifact
    // receives the same fixed central GET-only readback before installation.
    const readbackDeadline = Date.now() + 180_000;
    const observed = new Set<string>([artifact.identity.package]);
    for (const profile of runnable) for (const dependency of profile.artifacts) {
      if (observed.has(dependency.identity.package)) continue;
      const capability = (input as ConsumerInput & { client?: unknown }).client;
      const candidates = [capability, ...(input.peers ?? []), ...(input.dependencies ?? [])];
      const original = candidates.find(value => collectedArtifactView(value) === dependency);
      if (!original) fail('dependency readback capability unavailable');
      if (Date.now() >= readbackDeadline) fail('dependency registry readback total deadline exceeded');
      await observeRegistryArtifact(original);
      observed.add(dependency.identity.package);
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
      if (preparation === 'archive') for (const view of profile.artifacts) materialize(cwd, view);
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
          const bytes = fs.readFileSync(path.join(evidence, raw.path));
          if (bytes.length !== raw.bytes || hash(bytes) !== raw.sha256) fail('closed raw changed after command');
        }
        const receipt = JSON.parse(fs.readFileSync(path.join(evidence, label + '.receipt.json'), 'utf8'));
        if (!isDeepStrictEqual(receipt, row)) fail('receipt changed after command');
        return fs.readFileSync(path.join(evidence, row.raw[0].path), 'utf8');
      }
      if (preparation === 'registry') {
        const dependencies = Object.fromEntries(profile.artifacts.map(view => [view.identity.package, view.identity.version]));
        const generated = { name: 'xpod-independent-registry-consumer', version: '0.0.0', private: true, dependencies, overrides: dependencies };
        fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(generated), { flag: 'wx' });
        fs.writeFileSync(path.join(cwd, 'bunfig.toml'), '[install]\nregistry = "' + REGISTRY + '"\n', { flag: 'wx' });
        fs.writeFileSync(path.join(evidence, `profile-${index}-generated-package.json`), JSON.stringify(generated, null, 2), { flag: 'wx' });
        await command('bun', `profile-${index}-registry-install`, registryConsumerInstallArguments(path.join(cwd, 'cache')), true);
        const inventory = verifyInstalledConsumerInventory(cwd, profile.artifacts);
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

type RegistryMaterials = Pick<ConsumerInput, 'artifact' | 'peers' | 'dependencies'>;
/** Read-only material readiness, not a release permit or consumer observation. */
function preflightProfiles(profiles: readonly Profile[], dependencies?: unknown[]) {
  const complete = registryProfiles(profiles, dependencies);
  const pending = complete.flatMap(profile => profile.pending.map(reason => profile.profile + ': ' + reason));
  if (pending.length) fail('Registry consumer material gaps: ' + pending.join('; '));
  const { writeEstimate } = executionProfilesAndBudget(complete, 'registry');
  return Object.freeze({ status: 'materials-ready' as const, consumerVerified: false as const, ...writeEstimate });
}
export function preflightRegistryInstalledClientConsumer(input: RegistryMaterials) {
  return preflightProfiles(clientExecutionPlan(input).profiles, input.dependencies);
}
export function preflightRegistryInstalledCliConsumer(input: RegistryMaterials & { client: unknown }) {
  return preflightProfiles(cliExecutionPlan(input).profiles, input.dependencies);
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
