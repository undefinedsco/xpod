import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashBytes, hashFile, verifyBoundFile, type ModuleAdmissionInputs } from './module-admission';
import { isolatedModuleEnvironment } from './module-admission';
import { observeChildLifecycle, reapOwnedGroup } from './platform-admission';

const source = 'b5a058cffa50026702f7679365e7b17e383115d2';
const artifacts = {
  'darwin-arm64': { id: '11640530802', zip: 'e275f3eb04f9a8bc023149353891f42597d3d8cbae5459510031b8c18750dd34', archive: '391ad4b1ecedf0a90be1a2b03661a85e64e426aab7579f64026e15887cce74d8', helper: '608c7e22702049841c1063bea12920fb371b73a3da96a8a917488567ec6de75e' },
  'linux-arm64': { id: '11640947333', zip: 'a8856c145dd3afc363b812affd6286c2f154f888dfe0a22b050de0e2fced0e86', archive: '8caff51560422becda67dc46e59e8fefaf77e7297fe558ac1c36698734311358', helper: 'ece07a199caa2d12493e8a5648b770395922bdcb31001e7eb50599bd960d6e7b' },
} as const;
export function nativeFacts(target: string) {
  if (!(target in artifacts)) throw new Error('unsupported module target');
  const facts = artifacts[target as keyof typeof artifacts]; const prefix = target.split('-')[0].toUpperCase();
  return { source, run: '37977251553', artifactID: facts.id, zipSHA256: facts.zip,
    pins: { PRODUCT_SHA: source, [`${prefix}_ZIP_SHA`]: facts.zip, [`${prefix}_ARCHIVE_SHA`]: facts.archive, [`${prefix}_HELPER_SHA`]: facts.helper } };
}
// Collect actual serialized archive bytes, never a separately trusted staging directory.
const collectArchive = `import tarfile,hashlib,json,sys,posixpath,tempfile
with tarfile.open(sys.argv[1],'r|gz') as t:
 seen=set(); hashes={}; documents={}; sources={}
 for m in t:
  n=m.name.rstrip('/')
  if n in seen or not (n=='package' or n.startswith('package/')) or '..' in n.split('/') or posixpath.isabs(n): raise ValueError('unsafe or duplicate archive member')
  seen.add(n)
  if m.isdir(): continue
  if not m.isfile(): raise ValueError('nonregular archive member')
  h=hashlib.sha256(); chunks=[]; total=0
  nested=tempfile.SpooledTemporaryFile(max_size=8388608) if n=='package/sources/module-source.tar.gz' else None
  f=t.extractfile(m)
  while True:
   b=f.read(1048576)
   if not b: break
   h.update(b); total+=len(b)
   if nested is not None: nested.write(b)
   if n in ['package/package.json','package/provenance/native-reuse.json','package/provenance/module-source-kit.json']:
    if total>16777216: raise ValueError('oversized metadata')
    chunks.append(b)
  hashes[n[8:]]={'sha256':h.hexdigest(),'size':total,'mode':m.mode & 511}
  if chunks: documents[n[8:]]=json.loads(b''.join(chunks))
  if nested is not None:
   nested.seek(0); names=set()
   with tarfile.open(fileobj=nested,mode='r|gz') as nt:
    for sm in nt:
     sn=sm.name.removeprefix('./').rstrip('/')
     if sn in names or '..' in sn.split('/') or posixpath.isabs(sn): raise ValueError('unsafe source member')
     names.add(sn)
     if sm.isdir(): continue
     if not sm.isfile(): raise ValueError('nonregular source member')
     sh=hashlib.sha256(); size=0; sf=nt.extractfile(sm)
     while True:
      b=sf.read(1048576)
      if not b: break
      sh.update(b);size+=len(b)
     sources[sn]={'sha256':sh.hexdigest(),'bytes':size}
   nested.close()
 print(json.dumps({'hashes':hashes,'documents':documents,'sources':sources}))`;
