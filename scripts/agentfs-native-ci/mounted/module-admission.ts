import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { x as extractTar } from 'tar';
import { fileURLToPath } from 'node:url';
import { ModuleStore } from '../../../packages/xpod-cli/src/module-store';
import { observeChildLifecycle, reapOwnedGroup, runMountedPlatformAdmission, type InstalledMountedProduct } from './platform-admission';

export const MODULE_CHAIN_CASE = 'mounts through the installed core and AFS module with public-client authentication, then closes its proxy and kernel mount';
export interface BoundFile { path: string; sha256: string }
export interface CliRuntimeArtifacts {
  archive: BoundFile;
  clientArchive: BoundFile;
  version: string;
  clientVersion: string;
  files: Record<string, { bytes: number; sha256: string; mode: number }>;
  clientFiles: Record<string, { bytes: number; sha256: string; mode: number }>;
}
export interface ModuleAdmissionInputs {
  schemaVersion: 1; target: 'linux-arm64' | 'darwin-arm64' | 'linux-x64' | 'darwin-x64'; workspace: string; evidence: string; home: string;
  moduleSourceSHA: string; nativeBuildSourceSHA: string;
  driver: BoundFile & { sourceSHA: string };
  module: BoundFile & { name: string; version: string; integrity: string; manifestSHA256: string; inventorySHA256: string;
    sourceTreeSHA256: string; helperSHA256: string; entrySHA256: string; librarySHA256: string; clientSHA256: string };
  core: BoundFile & { sourceSHA: string };
  cli: CliRuntimeArtifacts;
  native: { archive: BoundFile; pins: BoundFile; receiptSHA256: string; sourceKitSHA256: string };
  runtimes: { node: BoundFile; bun: BoundFile };
}
export const hashBytes = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
export const hashFile = (filename: string): string => hashBytes(readFileSync(filename));

function createCliFixtureDirectory(prefix: string): string {
  const parent = path.join(tmpdir(), '.test-data');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('regular fixture parent required');
  return mkdtempSync(path.join(parent, prefix));
}

