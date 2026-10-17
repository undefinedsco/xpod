/** Fixed normal installed AFS bridge. No installer, artifact fetch override, or
 * materializeCliRuntime: the Python owner supplies an already normally installed
 * and fully reverified CLI/client/module. No JSON here issues an admission cap. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MODULE_TARGETS, modulePackageName } from '../../packages/xpod-cli/src/module-catalog';
import authority from '../agentfs-native-ci/mounted/native-authority.json';
import limits from './module-artifact-limits.json';
import { verifyNativeMaterialTarget } from './physical-module-native';
import { runMountedPlatformAdmission } from '../agentfs-native-ci/mounted/platform-admission';
import { defaultBackend } from '../../packages/xpod-afs/src/agent-fs/mount';
import { REQUIRED_MOUNTED_CASES, MODULE_CHAIN_CASE } from '../agentfs-native-ci/mounted/required-cases';

export function afsConsumerTarget(target: string, host?: { platform: string; arch: string }) {
  const row = MODULE_TARGETS.find(row => `${row.platform}-${row.arch}` === target);
  const native = (authority.artifacts as Record<string, unknown>)[target];
  if (!row || !native || host && (row.platform !== host.platform || row.arch !== host.arch)) throw Error('AFS target/host declaration mismatch');
  return { target, platform: row.platform, arch: row.arch, name: modulePackageName('afs', row.platform, row.arch)!,
    nativeSourceAvailable: true, status: 'production-declared-unverified' };
}
export interface AfsBoundFile { path: string; sha256: string }
function readAfsBoundFile(ref: AfsBoundFile, maximum: number, retainedMaximum: number): Buffer {
  if (!path.isAbsolute(ref.path) || lstatSync(ref.path).isSymbolicLink() || !/^[a-f0-9]{64}$/u.test(ref.sha256)) throw Error('AFS original binding required');
  const fd = openSync(ref.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maximum) throw Error('AFS original byte bound');
    const digest = createHash('sha256'), block = Buffer.alloc(65536), header = Buffer.alloc(Math.min(before.size, retainedMaximum));
    let count = 0;
    for (let size; (size = readSync(fd, block, 0, block.length, null)) > 0;) {
      digest.update(block.subarray(0, size)); block.copy(header, count, 0, Math.min(size, Math.max(0, header.length - count))); count += size;
    }
    const after = fstatSync(fd);
    if (count !== before.size || digest.digest('hex') !== ref.sha256 || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error('AFS original bytes changed');
    return header;
  } finally { closeSync(fd); }
}
export function verifyAfsBoundFile(ref: AfsBoundFile, maximum = 256 * 1024 ** 2): Buffer {
  return readAfsBoundFile(ref, maximum, 1024 * 1024);
}
/** Return the same-fd, fully verified small original; callers never reopen it. */
export function verifyAfsBoundBytes(ref: AfsBoundFile, maximum = limits.metadataBytes): Buffer {
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > limits.metadataBytes) throw Error('AFS JSON original byte bound');
  return readAfsBoundFile(ref, maximum, maximum);
}
export function verifyAfsHarnessSource(workspace: string, sourceSha: string): void {
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim() !== sourceSha
    || execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: workspace }).length !== 0) throw Error('AFS harness immutable clean source required');
}
export interface AfsInstalledConsumerHandoff {
  schemaVersion: 1; sourceSha: string; target: string; workspace: string; evidence: string; home: string;
  packageRoot: string; packageManifest: AfsBoundFile; storeRoot: string; runtime: 'node' | 'bun';
  archive: AfsBoundFile; helper: AfsBoundFile; entry: AfsBoundFile; launcher: AfsBoundFile;
  cliCore: AfsBoundFile; node: AfsBoundFile; selectedRuntime: AfsBoundFile;
  /** Original producer-bundled negative-contract tool only; never used to install. */
  preflightDriver: AfsBoundFile; runtimes: { node: AfsBoundFile; bun: AfsBoundFile };
}
export async function runInstalledAfsMounted(handoff: AfsInstalledConsumerHandoff) {
  if (handoff.schemaVersion !== 1 || !['node', 'bun'].includes(handoff.runtime) || !/^[a-f0-9]{40}$/u.test(handoff.sourceSha)) throw Error('AFS installed handoff invalid');
  const target = afsConsumerTarget(handoff.target, { platform: process.platform, arch: process.arch });
  const workspace = realpathSync(handoff.workspace), root = realpathSync(handoff.packageRoot);
  verifyAfsHarnessSource(workspace, handoff.sourceSha);
  for (const ref of [handoff.helper, handoff.entry]) if (!realpathSync(ref.path).startsWith(root + path.sep)) throw Error('AFS installed member escaped package');
  for (const ref of [handoff.archive, handoff.helper, handoff.entry, handoff.launcher, handoff.cliCore, handoff.node, handoff.selectedRuntime, handoff.preflightDriver, handoff.runtimes.node, handoff.runtimes.bun]) verifyAfsBoundFile(ref, ref === handoff.archive ? limits.packedBytes : undefined);
  verifyNativeMaterialTarget(verifyAfsBoundFile(handoff.helper), handoff.target);
  if (handoff.packageManifest.path !== path.join(root, 'package.json')) throw Error('AFS installed manifest path differs');
  const pkg = JSON.parse(verifyAfsBoundBytes(handoff.packageManifest).toString('utf8'));
  if (pkg.name !== target.name || pkg.xpodModule?.id !== 'afs') throw Error('AFS actual installed package differs');
  const binding = { profile: 'afs-normal-installed-consumer', moduleSourceSHA: handoff.sourceSha,
    target: handoff.target, runtime: handoff.runtime, installedEntry: handoff.entry.path, installedEntrySHA256: handoff.entry.sha256,
    installedHelper: handoff.helper.path, installedHelperSHA256: handoff.helper.sha256 };
  Object.assign(process.env, { XPOD_MOUNTED_ARCHIVE: handoff.archive.path, XPOD_MOUNTED_ARCHIVE_SHA: handoff.archive.sha256,
    XPOD_MOUNTED_HELPER_SHA: handoff.helper.sha256, XPOD_MOUNTED_WORKSPACE: workspace, XPOD_MOUNTED_NODE: handoff.node.path,
    XPOD_MOUNTED_EVIDENCE: handoff.evidence, XPOD_MOUNTED_OS: target.platform, XPOD_MOUNTED_ARCH: target.arch,
    XPOD_MOUNTED_BACKEND: defaultBackend(target.platform), XPOD_MOUNTED_MIN_PASSED: String(new Set([...REQUIRED_MOUNTED_CASES, MODULE_CHAIN_CASE]).size), XPOD_MOUNTED_REQUIRE_NOBUN: handoff.runtime === 'node' ? '1' : '0' });
  const env = { ...process.env, HOME: handoff.home, SOLID_HOME: path.join(handoff.home, '.solid'),
    XPOD_AGENTFS_MODULE_ENTRY: handoff.entry.path, XPOD_AGENTFS_MODULE_RUNTIME: handoff.selectedRuntime.path,
    XPOD_AGENTFS_MODULE_CORE: handoff.cliCore.path, XPOD_AGENTFS_MODULE_STORE: handoff.storeRoot,
    XPOD_AGENTFS_MODULE_EVIDENCE: handoff.evidence,
    XPOD_AGENTFS_ADMISSION_FIXTURE: JSON.stringify({ driver: handoff.preflightDriver, runtimes: handoff.runtimes }) };
  const exit = await runMountedPlatformAdmission({ helper: handoff.helper.path, helperSha256: handoff.helper.sha256,
    entry: handoff.entry.path, entrySha256: handoff.entry.sha256, launcher: handoff.launcher.path, launcherSha256: handoff.launcher.sha256,
    binding, env, additionalTests: ['tests/agentfs-pod/installedModuleMountedChain.test.ts'], additionalRequiredCases: [MODULE_CHAIN_CASE] });
  if (exit !== 0) throw Error('AFS complete mounted profile failed');
  const readObservedJson = (name: string) => {
    const fd = openSync(path.join(handoff.evidence, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.size > limits.metadataBytes) throw Error('AFS mounted JSON byte bound');
      const bytes = Buffer.alloc(before.size); let count = 0;
      while (count < bytes.length) {
        const size = readSync(fd, bytes, count, Math.min(65536, bytes.length - count), null);
        if (!size) throw Error('AFS mounted JSON truncated'); count += size;
      }
      const after = fstatSync(fd);
      if (before.size !== after.size || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error('AFS mounted JSON changed');
      return JSON.parse(bytes.toString('utf8'));
    } finally { closeSync(fd); }
  };
  const chain = readObservedJson('module-chain.safe.json');
  const cleanup = readObservedJson('module-chain-cleanup.safe.json');
  if (chain.status !== 'executed' || chain.actualAuthenticatedRead !== true || chain.actualConditionalWriteback !== true
    || !cleanup.cleanupVerified || !cleanup.kernelAbsent || !cleanup.daemonsAbsent || !cleanup.groupsAbsent || !cleanup.identitiesKnown) throw Error('AFS actual authenticated chain/cleanup incomplete');
  for (const ref of [handoff.archive, handoff.helper, handoff.entry, handoff.launcher, handoff.cliCore, handoff.selectedRuntime]) verifyAfsBoundFile(ref, ref === handoff.archive ? limits.packedBytes : undefined);
  verifyAfsBoundBytes(handoff.packageManifest);
  verifyAfsHarnessSource(workspace, handoff.sourceSha);
  return { status: 'complete-mounted-profile-verified', target: handoff.target, runtime: handoff.runtime,
    requiredCases: [...REQUIRED_MOUNTED_CASES, MODULE_CHAIN_CASE], authenticatedRead: true, conditionalWriteback: true, cleanupVerified: true };
}
if (import.meta.main) {
  try {
    if (process.argv[2] === 'target') {
      if (process.argv.length !== 4 && !(process.argv.length === 5 && process.argv[4] === '--require-host')) throw Error('Fixed AFS target arguments required');
      console.log(JSON.stringify(afsConsumerTarget(process.argv[3]!, process.argv[4] === '--require-host' ? { platform: process.platform, arch: process.arch } : undefined)));
    } else {
      if (process.argv.length !== 4) throw Error('Bound handoff path and SHA required');
      const ref = { path: process.argv[2]!, sha256: process.argv[3]! };
      const bytes = verifyAfsBoundBytes(ref, 1024 * 1024);
      console.log(JSON.stringify(await runInstalledAfsMounted(JSON.parse(bytes.toString('utf8')))));
    }
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