interface Collected { hashes: Record<string, { sha256: string; size: number; mode: number }>; documents: Record<string, any>; sources: Record<string, { sha256: string; bytes: number }> }
export function collectModule(archive: string, target: string, sourceSHA: string, nativeReceipt: string, nativeKit: string) {
  const c = JSON.parse(execFileSync('python3', ['-c', collectArchive, archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })) as Collected;
  return validateCollectedModule(c, target, sourceSHA, nativeReceipt, nativeKit);
}
function validateCollectedModule(c: Collected, target: string, sourceSHA: string, nativeReceipt: string, nativeKit: string) {
  nativeFacts(target);
  const pkg = c.documents['package.json']; const kit = c.documents['provenance/module-source-kit.json']; const reuse = c.documents['provenance/native-reuse.json'];
  if (pkg?.name !== `@undefineds.co/xpod-afs-${target}` || pkg?.xpodModule?.schemaVersion !== 1 || pkg.xpodModule.id !== 'afs'
    || pkg.xpodModule.platform !== target.split('-')[0] || pkg.xpodModule.arch !== 'arm64' || pkg.xpodModule.entry !== 'dist/entry.mjs'
    || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(pkg.version ?? '') || !Array.isArray(pkg.xpodModule.files)) throw new Error('module manifest mismatch');
  const seen = new Set<string>();
  for (const file of pkg.xpodModule.files) {
    const actual = c.hashes[file.path];
    if (seen.has(file.path) || !actual || actual.sha256 !== file.sha256 || actual.size !== file.size || actual.mode !== file.mode) throw new Error('module inventory mismatch');
    seen.add(file.path);
  }
  if (Object.keys(c.hashes).some(name => name !== 'package.json' && !seen.has(name))) throw new Error('unlisted module member');
  const member = (name: string): string => { if (!c.hashes[name]) throw new Error('missing required module member'); return c.hashes[name].sha256; };
  const tree = hashBytes(JSON.stringify(kit?.files));
  if (!Array.isArray(kit?.files) || kit.files.length !== Object.keys(c.sources).length) throw new Error('source archive inventory mismatch');
  const sourceNames = new Set<string>();
  for (const file of kit.files) {
    const actual = c.sources[file.path];
    if (sourceNames.has(file.path) || !actual || actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) throw new Error('source archive inventory mismatch');
    sourceNames.add(file.path);
  }
  if (reuse?.moduleSourceDirty !== false || reuse.moduleSourceSHA !== sourceSHA || reuse.nativeBuildSourceSHA !== source
    || reuse.moduleSourceTreeSHA256 !== tree || kit?.dirty !== false || kit.moduleSourceSHA !== sourceSHA || kit.moduleSourceTreeSHA256 !== tree
    || kit.publicClientPayloadSHA256 !== member('node_modules/@undefineds.co/xpod-cli/dist/client.cjs')
    || member('provenance/native-build.receipt.json') !== nativeReceipt || member('provenance/native-source-kit.json') !== nativeKit
    || member('helper/agentfs-pod') !== artifacts[target as keyof typeof artifacts]?.helper) throw new Error('module provenance mismatch');
  return { name: pkg.name as string, version: pkg.version as string, manifestSHA256: member('package.json'), inventorySHA256: hashBytes(JSON.stringify(pkg.xpodModule.files)),
    sourceTreeSHA256: tree, helperSHA256: member('helper/agentfs-pod'), entrySHA256: member('dist/entry.mjs'), librarySHA256: member('dist/library.cjs'), clientSHA256: member('node_modules/@undefineds.co/xpod-cli/dist/client.cjs') };
}
type Projection = 'string' | 'number' | 'boolean' | { [key: string]: Projection } | readonly [Projection];
const fields = (type: 'string' | 'number' | 'boolean', names: string): Record<string, Projection> => Object.fromEntries(names.split(' ').map(name => [name, type]));
const lifecycle: Projection = { ...fields('number', 'pid exit'), ...fields('boolean', 'exitObserved closeObserved'), signal: 'string' };
const child: Projection = { ...fields('string', 'command state signal groupStateAfterClose stdoutSHA256 stderrSHA256'), code: 'number', rawClosedBeforeHash: 'boolean', lifecycle };
const binding: Record<string, Projection> = { ...fields('string', 'profile moduleSourceSHA nativeBuildSourceSHA moduleArchiveSHA256 moduleSRI manifestSHA256 inventorySHA256 moduleSourceTreeSHA256 coreSHA256 runtime runtimePath runtimeVersion runtimeSHA256 installedEntry installedEntrySHA256 installedHelper installedHelperSHA256 installedLibrarySHA256 installedClientSHA256 storeRoot transport'),
  ...fields('string', 'inputAuthoritySHA256 driverSHA256 chainReceiptSHA256 chainCleanupReceiptSHA256 platformReceiptSHA256'), actualPlatformExit: 'number', moduleAndCoreArtifactUnchanged: 'boolean', installedInventoryReverified: 'boolean' };
