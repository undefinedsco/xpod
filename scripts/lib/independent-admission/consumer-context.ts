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
   const value = MODE === 'esm' ? await import(pathToFileURL(location).href) : require(location);
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

/** No network/install and no injected command or transport. Pending profiles do
 * not become passing observations. Unknown owned closure retains the temp root. */
export async function observeClientConsumer(input: {
  artifact: unknown; peers?: unknown[]; stage: 'prepublish' | 'postpublish';
  registryObservation?: unknown; evidenceDirectory: string;
}): Promise<ClientConsumerObservation> {
  const artifact = collectedArtifactView(input.artifact);
  if (!artifact) return fail('real collected artifact capability required');
  if (!['prepublish', 'postpublish'].includes(input.stage)) fail('invalid stage');
  if (input.stage === 'postpublish') {
    const registry = registryArtifactView(input.registryObservation);
    if (!registry || !isDeepStrictEqual(registry.identity, artifact.identity)) fail('matching real registry readback required');
  }
  const plan = planClientConsumerProfiles(input.artifact, input.peers);
  const peerViews = (input.peers ?? []).map(value => collectedArtifactView(value)!);
  const runnable = plan.profiles.filter(profile => profile.status === 'planned-not-executed');
  const selected = (profile: typeof plan.profiles[number]) => [artifact, ...profile.installs.map(row => peerViews.find(peer => peer.identity.package === row.package)!)];
  const bytes = runnable.flatMap(selected).reduce((sum, view) => sum + view.members.reduce((total, row) => total + row.bytes, 0), 0);
  // Reserve fixed inputs/probes/raw logs/receipts inside the total write budget.
  if (bytes > 14 * 1024 ** 2) fail('materialization exceeds 16MiB total write budget');
  const runtimes = { node: runtimePath('node'), bun: runtimePath('bun') };
  fs.mkdirSync(input.evidenceDirectory, { recursive: true });
  const evidence = fs.realpathSync(input.evidenceDirectory);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-client-consumer-'));
  let retain = false;
  const deadline = Date.now() + 20_000;
  const results: { profile: string; verified: boolean; pending: readonly string[] }[] = [];
  try {
    for (const [index, profile] of plan.profiles.entries()) {
      if (profile.status === 'blocked') { results.push({ profile: profile.profile, verified: false, pending: profile.pending }); continue; }
      const cwd = path.join(root, 'profile-' + index);
      fs.mkdirSync(cwd); fs.mkdirSync(path.join(cwd, 'home')); fs.mkdirSync(path.join(cwd, 'tmp'));
      for (const view of selected(profile)) materialize(cwd, view);
      const expected = { schemaVersion: 1, name: artifact.identity.package, version: artifact.identity.version, exports: profile.exports };
      const probeInput = JSON.stringify({ ...expected,
        packageRoot: path.join(cwd, 'node_modules', artifact.identity.package),
        absentPeers: plan.profiles[1].peers.filter(peer => peer.optional && !profile.peers.some(row => row.name === peer.name)).map(peer => peer.name),
      });
      if (Buffer.byteLength(probeInput) > 32768) fail('probe declaration budget exceeded');
      fs.writeFileSync(path.join(cwd, 'probe-input.json'), probeInput, { flag: 'wx' });
      for (const mode of ['esm', 'cjs'] as const) fs.writeFileSync(path.join(cwd, 'probe.' + (mode === 'esm' ? 'mjs' : 'cjs')), clientConsumerProbeSource(mode), { flag: 'wx' });
      for (const matrix of profile.matrix) {
        const timeoutMs = Math.min(1600, deadline - Date.now() - 2200);
        if (timeoutMs <= 0) fail('total consumer deadline exhausted');
        const label = `profile-${index}-${matrix.runtime}-${matrix.module}`;
        const env: NodeJS.ProcessEnv = { PATH: path.dirname(runtimes[matrix.runtime]), HOME: path.join(cwd, 'home'), TMPDIR: path.join(cwd, 'tmp'), TMP: path.join(cwd, 'tmp'), TEMP: path.join(cwd, 'tmp'), LANG: 'C.UTF-8' };
        let row: any;
        try { row = await runPublicationCommand(runtimes[matrix.runtime], ['probe.' + (matrix.module === 'esm' ? 'mjs' : 'cjs')], { cwd, env, evidence, label, timeoutMs, rawLimit: 65536 }); }
        catch (error: any) { retain = !error.outcome?.groupAbsent || !error.outcome?.actualClose || !error.outcome?.actualWait; throw error; }
        if (row.code !== 0 || !row.actualWait || !row.actualClose || !row.groupAbsent || !row.rawComplete
          || !row.rawClosedBeforeHash || !row.pipeEOF?.every(Boolean)) { retain = true; fail('unverified owned closure'); }
        for (const raw of row.raw) {
          const bytes = fs.readFileSync(path.join(evidence, raw.path));
          if (bytes.length !== raw.bytes || hash(bytes) !== raw.sha256) fail('closed raw changed after command');
        }
        const stdout = fs.readFileSync(path.join(evidence, row.raw[0].path), 'utf8');
        if (!isDeepStrictEqual(JSON.parse(stdout), expected)) fail('probe result mismatch');
        const receipt = JSON.parse(fs.readFileSync(path.join(evidence, label + '.receipt.json'), 'utf8'));
        if (!isDeepStrictEqual(receipt, row)) fail('receipt changed after command');
      }
      results.push({ profile: profile.profile, verified: true, pending: [] });
    }
    const view: ClientConsumerView = Object.freeze({ identity: Object.freeze({ ...artifact.identity }), stage: input.stage,
      baseVerified: results[0]?.verified === true, fullVerified: results[1]?.verified === true,
      allProfilesVerified: results.length === 2 && results.every(row => row.verified),
      profiles: Object.freeze(results.map(row => Object.freeze({ ...row, pending: Object.freeze([...row.pending]) }))),
      scope: 'local exact-artifact imports/exports smoke; no registry install, authentication, Pod or Chat verification',
    });
    fs.writeFileSync(path.join(evidence, 'consumer-observation.json'), JSON.stringify(view, null, 2), { flag: 'wx' });
    const capability = Object.freeze({}) as ClientConsumerObservation;
    issued.set(capability, view);
    return capability;
  } finally {
    if (!retain) fs.rmSync(root, { recursive: true, force: true });
    else fs.writeFileSync(path.join(evidence, 'retained-root.json'), JSON.stringify({ root, reason: 'owned closure unknown' }), { flag: 'wx' });
  }
}