export function writeBootstrapEvidence(evidence: string, prefix: string, stdout: Buffer | null, stderr: Buffer | null,
  receipt: object, primaryFailure?: Error): void {
  try {
    writeFileSync(path.join(evidence, prefix + '.stdout.raw'), stdout ?? Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
    writeFileSync(path.join(evidence, prefix + '.stderr.raw'), stderr ?? Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
    writeFileSync(path.join(evidence, prefix === 'cli-bootstrap' ? 'cli-runtime.safe.json' : prefix + '.safe.json'), JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (recordingFailure) {
    if (primaryFailure) throw new AggregateError([primaryFailure, recordingFailure], 'CLI bootstrap and evidence write failed');
    throw recordingFailure;
  }
  if (primaryFailure) throw primaryFailure;
}

function validateCliArtifacts(cli: CliRuntimeArtifacts, coreSHA256: string): void {
  if (!cli || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(cli.version ?? '')
    || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(cli.clientVersion ?? '')) throw new Error('CLI runtime authority invalid');
  for (const inventory of [cli.files, cli.clientFiles]) {
    if (!inventory || !Object.keys(inventory).length) throw new Error('CLI runtime inventory missing');
    for (const [name, fact] of Object.entries(inventory)) {
      if (name.split('/').some(part => !part || part === '.' || part === '..') || /[\x00-\x1f\\:]/.test(name)
        || !Number.isSafeInteger(fact.bytes) || fact.bytes < 0 || !Number.isInteger(fact.mode) || fact.mode < 0 || fact.mode > 0o777
        || !/^[a-f0-9]{64}$/.test(fact.sha256)) throw new Error('CLI runtime inventory invalid');
    }
  }
  if (!cli.files['package.json'] || !cli.files['dist/bin/xpod'] || !(cli.files['dist/bin/xpod'].mode & 0o111)
    || cli.files['dist/xpod.mjs']?.sha256 !== coreSHA256 || !cli.clientFiles['package.json'] || !cli.clientFiles['dist/library.cjs']) {
    throw new Error('CLI runtime payload binding missing');
  }
}

function inspectCliRuntimeTree(directory: string, expected: CliRuntimeArtifacts, checkModes: boolean): Array<{ path: string; mode: number }> {
  const wanted = new Map(Object.entries(expected.files));
  for (const [name, fact] of Object.entries(expected.clientFiles)) wanted.set('node_modules/@undefineds.co/xpod-client/' + name, fact);
  const found = new Set<string>();
  const verified: Array<{ path: string; mode: number }> = [];
  const visit = (current: string): void => {
    for (const name of readdirSync(current)) {
      const file = path.join(current, name); const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('CLI runtime link rejected');
      if (stat.isDirectory()) { visit(file); continue; }
      const relative = path.relative(directory, file).split(path.sep).join('/'); const fact = wanted.get(relative);
      if (!stat.isFile() || !fact || stat.size !== fact.bytes || (checkModes && (stat.mode & 0o777) !== fact.mode) || hashFile(file) !== fact.sha256) throw new Error('CLI runtime inventory mismatch');
      found.add(relative);
      verified.push({ path: file, mode: fact.mode });
    }
  };
  visit(directory);
  if (found.size !== wanted.size) throw new Error('CLI runtime inventory incomplete');
  return verified;
}

export function verifyCliRuntimeTree(directory: string, expected: CliRuntimeArtifacts): void {
  inspectCliRuntimeTree(directory, expected, true);
}

/** Exact validated tar payloads, not package-manager or registry installation evidence. */
export function materializeCliRuntime(input: ModuleAdmissionInputs): { directory: string; bin: string; core: string } {
  validateCliArtifacts(input.cli, input.core.sha256);
  verifyBoundFile(input.cli.archive); verifyBoundFile(input.cli.clientArchive);
  const directory = createCliFixtureDirectory('xpod-afs-cli-runtime-');
  const workspace = realpathSync(input.workspace);
  const relative = path.relative(workspace, realpathSync(directory));
  if (!relative || !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw new Error('CLI consumer must be outside the workspace');
  const client = path.join(directory, 'node_modules/@undefineds.co/xpod-client'); mkdirSync(client, { recursive: true });
  extractTar({ file: input.cli.archive.path, cwd: directory, strip: 1, strict: true, sync: true });
  extractTar({ file: input.cli.clientArchive.path, cwd: client, strip: 1, strict: true, sync: true });
  // Verify regular members and original bytes before restoring archive modes.
  // The synchronous extractor leaves regular file modes filtered by umask.
  for (const file of inspectCliRuntimeTree(directory, input.cli, false)) chmodSync(file.path, file.mode);
  verifyCliRuntimeTree(directory, input.cli);
  const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const clientManifest = JSON.parse(readFileSync(path.join(client, 'package.json'), 'utf8'));
  if (manifest.name !== '@undefineds.co/xpod-cli' || manifest.version !== input.cli.version
    || manifest.bin?.xpod !== './dist/bin/xpod' || Object.keys(manifest.dependencies ?? {}).length !== 1
    || manifest.dependencies['@undefineds.co/xpod-client'] !== input.cli.clientVersion
    || clientManifest.name !== '@undefineds.co/xpod-client' || clientManifest.version !== input.cli.clientVersion) throw new Error('CLI dependency layout mismatch');
  const core = path.join(directory, 'dist/xpod.mjs');
  if (hashFile(core) !== input.core.sha256) throw new Error('CLI core payload mismatch');
  return { directory, core, bin: path.join(directory, 'dist/bin/xpod') };
}
/** Select from the declared producer contract, never from whichever file exists. */
export function moduleClientPath(kit: any, member: (name: string) => { sha256: string; size: number }, members?: string[]): string {
  const materials = kit?.publicClientMaterials;
  const clients = materials?.runtimeClients;
  const mappings = materials?.workspaceSources;
  if (!Array.isArray(clients) || clients.length !== 1 || !Array.isArray(mappings) || mappings.length !== 1) throw new Error('runtime client authority mismatch');
  const client = clients[0]; const mapping = mappings[0];
  if (client.name !== '@undefineds.co/xpod-client' || mapping.name !== client.name || mapping.version !== client.version
    || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(client.version ?? '')
    || client.sourceDirectory !== 'workspace/xpod-client' || mapping.directory !== client.sourceDirectory
    || mapping.role !== 'declared-runtime-dependency' || !Array.isArray(client.files) || !client.files.length) throw new Error('runtime client authority mismatch');
  const names = new Set<string>();
  for (const file of client.files) {
    if (typeof file.path !== 'string' || file.path.split('/').some((part: string) => !part || part === '.' || part === '..')
      || !/^(?:package\.json|LICENSE|README\.md|dist\/.+)$/.test(file.path) || names.has(file.path)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('runtime client inventory mismatch');
    names.add(file.path);
    const actual = member('node_modules/@undefineds.co/xpod-client/' + file.path);
    if (actual.sha256 !== file.sha256 || actual.size !== file.bytes) throw new Error('runtime client inventory mismatch');
  }
  if (!['package.json', 'LICENSE', 'README.md', 'dist/library.cjs'].every(name => names.has(name))) throw new Error('runtime client inventory incomplete');
  if (members) {
    const prefix = 'node_modules/@undefineds.co/xpod-client/';
    const actual = members.filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length));
    if (actual.length !== names.size || actual.some(name => !names.has(name))) throw new Error('runtime client inventory incomplete');
  }
  return 'node_modules/@undefineds.co/xpod-client/dist/library.cjs';
}

export function verifyModuleClientMaterials(kit: any, member: (name: string) => { sha256: string; size: number }, document: (name: string) => any, sources?: Record<string, { sha256: string; bytes: number }>): void {
  const materials = kit?.publicClientMaterials;
  const index = document('provenance/cli-producer-materials.json');
  const inventory = document('provenance/cli-client-source-inventory.json');
  if (!materials || member('provenance/cli-producer-materials.json').sha256 !== materials.indexSHA256
    || member('provenance/cli-client-source-inventory.json').sha256 !== materials.sourceInventorySHA256
    || member('sources/cli-client-source.tar.gz').sha256 !== materials.clientSourceSHA256
    || JSON.stringify(index.runtimeClients) !== JSON.stringify(materials.runtimeClients)
    || JSON.stringify(index.workspaceSources) !== JSON.stringify(materials.workspaceSources)
    || JSON.stringify(index.producer) !== JSON.stringify(materials.producer)
    || index.schemaVersion !== 1 || inventory.schemaVersion !== 1 || !Array.isArray(inventory.files)
    || hashBytes(JSON.stringify(inventory.files)) !== index.sourceAuthority?.snapshotSHA256) throw new Error('runtime client producer binding mismatch');
  const authority = index.sourceAuthority;
  if (index.producer?.name !== '@undefineds.co/xpod-cli' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(index.producer?.version ?? '')
    || typeof index.producer?.bunVersion !== 'string' || !/^\d+\.\d+\.\d+/.test(index.producer.bunVersion)
    || !authority || (authority.sourceCommit !== null && !/^[a-f0-9]{40}$/.test(authority.sourceCommit))
    || (authority.dirty !== null && typeof authority.dirty !== 'boolean') || typeof authority.scope !== 'string' || !authority.scope
    || JSON.stringify(authority) !== JSON.stringify(materials.sourceAuthority) || !Array.isArray(index.files)
    || index.files.length !== materials.files || index.sourceInventory !== 'source-inventory.json' || index.clientSource !== 'client-source.tar.gz') throw new Error('runtime client producer authority mismatch');
  for (const [declared, actualPath] of [['source-inventory.json', 'provenance/cli-client-source-inventory.json'], ['client-source.tar.gz', 'sources/cli-client-source.tar.gz']]) {
    const rows = index.files.filter((file: any) => file.path === declared);
    const actual = member(actualPath);
    if (rows.length !== 1 || rows[0].sha256 !== actual.sha256 || rows[0].bytes !== actual.size) throw new Error('runtime client producer inventory mismatch');
  }
  const names = new Set<string>();
  for (const file of inventory.files) {
    if (typeof file.path !== 'string' || file.path.startsWith('/') || file.path.split('/').some((part: string) => !part || part === '.' || part === '..')
      || names.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('runtime client source inventory mismatch');
    names.add(file.path);
    if (sources && (sources[file.path]?.sha256 !== file.sha256 || sources[file.path]?.bytes !== file.bytes)) throw new Error('runtime client source inventory mismatch');
  }
  if (sources && Object.keys(sources).length !== names.size) throw new Error('runtime client source inventory mismatch');
  if (!names.has('workspace/xpod-client/package.json') || !names.has('workspace/xpod-client/src/index.ts')) throw new Error('runtime client source mapping mismatch');
}

export function verifyBoundFile(file: BoundFile): void {
  if (!file || !path.isAbsolute(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)
    || !lstatSync(file.path).isFile() || lstatSync(file.path).isSymbolicLink() || hashFile(file.path) !== file.sha256) {
    throw new Error('bound file identity mismatch');
  }
}
export function readModuleAdmissionInputs(filename: string, authoritySHA256: string): ModuleAdmissionInputs {
  verifyBoundFile({ path: filename, sha256: authoritySHA256 });
  const input = JSON.parse(readFileSync(filename, 'utf8')) as ModuleAdmissionInputs;
  if (input.schemaVersion !== 1 || !['linux-arm64', 'darwin-arm64', 'linux-x64', 'darwin-x64'].includes(input.target)
    || !/^[a-f0-9]{40}$/.test(input.moduleSourceSHA) || !/^[a-f0-9]{40}$/.test(input.nativeBuildSourceSHA)
    || input.core?.sourceSHA !== input.moduleSourceSHA || input.driver?.sourceSHA !== input.moduleSourceSHA
    || !input.driver?.path?.endsWith('.mjs') || input.module?.name !== `@undefineds.co/xpod-afs-${input.target}`
    || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(input.module?.version ?? '')
    || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(input.module?.integrity ?? '')
    || [input.workspace, input.evidence, input.home].some(value => typeof value !== 'string' || !path.isAbsolute(value))) {
    throw new Error('module admission authority is invalid');
  }
  if (input.target !== `${process.platform}-${process.arch}`) throw new Error('module admission platform mismatch');
  validateCliArtifacts(input.cli, input.core.sha256);
  for (const value of [input.module, input.core, input.cli?.archive, input.cli?.clientArchive, input.driver, input.native?.archive, input.native?.pins, input.runtimes?.node, input.runtimes?.bun]) verifyBoundFile(value);
  for (const value of [input.module.manifestSHA256, input.module.inventorySHA256, input.module.sourceTreeSHA256,
    input.module.helperSHA256, input.module.entrySHA256, input.module.librarySHA256, input.module.clientSHA256,
    input.native.receiptSHA256, input.native.sourceKitSHA256]) {
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('module member authority is invalid');
  }
  if (`sha512-${createHash('sha512').update(readFileSync(input.module.path)).digest('base64')}` !== input.module.integrity) {
    throw new Error('module SRI authority mismatch');
  }
  const pins = JSON.parse(readFileSync(input.native.pins.path, 'utf8')) as Record<string, string>;
  const prefix = input.target.startsWith('linux') ? 'LINUX' : 'DARWIN';
  if (pins.PRODUCT_SHA !== input.nativeBuildSourceSHA || pins[`${prefix}_HELPER_SHA`] !== input.module.helperSHA256
    || pins[`${prefix}_ZIP_SHA`] !== input.native.archive.sha256) throw new Error('native source/artifact authority mismatch');
  return input;
}

/** Exact real artifact bytes through the existing installer transport interface. */
export function artifactFetch(input: ModuleAdmissionInputs): typeof fetch {
  const metadata = `https://registry.npmjs.org/${encodeURIComponent(input.module.name)}/${input.module.version}`;
  const basename = input.module.name.split('/')[1];
  const tarball = `https://registry.npmjs.org/${input.module.name}/-/${basename}-${input.module.version}.tgz`;
  return (async (request: string | URL | Request) => {
    const url = String(request);
    if (url === metadata) return Response.json({ name: input.module.name, version: input.module.version,
      dist: { integrity: input.module.integrity, tarball } });
    if (url === tarball) {
      verifyBoundFile(input.module);
      return new Response(readFileSync(input.module.path));
    }
    throw new Error('offline artifact transport rejects unbound URL');
  }) as typeof fetch;
}

async function verifyNative(input: ModuleAdmissionInputs): Promise<void> {
  const script = `import importlib.util,json,pathlib,sys,zipfile,hashlib\nr=pathlib.Path(sys.argv[1]);sys.path.insert(0,str(r/'scripts/agentfs-native-ci'))\ns=importlib.util.spec_from_file_location('accept',r/'scripts/agentfs-native-ci/accept.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nf=m.verify_reuse_archive(pathlib.Path(sys.argv[2]),json.loads(pathlib.Path(sys.argv[3]).read_text()),sys.argv[4],sys.argv[7])\nwith zipfile.ZipFile(sys.argv[2]) as z:\n assert hashlib.sha256(z.read('native-receipt.json')).hexdigest()==sys.argv[5]\n assert hashlib.sha256(z.read('source-kit.json')).hexdigest()==sys.argv[6]\nprint(json.dumps(f))`;
  const child = spawn('python3', ['-c', script, input.workspace, input.native.archive.path, input.native.pins.path, input.target.split('-')[0], input.native.receiptSHA256, input.native.sourceKitSHA256, input.target.split('-')[1]],
    { cwd: input.workspace, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const lifecycle = observeChildLifecycle(child); const raw: Buffer[] = [];
  child.stdout.on('data', (value: Buffer) => raw.push(value)); child.stderr.on('data', (value: Buffer) => raw.push(value));
  let fact = await lifecycle.wait(120_000);
  const groupAbsent = await reapOwnedGroup(child.pid, 15_000);
  if (fact.state !== 'closed') fact = await lifecycle.waitClose(15_000);
  const bytes = Buffer.concat(raw); const rawPath = path.join(input.evidence, 'native-reuse.raw.log');
  writeFileSync(rawPath, bytes, { flag: 'wx', mode: 0o600 });
  writeFileSync(path.join(input.evidence, 'native-reuse.safe.json'), JSON.stringify({ lifecycle: lifecycle.facts(), ...fact,
    groupAbsent, rawClosedBeforeHash: fact.state === 'closed' && groupAbsent, rawPath,
    rawSHA256: fact.state === 'closed' && groupAbsent ? hashBytes(bytes) : null, nativeBuildSourceSHA: input.nativeBuildSourceSHA,
    archiveSHA256: input.native.archive.sha256, pinsSHA256: input.native.pins.sha256 }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (fact.state !== 'closed' || fact.code !== 0 || fact.signal !== null || !groupAbsent) throw new Error('native reuse producer did not close successfully');
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export function isolatedModuleEnvironment(home: string, evidence?: string): NodeJS.ProcessEnv {
  return { HOME: home, SOLID_HOME: path.join(home, '.solid'), LANG: 'C', TZ: 'UTC',
    ...(evidence ? { XPOD_MOUNTED_EVIDENCE: evidence } : {}) };
}
export async function installModuleProduct(input: ModuleAdmissionInputs, runtime: 'node' | 'bun'): Promise<InstalledMountedProduct> {
  const [platform, arch] = input.target.split('-');
  const store = new ModuleStore({ root: path.join(input.home, '.xpod/modules'), platform, arch, fetch: artifactFetch(input) });
  const installed = await store.install('afs', input.module.version);
  const directory = path.join(store.root, 'afs', input.target, installed.version, 'package');
  const pkgPath = path.join(directory, 'package.json'); const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const entry = path.join(directory, 'dist/entry.mjs'); const helper = path.join(directory, 'helper/agentfs-pod');
  const clientKit = JSON.parse(readFileSync(path.join(directory, 'provenance/module-source-kit.json'), 'utf8'));
  const installedMember = (name: string) => { const bytes = readFileSync(path.join(directory, name)); return { sha256: hashBytes(bytes), size: bytes.length }; };
  verifyModuleClientMaterials(clientKit, installedMember, name => JSON.parse(readFileSync(path.join(directory, name), 'utf8')));
  const clientPath = moduleClientPath(clientKit, name => { const bytes = readFileSync(path.join(directory, name)); return { sha256: hashBytes(bytes), size: bytes.length }; }, pkg.xpodModule.files.map((file: { path: string }) => file.path));
  if (hashFile(pkgPath) !== input.module.manifestSHA256 || hashBytes(JSON.stringify(pkg.xpodModule.files)) !== input.module.inventorySHA256
    || hashFile(entry) !== input.module.entrySHA256 || hashFile(helper) !== input.module.helperSHA256
    || hashFile(path.join(directory, 'dist/library.cjs')) !== input.module.librarySHA256
    || hashFile(path.join(directory, clientPath)) !== input.module.clientSHA256) {
    throw new Error('installed module authority mismatch');
  }
  const provenance = JSON.parse(readFileSync(path.join(directory, 'provenance/native-reuse.json'), 'utf8'));
  const kit = clientKit;
  if (provenance.moduleSourceDirty !== false || provenance.moduleSourceSHA !== input.moduleSourceSHA
    || provenance.nativeBuildSourceSHA !== input.nativeBuildSourceSHA || provenance.moduleSourceTreeSHA256 !== input.module.sourceTreeSHA256
    || kit.dirty !== false || kit.moduleSourceSHA !== input.moduleSourceSHA || kit.moduleSourceTreeSHA256 !== input.module.sourceTreeSHA256
    || hashBytes(JSON.stringify(kit.files)) !== input.module.sourceTreeSHA256 || kit.publicClientPayloadSHA256 !== input.module.clientSHA256
    || hashFile(path.join(directory, 'provenance/native-build.receipt.json')) !== input.native.receiptSHA256
    || hashFile(path.join(directory, 'provenance/native-source-kit.json')) !== input.native.sourceKitSHA256) {
    throw new Error('installed module source binding mismatch');
  }
  const executable = input.runtimes[runtime]; verifyBoundFile(executable); verifyBoundFile(input.core);
  const version = execFileSync(executable.path, ['--version'], { encoding: 'utf8' }).trim();
  if (runtime === 'node' ? version !== 'v22.21.1' : version !== '1.4.2') throw new Error('consumer runtime version mismatch');
  const bareDirectory = createCliFixtureDirectory('xpod-afs-bare-core-');
  const bareCore = path.join(bareDirectory, 'core.mjs'); copyFileSync(input.core.path, bareCore); verifyBoundFile({ path: bareCore, sha256: input.core.sha256 });
  const bare = spawnSync(executable.path, [bareCore, '--help'], { cwd: bareDirectory, env: isolatedModuleEnvironment(input.home), timeout: 15000 });
  const missingClient = /@undefineds\.co\/xpod-client/.test(String(bare.stderr)) && /Cannot find|ERR_MODULE_NOT_FOUND/.test(String(bare.stderr));
  const bareFailure = bare.error || bare.signal || bare.status === null || bare.status === 0 || !missingClient
    ? bare.error ?? new Error('bare core negative control did not prove missing Client dependency') : undefined;
  writeBootstrapEvidence(input.evidence, 'cli-bare-bootstrap', bare.stdout, bare.stderr, { runtime, actualExit: bare.status, actualSignal: bare.signal,
    actualWait: true, coreSHA256: input.core.sha256, stdoutSHA256: hashBytes(bare.stdout ?? Buffer.alloc(0)), stderrSHA256: hashBytes(bare.stderr ?? Buffer.alloc(0)),
    category: missingClient ? 'missing_public_runtime_client' : 'unclassified' }, bareFailure);
  const launcher = path.join(input.evidence, 'module-core-launcher');
  const cli = materializeCliRuntime(input);
  const runtimePath = createCliFixtureDirectory('xpod-afs-cli-path-');
  symlinkSync(executable.path, path.join(runtimePath, runtime));
  const consumerPath = `${runtimePath}:/usr/bin:/bin`;
  const selected = execFileSync('/bin/sh', ['-c', 'command -v bun || command -v node'], { env: { PATH: consumerPath }, encoding: 'utf8' }).trim();
  if (selected !== path.join(runtimePath, runtime)) throw new Error('public launcher runtime selection mismatch');
  writeFileSync(launcher, `#!/bin/sh\nunset NODE_PATH NODE_OPTIONS BUN_OPTIONS\nexport HOME=${quote(input.home)}\nexport SOLID_HOME=${quote(path.join(input.home, '.solid'))}\nexport PATH=${quote(consumerPath)}\nexec ${quote(cli.bin)} "$@"\n`, { flag: 'wx', mode: 0o700 });
  const help = spawnSync(launcher, ['--help'], { env: isolatedModuleEnvironment(input.home), timeout: 15000 });
  const helpFailure = help.error || help.status !== 0 || help.signal ? help.error ?? new Error('public CLI bootstrap failed') : undefined;
  writeBootstrapEvidence(input.evidence, 'cli-bootstrap', help.stdout, help.stderr, {
    runtime, directory: cli.directory, binSHA256: hashFile(cli.bin), coreSHA256: hashFile(cli.core),
    clientCoreSHA256: hashFile(path.join(cli.directory, 'node_modules/@undefineds.co/xpod-client/dist/library.cjs')),
    cliArchiveSHA256: input.cli.archive.sha256, clientArchiveSHA256: input.cli.clientArchive.sha256,
    bootstrapActualExit: help.status, bootstrapSignal: help.signal, bootstrapActualWait: true,
    bootstrapStdoutSHA256: hashBytes(help.stdout ?? Buffer.alloc(0)), bootstrapStderrSHA256: hashBytes(help.stderr ?? Buffer.alloc(0)),
    scope: 'Exact validated tar dependency layout; not package-manager installation or registry publication',
  }, helpFailure);
  const binding = { profile: 'afs-module', moduleSourceSHA: input.moduleSourceSHA, nativeBuildSourceSHA: input.nativeBuildSourceSHA,
    moduleArchiveSHA256: input.module.sha256, moduleSRI: input.module.integrity, manifestSHA256: input.module.manifestSHA256,
    inventorySHA256: input.module.inventorySHA256, moduleSourceTreeSHA256: input.module.sourceTreeSHA256,
    coreSHA256: input.core.sha256, runtime, runtimePath: executable.path, runtimeVersion: version, runtimeSHA256: executable.sha256,
    installedEntry: entry, installedEntrySHA256: input.module.entrySHA256, installedHelper: helper, installedHelperSHA256: input.module.helperSHA256,
    installedLibrarySHA256: input.module.librarySHA256, installedClientSHA256: input.module.clientSHA256, installedClientPath: clientPath, storeRoot: store.root,
    transport: 'offline exact original artifact through ModuleStore; not registry publication acceptance' };
  writeFileSync(path.join(input.evidence, 'module-install.safe.json'), JSON.stringify(binding, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { helper, launcher, helperSha256: input.module.helperSHA256, launcherSha256: hashFile(launcher), entry, entrySha256: input.module.entrySHA256,
    binding, additionalTests: ['tests/agentfs-pod/installedModuleMountedChain.test.ts'], additionalRequiredCases: [MODULE_CHAIN_CASE],
    env: { ...isolatedModuleEnvironment(input.home, input.evidence),
      XPOD_AGENTFS_MODULE_ENTRY: entry, XPOD_AGENTFS_MODULE_RUNTIME: executable.path,
      XPOD_AGENTFS_MODULE_CORE: cli.core, XPOD_AGENTFS_MODULE_STORE: store.root, XPOD_AGENTFS_MODULE_EVIDENCE: input.evidence,
      // Test tooling is separate from the deliberately Bun-free consumer PATH.
      XPOD_AGENTFS_ADMISSION_FIXTURE: JSON.stringify({ driver: input.driver, runtimes: input.runtimes }) } };
}

let failureEvidence: string | undefined;
let stage = 'inputs';
async function main(): Promise<void> {
  const args = process.argv.slice(2); const option = (name: string): string => {
    const index = args.indexOf(name); if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`missing ${name}`); return args[index + 1];
  };
  const filename = path.resolve(option('--inputs')); const authority = option('--inputs-sha256');
  const runtime = option('--runtime'); if (runtime !== 'node' && runtime !== 'bun') throw new Error('runtime must be node or bun');
  const input = readModuleAdmissionInputs(filename, authority);
  if (fileURLToPath(import.meta.url) !== input.driver.path) throw new Error('executed admission driver differs from bound bundle');
  if (input.target !== `${process.platform}-${process.arch}`) throw new Error('module target/host mismatch');
  // The container observer has already created its evidence directory and
  // closed the release receipt there. Output files still use wx throughout.
  mkdirSync(input.evidence, { recursive: true, mode: 0o700 });
  const evidenceStat = lstatSync(input.evidence);
  if (!evidenceStat.isDirectory() || evidenceStat.isSymbolicLink() || (evidenceStat.mode & 0o077)
    // The observed Linux container is root while its task-private bind mount
    // belongs to the host runner UID. Root may write that observer-owned mount.
    || (process.getuid?.() !== 0 && evidenceStat.uid !== process.getuid?.())) throw new Error('owned private evidence directory required');
  failureEvidence = input.evidence; mkdirSync(input.home, { mode: 0o700 });
  stage = 'native-reuse'; await verifyNative(input);
  stage = 'module-install'; const product = await installModuleProduct(input, runtime);
  Object.assign(process.env, { XPOD_MOUNTED_ARCHIVE: input.module.path, XPOD_MOUNTED_ARCHIVE_SHA: input.module.sha256,
    XPOD_MOUNTED_HELPER_SHA: input.module.helperSHA256, XPOD_MOUNTED_WORKSPACE: input.workspace,
    XPOD_MOUNTED_EVIDENCE: input.evidence, XPOD_MOUNTED_OS: process.platform, XPOD_MOUNTED_ARCH: input.target.split('-')[1], XPOD_MOUNTED_BACKEND: process.platform === 'linux' ? 'fuse' : 'nfs',
    XPOD_MOUNTED_NODE: input.runtimes.node.path, XPOD_MOUNTED_REQUIRE_NOBUN: runtime === 'node' ? '1' : '0', XPOD_MOUNTED_MIN_PASSED: '7' });
  stage = 'actual-mounted-consumer'; const exit = await runMountedPlatformAdmission(product);
  stage = 'post-consumer-inventory';
  const chain = JSON.parse(readFileSync(path.join(input.evidence, 'module-chain.safe.json'), 'utf8'));
  const cleanup = JSON.parse(readFileSync(path.join(input.evidence, 'module-chain-cleanup.safe.json'), 'utf8'));
  if (exit !== 0 || chain.status !== 'executed' || !(chain.authExchanges > 0) || chain.entrySHA256 !== input.module.entrySHA256
    || chain.helperSHA256 !== input.module.helperSHA256 || cleanup.cleanupVerified !== true || cleanup.identitiesKnown !== true
    || cleanup.daemonsAbsent !== true || cleanup.kernelAbsent !== true || cleanup.groupsAbsent !== true
    || cleanup.unmountClosedSuccessfully !== true) throw new Error('actual module chain or cleanup proof incomplete');
  verifyBoundFile(input.module); verifyBoundFile(input.core); verifyBoundFile(input.cli.archive); verifyBoundFile(input.cli.clientArchive);
  const cliReceipt = JSON.parse(readFileSync(path.join(input.evidence, 'cli-runtime.safe.json'), 'utf8'));
  verifyCliRuntimeTree(cliReceipt.directory, input.cli);
  writeFileSync(path.join(input.evidence, 'cli-runtime-final.safe.json'), JSON.stringify({ ...cliReceipt, inventoryReverified: true }) + '\n', { flag: 'wx', mode: 0o600 });
  await new ModuleStore({ root: String(product.binding.storeRoot), platform: process.platform, arch: process.arch }).current('afs');
  writeFileSync(path.join(input.evidence, 'module-admission.safe.json'), JSON.stringify({ ...product.binding, inputAuthoritySHA256: authority,
    actualPlatformExit: exit, moduleAndCoreArtifactUnchanged: true, installedInventoryReverified: true,
    driverSHA256: input.driver.sha256, chainReceiptSHA256: hashFile(path.join(input.evidence, 'module-chain.safe.json')),
    chainCleanupReceiptSHA256: hashFile(path.join(input.evidence, 'module-chain-cleanup.safe.json')),
    platformReceiptSHA256: hashFile(path.join(input.evidence, `mounted-${process.platform}.receipt.json`)) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.exitCode = exit;
}
if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  main().catch(() => {
    if (!failureEvidence) {
      try {
        const parent = path.resolve('.test-data/module-admission-preflight'); mkdirSync(parent, { recursive: true, mode: 0o700 });
        const stat = lstatSync(parent);
        if (stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o077) && stat.uid === process.getuid?.()) {
          failureEvidence = mkdtempSync(path.join(parent, 'failure-'));
        }
      } catch { /* no untrusted input path is used for preflight evidence */ }
    }
    if (failureEvidence) {
      try {
        writeFileSync(path.join(failureEvidence, 'module-admission-failure.safe.json'), JSON.stringify({ status: 'failed', stage,
          nativeReceiptPresent: (() => { try { return hashFile(path.join(failureEvidence!, 'native-reuse.safe.json')); } catch { return null; } })(),
          mountedReceiptPresent: (() => { try { return hashFile(path.join(failureEvidence!, `mounted-${process.platform}.receipt.json`)); } catch { return null; } })(),
          accepted: false, cleanupClaim: 'consult actual producer/chain receipts; absent receipt is unknown' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      } catch { /* existing evidence is never overwritten */ }
    }
    process.stderr.write(`module admission failed at ${stage}; inspect owned private evidence\n`); process.exitCode = 70;
  });
}