const close: Projection = { ...fields('number', 'exit'), ...fields('string', 'signal rawSHA256 resourceStop supervisorError'), ...fields('boolean', 'actualWait rawClosedBeforeHash ownedGroupAbsentAfterWait'), cleanupErrors: ['string'] };
const installedStage: Projection = { ...fields('string', 'stage actualSignal stdoutSHA256 stderrSHA256'), ...fields('number', 'pid actualExit'), ...fields('boolean', 'actualWait rawClosed groupAbsent') };
const installedProxy: Projection = { pid: 'number', groupAbsent: 'boolean', tokenFixtureObserved: 'boolean', nativeMountStarted: 'boolean' };
export const INSTALLED_CONSUMER_STAGES = ['public-workcopy-types-Node16', 'public-workcopy-types-Node', 'node-esm-public-runtime', 'node-status', 'node-workcopy-sqlite', 'bun-esm-public-runtime', 'bun-status', 'bun-workcopy-sqlite', 'node-startup-cancel'] as const;
const platform: Projection = { ...fields('number', 'schemaVersion exit passedCases minPassedCases'), ...fields('string', 'os backend nodePath nodeVersion nodeSha256 nativeRg nativeRgVersion nativeRgSha256 productArchiveSha256 installedHelperSha256 installedLauncherPath harnessRunnerSha256 producerState rawLog rawSHA256 snapshotSHA256 status failureReason signal'),
  ...fields('boolean', 'producerStarted producerClosed actualWait rawClosedBeforeHash ownedGroupAbsent consumerBunVisible mountExecuted'), moduleBinding: binding, producerLifecycle: lifecycle,
  ownedProcessObservations: [{ phase: 'string', known: 'boolean', reason: 'string', members: [{ ...fields('number', 'pid ppid pgid'), state: 'string' }] }],
  vitestReport: { ...fields('string', 'path sha256'), requiredCases: ['string'], requiredSatisfied: 'boolean', missingRequired: ['string'], notPassed: [{ title: 'string', status: 'string' }] } };
