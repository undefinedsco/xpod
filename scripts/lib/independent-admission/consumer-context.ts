import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { collectedArtifactView } from './artifact-collector';
import { registryArtifactView } from './registry-context';
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
  readonly profiles: readonly { readonly profile: string; readonly verified: boolean; readonly pending: readonly string[] }[];
  readonly scope: 'local exact-artifact imports/exports smoke; no registry install, authentication, Pod or Chat verification';
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
 const results = [];
 for (const subpath of spec.exports) {
   const name = spec.name + (subpath === '.' ? '' : subpath.slice(1));
   const resolved = MODE === 'esm' ? import.meta.resolve(name) : require.resolve(name);
   const location = fs.realpathSync(MODE === 'esm' ? require('node:url').fileURLToPath(resolved) : resolved);
   if (!location.startsWith(root + path.sep)) throw Error('export resolved outside materialized package');
   const value = location.endsWith('.json') ? require(location) : MODE === 'esm' ? await import(pathToFileURL(location).href) : require(location);
   if (value == null || (typeof value !== 'function' && Object.keys(value).length === 0)) throw Error('empty exports');
   results.push(subpath);
 }
 process.stdout.write(JSON.stringify({schemaVersion:1, name:manifest.name, version:manifest.version, exports:results}) + '\n');
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
  artifact: unknown; peers?: unknown[]; stage: 'prepublish' | 'postpublish';
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

/** Client and CLI use the same supervisor, temp-root lifecycle, byte budget,
 * evidence validation and private issuer. There is no caller execution hook. */
async function executeConsumer(input: ConsumerInput, artifact: CollectedArtifactView, profiles: readonly Profile[]): Promise<ClientConsumerObservation> {
  const runnable = profiles.filter(profile => profile.pending.length === 0);
  const bytes = runnable.flatMap(profile => profile.artifacts).reduce((sum, view) => sum + view.members.reduce((total, row) => total + row.bytes, 0), 0);
  if (bytes > 14 * 1024 ** 2) fail('materialization exceeds 16MiB total write budget');
  const runtimes = { node: runtimePath('node'), bun: runtimePath('bun') };
  fs.mkdirSync(input.evidenceDirectory, { recursive: true });
  const evidence = fs.realpathSync(input.evidenceDirectory);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-consumer-'));
  let retain = false;
  const deadline = Date.now() + 20_000;
  const results: { profile: string; verified: boolean; pending: readonly string[] }[] = [];
  try {
    for (const [index, profile] of profiles.entries()) {
      if (profile.pending.length) { results.push({ profile: profile.profile, verified: false, pending: profile.pending }); continue; }
      const cwd = path.join(root, 'profile-' + index);
      fs.mkdirSync(cwd); fs.mkdirSync(path.join(cwd, 'home')); fs.mkdirSync(path.join(cwd, 'tmp'));
      for (const view of profile.artifacts) materialize(cwd, view);
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
      async function command(runtime: 'node' | 'bun', label: string, args: string[]): Promise<string> {
        const timeoutMs = Math.min(1600, deadline - Date.now() - 2200);
        if (timeoutMs <= 0) return fail('total consumer deadline exhausted');
        const env: NodeJS.ProcessEnv = { PATH: runtimeBins[runtime], HOME: path.join(cwd, 'home'), TMPDIR: path.join(cwd, 'tmp'), TMP: path.join(cwd, 'tmp'), TEMP: path.join(cwd, 'tmp'), LANG: 'C.UTF-8' };
        let row: any;
        try { row = await runPublicationCommand(runtimes[runtime], args, { cwd, env, evidence, label, timeoutMs, rawLimit: 65536 }); }
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
      if (profile.bins) {
        if (profile.bins.length !== 1) fail('CLI consumer currently supports one declared binary within eight-command budget');
        const bin = profile.bins[0]!;
        if (!bin.startsWith('./') || bin.includes('\\') || bin.slice(2).split('/').some(part => !part || part === '.' || part === '..')) fail('unsafe CLI bin path');
        const location = fs.realpathSync(path.join(packageRoot, bin));
        if (!location.startsWith(fs.realpathSync(packageRoot) + path.sep)) fail('CLI bin escapes package');
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
        for (const runtime of ['node', 'bun'] as const) {
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
          for (const runtime of ['node', 'bun'] as const) {
            const stdout = await command(runtime, `profile-${index}-${runtime}-${mode}`, [script]);
            if (!isDeepStrictEqual(JSON.parse(stdout), expected)) fail('probe result mismatch');
          }
        }
      }
      results.push({ profile: profile.profile, verified: true, pending: [] });
    }
    const view: ClientConsumerView = Object.freeze({ identity: Object.freeze({ ...artifact.identity }), stage: input.stage,
      baseVerified: results[0]?.verified === true, fullVerified: results[1]?.verified === true,
      allProfilesVerified: results.length === 2 && results.every(row => row.verified),
      registryInstallVerified: false,
      profiles: Object.freeze(results.map(row => Object.freeze({ ...row, pending: Object.freeze([...row.pending]) }))),
      scope: 'local exact-artifact imports/exports smoke; no registry install, authentication, Pod or Chat verification',
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

export async function observeClientConsumer(input: ConsumerInput): Promise<ClientConsumerObservation> {
  const artifact = checkedArtifact(input);
  const plan = planClientConsumerProfiles(input.artifact, input.peers);
  const peerViews = (input.peers ?? []).map(value => collectedArtifactView(value)!);
  return executeConsumer(input, artifact, plan.profiles.map(profile => ({ profile: profile.profile, pending: profile.pending,
    artifacts: [artifact, ...profile.installs.map(row => peerViews.find(peer => peer.identity.package === row.package)!)],
    exportsByMode: { esm: profile.exports, cjs: profile.exports },
    absentPeers: plan.profiles[1].peers.filter(peer => peer.optional && !profile.peers.some(row => row.name === peer.name)).map(peer => peer.name),
  })));
}

export async function observeCliConsumer(input: ConsumerInput & { client: unknown }): Promise<ClientConsumerObservation> {
  const artifact = checkedArtifact(input);
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
  const extraDependencies = Object.keys(manifest.dependencies ?? {}).filter(name => name !== client.identity.package);
  const profiles: Profile[] = clientPlan.profiles.map((profile, index) => {
    const selectedPeers = peerNames.filter(name => index === 1 || manifest.peerDependenciesMeta?.[name]?.optional !== true);
    const pending = [...profile.pending, ...extraDependencies.map(name => 'Uncollected required dependency: ' + name)];
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
  return executeConsumer(input, artifact, profiles);
}
