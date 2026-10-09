import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModuleStore } from '../../../packages/xpod-cli/src/module-store';
import { observeChildLifecycle, reapOwnedGroup, runMountedPlatformAdmission, type InstalledMountedProduct } from './platform-admission';

export const MODULE_CHAIN_CASE = 'mounts through the installed core and AFS module with public-client authentication, then closes its proxy and kernel mount';
export interface BoundFile { path: string; sha256: string }
export interface ModuleAdmissionInputs {
  schemaVersion: 1; target: 'linux-arm64' | 'darwin-arm64'; workspace: string; evidence: string; home: string;
  moduleSourceSHA: string; nativeBuildSourceSHA: string;
  driver: BoundFile & { sourceSHA: string };
  module: BoundFile & { name: string; version: string; integrity: string; manifestSHA256: string; inventorySHA256: string;
    sourceTreeSHA256: string; helperSHA256: string; entrySHA256: string; librarySHA256: string; clientSHA256: string };
  core: BoundFile & { sourceSHA: string };
  native: { archive: BoundFile; pins: BoundFile; receiptSHA256: string; sourceKitSHA256: string };
  runtimes: { node: BoundFile; bun: BoundFile };
}
export const hashBytes = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
export const hashFile = (filename: string): string => hashBytes(readFileSync(filename));
export function verifyBoundFile(file: BoundFile): void {
  if (!file || !path.isAbsolute(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)
    || !lstatSync(file.path).isFile() || lstatSync(file.path).isSymbolicLink() || hashFile(file.path) !== file.sha256) {
    throw new Error('bound file identity mismatch');
  }
}
export function readModuleAdmissionInputs(filename: string, authoritySHA256: string): ModuleAdmissionInputs {
  verifyBoundFile({ path: filename, sha256: authoritySHA256 });
  const input = JSON.parse(readFileSync(filename, 'utf8')) as ModuleAdmissionInputs;
  if (input.schemaVersion !== 1 || !['linux-arm64', 'darwin-arm64'].includes(input.target)
    || !/^[a-f0-9]{40}$/.test(input.moduleSourceSHA) || !/^[a-f0-9]{40}$/.test(input.nativeBuildSourceSHA)
    || input.core?.sourceSHA !== input.moduleSourceSHA || input.driver?.sourceSHA !== input.moduleSourceSHA
    || !input.driver?.path?.endsWith('.mjs') || input.module?.name !== `@undefineds.co/xpod-afs-${input.target}`
    || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(input.module?.version ?? '')
    || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(input.module?.integrity ?? '')
    || [input.workspace, input.evidence, input.home].some(value => typeof value !== 'string' || !path.isAbsolute(value))) {
    throw new Error('module admission authority is invalid');
  }
  for (const value of [input.module, input.core, input.driver, input.native?.archive, input.native?.pins, input.runtimes?.node, input.runtimes?.bun]) verifyBoundFile(value);
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
  const script = `import importlib.util,json,pathlib,sys,zipfile,hashlib\nr=pathlib.Path(sys.argv[1]);sys.path.insert(0,str(r/'scripts/agentfs-native-ci'))\ns=importlib.util.spec_from_file_location('accept',r/'scripts/agentfs-native-ci/accept.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nf=m.verify_reuse_archive(pathlib.Path(sys.argv[2]),json.loads(pathlib.Path(sys.argv[3]).read_text()),sys.argv[4])\nwith zipfile.ZipFile(sys.argv[2]) as z:\n assert hashlib.sha256(z.read('native-receipt.json')).hexdigest()==sys.argv[5]\n assert hashlib.sha256(z.read('source-kit.json')).hexdigest()==sys.argv[6]\nprint(json.dumps(f))`;
  const child = spawn('python3', ['-c', script, input.workspace, input.native.archive.path, input.native.pins.path, input.target.split('-')[0], input.native.receiptSHA256, input.native.sourceKitSHA256],
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
  if (hashFile(pkgPath) !== input.module.manifestSHA256 || hashBytes(JSON.stringify(pkg.xpodModule.files)) !== input.module.inventorySHA256
    || hashFile(entry) !== input.module.entrySHA256 || hashFile(helper) !== input.module.helperSHA256
    || hashFile(path.join(directory, 'dist/library.cjs')) !== input.module.librarySHA256
    || hashFile(path.join(directory, 'node_modules/@undefineds.co/xpod-cli/dist/client.cjs')) !== input.module.clientSHA256) {
    throw new Error('installed module authority mismatch');
  }
  const provenance = JSON.parse(readFileSync(path.join(directory, 'provenance/native-reuse.json'), 'utf8'));
  const kit = JSON.parse(readFileSync(path.join(directory, 'provenance/module-source-kit.json'), 'utf8'));
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
  const launcher = path.join(input.evidence, 'module-core-launcher');
  writeFileSync(launcher, `#!/bin/sh\nunset NODE_PATH NODE_OPTIONS BUN_OPTIONS\nexport HOME=${quote(input.home)}\nexport SOLID_HOME=${quote(path.join(input.home, '.solid'))}\nexec ${quote(executable.path)} ${quote(input.core.path)} "$@"\n`, { flag: 'wx', mode: 0o700 });
  const binding = { profile: 'afs-module', moduleSourceSHA: input.moduleSourceSHA, nativeBuildSourceSHA: input.nativeBuildSourceSHA,
    moduleArchiveSHA256: input.module.sha256, moduleSRI: input.module.integrity, manifestSHA256: input.module.manifestSHA256,
    inventorySHA256: input.module.inventorySHA256, moduleSourceTreeSHA256: input.module.sourceTreeSHA256,
    coreSHA256: input.core.sha256, runtime, runtimePath: executable.path, runtimeVersion: version, runtimeSHA256: executable.sha256,
    installedEntry: entry, installedEntrySHA256: input.module.entrySHA256, installedHelper: helper, installedHelperSHA256: input.module.helperSHA256,
    installedLibrarySHA256: input.module.librarySHA256, installedClientSHA256: input.module.clientSHA256, storeRoot: store.root,
    transport: 'offline exact original artifact through ModuleStore; not registry publication acceptance' };
  writeFileSync(path.join(input.evidence, 'module-install.safe.json'), JSON.stringify(binding, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { helper, launcher, helperSha256: input.module.helperSHA256, launcherSha256: hashFile(launcher), entry, entrySha256: input.module.entrySHA256,
    binding, additionalTests: ['tests/agentfs-pod/installedModuleMountedChain.test.ts'], additionalRequiredCases: [MODULE_CHAIN_CASE],
    env: { ...isolatedModuleEnvironment(input.home, input.evidence),
      XPOD_AGENTFS_MODULE_ENTRY: entry, XPOD_AGENTFS_MODULE_RUNTIME: executable.path,
      XPOD_AGENTFS_MODULE_CORE: input.core.path, XPOD_AGENTFS_MODULE_STORE: store.root, XPOD_AGENTFS_MODULE_EVIDENCE: input.evidence } };
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
    XPOD_MOUNTED_EVIDENCE: input.evidence, XPOD_MOUNTED_OS: process.platform, XPOD_MOUNTED_BACKEND: process.platform === 'linux' ? 'fuse' : 'nfs',
    XPOD_MOUNTED_NODE: input.runtimes.node.path, XPOD_MOUNTED_REQUIRE_NOBUN: runtime === 'node' ? '1' : '0', XPOD_MOUNTED_MIN_PASSED: '7' });
  stage = 'actual-mounted-consumer'; const exit = await runMountedPlatformAdmission(product);
  stage = 'post-consumer-inventory';
  const chain = JSON.parse(readFileSync(path.join(input.evidence, 'module-chain.safe.json'), 'utf8'));
  const cleanup = JSON.parse(readFileSync(path.join(input.evidence, 'module-chain-cleanup.safe.json'), 'utf8'));
  if (exit !== 0 || chain.status !== 'executed' || !(chain.authExchanges > 0) || chain.entrySHA256 !== input.module.entrySHA256
    || chain.helperSHA256 !== input.module.helperSHA256 || cleanup.cleanupVerified !== true || cleanup.identitiesKnown !== true
    || cleanup.daemonsAbsent !== true || cleanup.kernelAbsent !== true || cleanup.groupsAbsent !== true
    || cleanup.unmountClosedSuccessfully !== true) throw new Error('actual module chain or cleanup proof incomplete');
  verifyBoundFile(input.module); verifyBoundFile(input.core); await new ModuleStore({ root: String(product.binding.storeRoot), platform: process.platform, arch: process.arch }).current('afs');
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