const receipts: Record<string, Projection> = {
  'module-install.safe.json': binding,
  'module-admission.safe.json': binding,
  'native-reuse.safe.json': { lifecycle, ...fields('string', 'state signal rawPath rawSHA256 nativeBuildSourceSHA archiveSHA256 pinsSHA256'), code: 'number', groupAbsent: 'boolean', rawClosedBeforeHash: 'boolean' },
  'module-chain.safe.json': { ...fields('string', 'status entry entrySHA256 helper helperSHA256 runtime runtimeSHA256 launcherSHA256 proxyCommandSHA256 nativeCommandSHA256 proxyOwnerSHA256'), authExchanges: 'number', ownedPids: ['number'], children: [child], ...fields('boolean', 'actualAuthenticatedRead actualConditionalWriteback daemonAbsenceProven kernelAbsent') },
  'module-chain-cleanup.safe.json': { ...fields('boolean', 'cleanupVerified kernelAbsent daemonsAbsent groupsAbsent identitiesKnown proxyIdentityObserved nativeIdentityObserved unmountClosedSuccessfully sceneRetained'), ownedPids: ['number'], ownedGroups: ['number'], children: [child] },
  'module-admission-failure.safe.json': { ...fields('string', 'status stage nativeReceiptPresent mountedReceiptPresent cleanupClaim'), accepted: 'boolean' },
  'mounted-linux.receipt.json': platform, 'mounted-darwin.receipt.json': platform,
  'installed-consumer.safe.json': { ...fields('string', 'status archiveSHA256 moduleSourceSHA manifestSHA256 rawSHA256 sourceTestSHA256 nodeVersion bunVersion'),
    ...fields('boolean', 'accepted producerClosed groupAbsent rawClosedBeforeHash'), code: 'number', signal: 'string', lifecycle,
    passed: 'number', failed: 'number', skipped: 'number', stages: [installedStage],
    proxyCancel: installedProxy },
  'linux-container-binding.json': { ...fields('string', 'state cid'), ...fields('boolean', 'released containerAbsent'), pid1Seccomp: 'number', daemonSecurityOptions: ['string'], consumerReceipt: close, removalReceipt: close,
    container: { ...fields('string', 'cid imageID AppArmorProfile NetworkMode'), ...fields('boolean', 'running privileged'), SecurityOpt: ['string'], CapAdd: ['string'], CapDrop: ['string'],
      Devices: [{ ...fields('string', 'PathOnHost PathInContainer CgroupPermissions') }], Mounts: [{ destination: 'string', RW: 'boolean' }] } },
};
for (const mib of [64, 512, 1024]) receipts[`rss-${mib}.json`] = { phaseRead: ['number'], phaseCopyUp: ['number'], ...fields('number', 'readPeakKib copyUpPeakKib limitKib') };
/** Every nesting level has an explicit schema. Unknown keys and wrong-type
 * objects are omitted, including arbitrary credential/argv containers. */
function projectBySchema(original: unknown, schema: Projection): unknown {
  const project = (value: unknown, shape: Projection): unknown => {
    if (value === null) return null;
    if (typeof shape === 'string') return typeof value === shape && (shape !== 'number' || Number.isFinite(value)) ? value : undefined;
    if (Array.isArray(shape)) return Array.isArray(value) ? value.map(item => project(item, shape[0])).filter(item => item !== undefined) : undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return Object.fromEntries(Object.entries(shape).map(([key, rule]) => [key, project((value as Record<string, unknown>)[key], rule)]).filter(([, child]) => child !== undefined));
  };
  return project(original, schema);
}
export function projectReceipt(name: string, original: unknown): unknown {
  const schema = receipts[name]; if (!schema) throw new Error('unapproved receipt'); return projectBySchema(original, schema);
}
export function exportSafe(evidence: string, destination: string): void {
  mkdirSync(destination, { mode: 0o700 }); const files = [];
  for (const name of readdirSync(evidence)) {
    if (!Object.prototype.hasOwnProperty.call(receipts, name)) continue;
    const filename = path.join(evidence, name); const sha256 = hashFile(filename); verifyBoundFile({ path: filename, sha256 });
    const original = JSON.parse(readFileSync(filename, 'utf8'));
    const projection = projectReceipt(name, original) as Record<string, unknown>;
    const bytes = JSON.stringify({ ...projection, sourceReceiptSHA256: sha256 }, null, 2) + '\n';
    const safeName = name === 'linux-container-binding.json' ? 'linux-container-binding.safe.json' : /^rss-/.test(name) ? name.replace('.json', '.safe.json') : name;
    writeFileSync(path.join(destination, safeName), bytes, { flag: 'wx', mode: 0o600 }); files.push({ name: safeName, sha256: hashBytes(bytes) });
  }
  writeFileSync(path.join(destination, 'export.safe.json'), JSON.stringify({ schemaVersion: 1, files, rawLogsAndHomesExcluded: true }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
export function verifyInstalledConsumerReceipts(directory: string): { stages: unknown[]; proxyCancel: unknown } {
  const safeFiles = readdirSync(directory).filter(name => name.endsWith('.safe.json'));
  if (safeFiles.length !== INSTALLED_CONSUMER_STAGES.length + 1 || safeFiles.some(name => name !== 'proxy-cancel.safe.json' && !INSTALLED_CONSUMER_STAGES.some(stage => name === stage + '.safe.json'))) throw new Error('unexpected installed consumer receipt inventory');
  const stages = INSTALLED_CONSUMER_STAGES.map(stage => {
    const filename = path.join(directory, stage + '.safe.json'); verifyBoundFile({ path: filename, sha256: hashFile(filename) });
    const row = JSON.parse(readFileSync(filename, 'utf8'));
    const expectedExit = stage === 'node-startup-cancel' ? 143 : 0;
    if (row.stage !== stage || row.actualExit !== expectedExit || row.actualSignal !== null
      || row.actualWait !== true || row.rawClosed !== true || row.groupAbsent !== true || !Number.isSafeInteger(row.pid) || row.pid <= 1) throw new Error('installed consumer stage incomplete');
    for (const stream of ['stdout', 'stderr']) verifyBoundFile({ path: path.join(directory, `${stage}.${stream}`), sha256: row[`${stream}SHA256`] });
    return projectBySchema(row, installedStage);
  });
  const proxy = path.join(directory, 'proxy-cancel.safe.json'); verifyBoundFile({ path: proxy, sha256: hashFile(proxy) }); const proxyCancel = JSON.parse(readFileSync(proxy, 'utf8'));
  if (!Number.isSafeInteger(proxyCancel.pid) || proxyCancel.pid <= 1 || proxyCancel.groupAbsent !== true || proxyCancel.tokenFixtureObserved !== true || proxyCancel.nativeMountStarted !== false) throw new Error('installed consumer proxy cleanup incomplete');
  return { stages, proxyCancel: projectBySchema(proxyCancel, installedProxy) };
}
export async function runInstalledConsumer(archive: string, archiveSHA: string, sourceSHA: string, workspace: string, evidence: string): Promise<void> {
  verifyBoundFile({ path: archive, sha256: archiveSHA }); if (!/^[a-f0-9]{40}$/.test(sourceSHA)) throw new Error('invalid consumer source authority');
  const c = JSON.parse(execFileSync('python3', ['-c', collectArchive, archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })) as Collected;
  const properties = validateCollectedModule(c, `${process.platform}-${process.arch}`, sourceSHA, c.hashes['provenance/native-build.receipt.json']?.sha256, c.hashes['provenance/native-source-kit.json']?.sha256);
  mkdirSync(evidence, { mode: 0o700 }); const run = path.join(evidence, 'private-run'); mkdirSync(run, { mode: 0o700 }); const home = path.join(run, 'home'); mkdirSync(home, { mode: 0o700 });
  const sourceTest = path.join(workspace, 'packages/xpod-afs/tests/installed-module.test.ts'); const env = { ...isolatedModuleEnvironment(home), PATH: process.env.PATH, XPOD_AFS_TEST_ARCHIVE: archive };
  const sourceTestSHA256 = hashFile(sourceTest);
  const nodeVersion = (() => { try { return execFileSync('node', ['--version'], { encoding: 'utf8', env }).trim(); } catch { return null; } })();
  const child = spawn(process.execPath, ['test', sourceTest], { cwd: run, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const lifecycle = observeChildLifecycle(child); const raw: Buffer[] = []; child.stdout.on('data', (b: Buffer) => raw.push(b)); child.stderr.on('data', (b: Buffer) => raw.push(b));
  let fact = await lifecycle.wait(180_000); const groupAbsent = await reapOwnedGroup(child.pid, 15_000); if (fact.state !== 'closed') fact = await lifecycle.waitClose(15_000);
  const bytes = Buffer.concat(raw); writeFileSync(path.join(evidence, 'installed-consumer.raw.log'), bytes, { flag: 'wx', mode: 0o600 });
  const text = bytes.toString('utf8').replace(/\u001b\[[0-9;]*m/g, ''); const count = (name: string) => Number(new RegExp(`(?:^|\\n)\\s*(\\d+) ${name}\\b`).exec(text)?.[1] ?? 0);
  let stages: unknown[] = []; let proxyCancel: unknown = null; let accepted = false;
  try {
    if (fact.state !== 'closed' || fact.code !== 0 || fact.signal !== null || !groupAbsent || nodeVersion !== 'v22.21.1' || process.versions.bun !== '1.4.2'
      || count('pass') !== 1 || count('fail') !== 0 || count('skip') !== 0 || hashFile(sourceTest) !== sourceTestSHA256) throw new Error('installed consumer producer incomplete');
    const parent = path.join(run, '.test-data/afs-installed-receipts'); const directories = readdirSync(parent); if (directories.length !== 1) throw new Error('fresh consumer receipt directory required');
    ({ stages, proxyCancel } = verifyInstalledConsumerReceipts(path.join(parent, directories[0]))); verifyBoundFile({ path: archive, sha256: archiveSHA }); accepted = true;
  } finally {
    writeFileSync(path.join(evidence, 'installed-consumer.safe.json'), JSON.stringify({ status: accepted ? 'passed' : 'failed', accepted, archiveSHA256: archiveSHA, moduleSourceSHA: sourceSHA, manifestSHA256: properties.manifestSHA256,
      sourceTestSHA256, lifecycle: lifecycle.facts(), producerClosed: fact.state === 'closed', code: fact.code, signal: fact.signal, groupAbsent,
      rawClosedBeforeHash: fact.state === 'closed' && groupAbsent, rawSHA256: fact.state === 'closed' && groupAbsent ? hashBytes(bytes) : null,
      nodeVersion, bunVersion: process.versions.bun, passed: count('pass'), failed: count('fail'), skipped: count('skip'), stages, proxyCancel }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
}
async function main(): Promise<void> {
  const args = process.argv.slice(2); const mode = args.shift();
  const option = (name: string): string => { const i = args.indexOf(name); if (i < 0 || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`missing ${name}`); return args[i + 1]; };
  if (mode === 'export') { exportSafe(path.resolve(option('--evidence')), path.resolve(option('--out'))); return; }
  if (mode === 'installed-consumer') { await runInstalledConsumer(path.resolve(option('--archive')), option('--archive-sha256'), option('--source-sha'), path.resolve(option('--workspace')), path.resolve(option('--evidence'))); return; }
  const target = option('--target'); const facts = nativeFacts(target);
  if (mode === 'native-info') { const out = path.resolve(option('--out')); mkdirSync(out, { mode: 0o700 }); writeFileSync(path.join(out, 'native-pins.json'), JSON.stringify(facts.pins) + '\n', { flag: 'wx', mode: 0o600 }); writeFileSync(path.join(out, 'native-facts.safe.json'), JSON.stringify(facts) + '\n', { flag: 'wx', mode: 0o600 }); return; }
  if (mode !== 'prepare') throw new Error('unknown preparation operation');
  const workspace = path.resolve(option('--workspace')); const sourceSHA = option('--source-sha');
  const git = (...values: string[]): string => execFileSync('git', values, { cwd: workspace, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceSHA) || git('rev-parse', 'HEAD') !== sourceSHA || git('status', '--porcelain', '--untracked-files=all')) throw new Error('immutable clean source required');
  const out = path.resolve(option('--out')); const consumer = path.resolve(option('--consumer-product')); mkdirSync(out, { mode: 0o700 });
  const bound = (flag: string, name: string) => { const original = path.resolve(option(flag)); const sha256 = hashFile(original); verifyBoundFile({ path: original, sha256 }); copyFileSync(original, path.join(out, name), 1); return { path: path.join(consumer, name), sha256 }; };
  const archive = bound('--native', 'native.zip'); if (archive.sha256 !== facts.zipSHA256) throw new Error('native ZIP pin mismatch');
  const pins = bound('--pins', 'native-pins.json'); if (JSON.stringify(JSON.parse(readFileSync(path.join(out, 'native-pins.json'), 'utf8'))) !== JSON.stringify(facts.pins)) throw new Error('native pins mismatch');
  const native = JSON.parse(execFileSync('python3', ['-c', "import zipfile,hashlib,json,sys\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert len(z.namelist())==len(set(z.namelist()))\n print(json.dumps({n:hashlib.sha256(z.read(n)).hexdigest() for n in ['native-receipt.json','source-kit.json']}))", path.join(out, 'native.zip')], { encoding: 'utf8' })) as Record<string, string>;
  const module = bound('--module', 'module.tgz'); const properties = collectModule(path.join(out, 'module.tgz'), target, sourceSHA, native['native-receipt.json'], native['source-kit.json']);
  const core = bound('--core', 'core.mjs'); const driver = bound('--driver', 'module-admission.mjs');
  const buildPath = path.resolve(option('--build-receipt')); const build = JSON.parse(readFileSync(buildPath, 'utf8'));
  if (build.sourceSHA !== sourceSHA || build.sourceClean !== true || build.exit !== 0 || build.coreSHA256 !== core.sha256
    || build.driverSHA256 !== driver.sha256 || !Array.isArray(build.metafiles) || build.metafiles.length !== 2) throw new Error('closed build binding mismatch');
  for (const metadata of build.metafiles) {
    verifyBoundFile(metadata);
    if (!Array.isArray(metadata.inputs) || metadata.inputs.length === 0) throw new Error('build inputs missing');
    for (const file of metadata.inputs) verifyBoundFile(file);
  }
  const runtime = (name: 'node' | 'bun') => { const filename = path.resolve(option(`--${name}`)); const sha256 = hashFile(filename); verifyBoundFile({ path: filename, sha256 }); const version = execFileSync(filename, ['--version'], { encoding: 'utf8' }).trim(); if (version !== (name === 'node' ? 'v22.21.1' : '1.4.2')) throw new Error('runtime pin mismatch'); return { path: path.resolve(option(`--consumer-${name}`)), sha256 }; };
  const input: ModuleAdmissionInputs = { schemaVersion: 1, target: target as ModuleAdmissionInputs['target'], workspace: path.resolve(option('--consumer-workspace')), evidence: path.resolve(option('--evidence')), home: path.resolve(option('--home')),
    moduleSourceSHA: sourceSHA, nativeBuildSourceSHA: source, driver: { ...driver, sourceSHA }, core: { ...core, sourceSHA },
    module: { ...module, ...properties, integrity: `sha512-${createHash('sha512').update(readFileSync(path.join(out, 'module.tgz'))).digest('base64')}` },
    native: { archive, pins, receiptSHA256: native['native-receipt.json'], sourceKitSHA256: native['source-kit.json'] }, runtimes: { node: runtime('node'), bun: runtime('bun') } };
  if (git('rev-parse', 'HEAD') !== sourceSHA || git('status', '--porcelain', '--untracked-files=all')) throw new Error('source changed during preparation');
  const bytes = JSON.stringify(input, null, 2) + '\n'; writeFileSync(path.join(out, 'inputs.json'), bytes, { flag: 'wx', mode: 0o600 });
  writeFileSync(path.join(out, 'preparation.safe.json'), JSON.stringify({ schemaVersion: 1, sourceSHA, sourceClean: true, buildReceiptSHA256: hashFile(buildPath), build, native: facts, inputSHA256: hashBytes(bytes), input, archiveMembersValidated: true }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(hashBytes(bytes) + '\n');
}
if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) { main().catch(() => { process.stderr.write('module preparation rejected\n'); process.exitCode = 1; }); }
