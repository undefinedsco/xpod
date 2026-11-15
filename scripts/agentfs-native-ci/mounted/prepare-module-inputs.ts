import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyModuleClientMaterials, moduleClientPath, hashBytes, hashFile, verifyBoundFile, type ModuleAdmissionInputs } from './module-admission';
import { isolatedModuleEnvironment } from './module-admission';
import { observeChildLifecycle, reapOwnedGroup } from './platform-admission';
import { installedConsumerWatchdogMs, INSTALLED_CONSUMER_PARENT_MS, INSTALLED_CONSUMER_CLEANUP_MS } from './owned-installed-consumer';
import { MODULE_INSTALL_PHASES, MODULE_INSTALL_DIAGNOSTIC_LIMIT, type ModuleInstallPhaseEvent } from '../../../packages/xpod-cli/src/module-install-diagnostics';

import nativeAuthority from './native-authority.json';
const { source, artifacts } = nativeAuthority;
export function nativeFacts(target: string) {
  if (!Object.prototype.hasOwnProperty.call(artifacts, target)) throw new Error('unsupported module target');
  const facts = artifacts[target as keyof typeof artifacts]; const prefix = target.split('-')[0].toUpperCase();
  return { source, run: nativeAuthority.run, artifactID: facts.id, zipSHA256: facts.zip,
    pins: { PRODUCT_SHA: source, PRODUCT_TARGET: target, [`${prefix}_ZIP_SHA`]: facts.zip, [`${prefix}_ARCHIVE_SHA`]: facts.archive, [`${prefix}_HELPER_SHA`]: facts.helper } };
}
// Collect actual serialized archive bytes, never a separately trusted staging directory.
const collectArchive = `import tarfile,hashlib,json,sys,posixpath,tempfile
with tarfile.open(sys.argv[1],'r|gz') as t:
 seen=set(); hashes={}; documents={}; sources={}; clientSources={}
 for m in t:
  n=m.name.rstrip('/')
  if n in seen or not (n=='package' or n.startswith('package/')) or '..' in n.split('/') or posixpath.isabs(n): raise ValueError('unsafe or duplicate archive member')
  seen.add(n)
  if m.isdir(): continue
  if not m.isfile(): raise ValueError('nonregular archive member')
  h=hashlib.sha256(); chunks=[]; total=0
  nested=tempfile.SpooledTemporaryFile(max_size=8388608) if n in ['package/sources/module-source.tar.gz','package/sources/cli-client-source.tar.gz'] else None
  f=t.extractfile(m)
  while True:
   b=f.read(1048576)
   if not b: break
   h.update(b); total+=len(b)
   if nested is not None: nested.write(b)
   if n in ['package/package.json','package/provenance/native-reuse.json','package/provenance/module-source-kit.json','package/provenance/cli-producer-materials.json','package/provenance/cli-client-source-inventory.json']:
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
     (sources if n=='package/sources/module-source.tar.gz' else clientSources)[sn]={'sha256':sh.hexdigest(),'bytes':size}
   nested.close()
 print(json.dumps({'hashes':hashes,'documents':documents,'sources':sources,'clientSources':clientSources}))`;
interface Collected { hashes: Record<string, { sha256: string; size: number; mode: number }>; documents: Record<string, any>; sources: Record<string, { sha256: string; bytes: number }>; clientSources: Record<string, { sha256: string; bytes: number }> }
export function collectModule(archive: string, target: string, sourceSHA: string, nativeReceipt: string, nativeKit: string) {
  const c = JSON.parse(execFileSync('python3', ['-c', collectArchive, archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })) as Collected;
  return validateCollectedModule(c, target, sourceSHA, nativeReceipt, nativeKit);
}
function validateCollectedModule(c: Collected, target: string, sourceSHA: string, nativeReceipt: string, nativeKit: string) {
  nativeFacts(target);
  const pkg = c.documents['package.json']; const kit = c.documents['provenance/module-source-kit.json']; const reuse = c.documents['provenance/native-reuse.json'];
  if (pkg?.name !== `@undefineds.co/xpod-afs-${target}` || pkg?.xpodModule?.schemaVersion !== 1 || pkg.xpodModule.id !== 'afs'
    || pkg.xpodModule.platform !== target.split('-')[0] || pkg.xpodModule.arch !== target.split('-')[1] || pkg.xpodModule.entry !== 'dist/entry.mjs'
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
  const clientPath = moduleClientPath(kit, name => { if (!c.hashes[name]) throw new Error('missing runtime client member'); return c.hashes[name]; }, Object.keys(c.hashes));
  verifyModuleClientMaterials(kit, name => { if (!c.hashes[name]) throw new Error('missing runtime client producer member'); return c.hashes[name]; }, name => c.documents[name], c.clientSources);
  if (reuse?.moduleSourceDirty !== false || reuse.moduleSourceSHA !== sourceSHA || reuse.nativeBuildSourceSHA !== source
    || reuse.moduleSourceTreeSHA256 !== tree || kit?.dirty !== false || kit.moduleSourceSHA !== sourceSHA || kit.moduleSourceTreeSHA256 !== tree
    || kit.publicClientPayloadSHA256 !== member(clientPath)
    || member('provenance/native-build.receipt.json') !== nativeReceipt || member('provenance/native-source-kit.json') !== nativeKit
    || member('helper/agentfs-pod') !== artifacts[target as keyof typeof artifacts]?.helper) throw new Error('module provenance mismatch');
  return { name: pkg.name as string, version: pkg.version as string, manifestSHA256: member('package.json'), inventorySHA256: hashBytes(JSON.stringify(pkg.xpodModule.files)),
    sourceTreeSHA256: tree, helperSHA256: member('helper/agentfs-pod'), entrySHA256: member('dist/entry.mjs'), librarySHA256: member('dist/library.cjs'), clientSHA256: member(clientPath) };
}
type Projection = 'string' | 'number' | 'boolean' | { [key: string]: Projection } | readonly [Projection];
const fields = (type: 'string' | 'number' | 'boolean', names: string): Record<string, Projection> => Object.fromEntries(names.split(' ').map(name => [name, type]));
const lifecycle: Projection = { ...fields('number', 'pid exit'), ...fields('boolean', 'exitObserved closeObserved'), signal: 'string' };
const child: Projection = { ...fields('string', 'command state signal groupStateAfterClose stdoutSHA256 stderrSHA256'), code: 'number', rawClosedBeforeHash: 'boolean', lifecycle };
const binding: Record<string, Projection> = { ...fields('string', 'profile moduleSourceSHA nativeBuildSourceSHA moduleArchiveSHA256 moduleSRI manifestSHA256 inventorySHA256 moduleSourceTreeSHA256 coreSHA256 runtime runtimePath runtimeVersion runtimeSHA256 installedEntry installedEntrySHA256 installedHelper installedHelperSHA256 installedLibrarySHA256 installedClientSHA256 installedClientPath storeRoot transport'),
  ...fields('string', 'inputAuthoritySHA256 driverSHA256 chainReceiptSHA256 chainCleanupReceiptSHA256 platformReceiptSHA256'), actualPlatformExit: 'number', moduleAndCoreArtifactUnchanged: 'boolean', installedInventoryReverified: 'boolean' };
const close: Projection = { ...fields('number', 'exit'), ...fields('string', 'signal rawSHA256 resourceStop supervisorError'), ...fields('boolean', 'actualWait rawClosedBeforeHash ownedGroupAbsentAfterWait'), cleanupErrors: ['string'] };
const installedObservation: Projection = { ...fields('number', 'timeoutMs elapsedMs parentDeadlineMonotonicMs startedMonotonicMs'), ...fields('boolean', 'timeoutObserved closeObserved groupClosed') };
const installPhase: Projection = { ...fields('string', 'kind phase state'), ...fields('number', 'elapsedMs durationMs') };
const installedSummary: Projection = { bytes: 'number', truncated: 'boolean', codes: ['string'], installPhases: [installPhase], installPhasesTruncated: 'boolean' };
const installedStage: Projection = { observation: installedObservation, ...fields('string', 'stage actualSignal stdoutSHA256 stderrSHA256'), ...fields('number', 'pid actualExit'), ...fields('boolean', 'actualWait rawClosed groupAbsent'), installPhases: [installPhase], installPhasesTruncated: 'boolean' };
const installedProxy: Projection = { pid: 'number', groupAbsent: 'boolean', tokenFixtureObserved: 'boolean', nativeMountStarted: 'boolean' };
export const INSTALLED_CONSUMER_STAGES = ['public-workcopy-types-Node16', 'public-workcopy-types-Node', 'node-esm-public-runtime', 'node-status', 'node-workcopy-sqlite', 'bun-esm-public-runtime', 'bun-status', 'bun-workcopy-sqlite', 'node-startup-cancel',
  'node-cli-before-list', 'node-cli-install', 'node-cli-installed-list', 'node-cli-tampered-list', 'node-cli-remove', 'node-cli-removed-list',
  'bun-cli-before-list', 'bun-cli-install', 'bun-cli-installed-list', 'bun-cli-tampered-list', 'bun-cli-remove', 'bun-cli-removed-list'] as const;
const platform: Projection = { ...fields('number', 'schemaVersion exit passedCases minPassedCases'), ...fields('string', 'os backend nodePath nodeVersion nodeSha256 nativeRg nativeRgVersion nativeRgSha256 productArchiveSha256 installedHelperSha256 installedLauncherPath harnessRunnerSha256 producerState rawLog rawSHA256 snapshotSHA256 status failureReason signal'),
  ...fields('boolean', 'producerStarted producerClosed actualWait rawClosedBeforeHash ownedGroupAbsent consumerBunVisible mountExecuted'), moduleBinding: binding, producerLifecycle: lifecycle,
  ownedProcessObservations: [{ phase: 'string', known: 'boolean', reason: 'string', members: [{ ...fields('number', 'pid ppid pgid'), state: 'string' }] }],
  vitestReport: { ...fields('string', 'path sha256'), requiredCases: ['string'], requiredSatisfied: 'boolean', missingRequired: ['string'], notPassed: [{ title: 'string', status: 'string' }] } };
const receipts: Record<string, Projection> = {
  'module-install.safe.json': binding,
  'module-admission.safe.json': binding,
  'cli-bare-bootstrap.safe.json': { ...fields('string', 'runtime coreSHA256 stdoutSHA256 stderrSHA256 category'), actualExit: 'number', actualSignal: 'string', actualWait: 'boolean' },
  'cli-runtime.safe.json': { ...fields('string', 'runtime directory binSHA256 coreSHA256 clientCoreSHA256 cliArchiveSHA256 clientArchiveSHA256 bootstrapStdoutSHA256 bootstrapStderrSHA256 scope'),
    bootstrapActualExit: 'number', bootstrapSignal: 'string', bootstrapActualWait: 'boolean' },
  'cli-runtime-final.safe.json': { ...fields('string', 'runtime directory binSHA256 coreSHA256 clientCoreSHA256 cliArchiveSHA256 clientArchiveSHA256 bootstrapStdoutSHA256 bootstrapStderrSHA256 scope'),
    bootstrapActualExit: 'number', bootstrapSignal: 'string', bootstrapActualWait: 'boolean', inventoryReverified: 'boolean' },
  'native-reuse.safe.json': { lifecycle, ...fields('string', 'state signal rawPath rawSHA256 nativeBuildSourceSHA archiveSHA256 pinsSHA256'), code: 'number', groupAbsent: 'boolean', rawClosedBeforeHash: 'boolean' },
  'module-chain.safe.json': { ...fields('string', 'status entry entrySHA256 helper helperSHA256 runtime runtimeSHA256 launcherSHA256 proxyCommandSHA256 nativeCommandSHA256 proxyOwnerSHA256'), authExchanges: 'number', ownedPids: ['number'], children: [child], ...fields('boolean', 'actualAuthenticatedRead actualConditionalWriteback daemonAbsenceProven kernelAbsent') },
  'module-chain-failure.safe.json': { ...fields('string', 'backend stage errorCode errorSHA256'), primaryFailureObserved: 'boolean' },
  'module-chain-cleanup.safe.json': { ...fields('boolean', 'cleanupVerified kernelAbsent daemonsAbsent groupsAbsent identitiesKnown proxyIdentityObserved nativeIdentityObserved unmountClosedSuccessfully sceneRetained'), ownedPids: ['number'], ownedGroups: ['number'], children: [child] },
  'module-admission-failure.safe.json': { ...fields('string', 'status stage nativeReceiptPresent mountedReceiptPresent cleanupClaim'), accepted: 'boolean' },
  'mounted-linux.receipt.json': platform, 'mounted-darwin.receipt.json': platform,
  'installed-consumer.safe.json': { ...fields('string', 'status archiveSHA256 moduleSourceSHA manifestSHA256 rawSHA256 sourceTestSHA256 sourceHelperSHA256 nodeVersion bunVersion'),
    ...fields('boolean', 'accepted producerClosed groupAbsent rawClosedBeforeHash'), code: 'number', signal: 'string', lifecycle,
    passed: 'number', failed: 'number', skipped: 'number', stages: [installedStage],
    proxyCancel: installedProxy },
  'installed-consumer-failure.safe.json': { diagnosticOnly: 'boolean', accepted: 'boolean', category: 'string', receiptInventoryState: 'string',
    producerClosed: 'boolean', groupAbsent: 'boolean', rawClosedBeforeHash: 'boolean', producerExit: 'number', producerSignal: 'string',
    parentRawSHA256: 'string', lastObservedStage: 'string', observedStages: [{ ...installedStage, rawHashesBound: 'boolean', summary: { stdout: installedSummary, stderr: installedSummary } }] },
  'linux-container-binding.json': { ...fields('string', 'state cid observationPhase'), validationFailures: ['string'], ...fields('boolean', 'released containerAbsent'), pid1Seccomp: 'number', daemonSecurityOptions: ['string'], consumerReceipt: close, removalReceipt: close,
    container: { ...fields('string', 'cid imageID AppArmorProfile NetworkMode status'), ...fields('boolean', 'running privileged paused restarting dead'), SecurityOpt: ['string'], CapAdd: ['string'], CapDrop: ['string'],
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
export const MODULE_CHAIN_STAGES = ['mount', 'kernel-identity', 'proxy-identity', 'native-identity', 'read', 'writeback', 'unmount', 'final-verification'] as const;
export const MODULE_CHAIN_ERROR_CODES = ['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'unknown'] as const;
const INSTALLED_SUMMARY_CODES = ['sqlite-experimental-warning', 'ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'ETIMEDOUT', 'ECONNRESET', 'cli-ok', 'cli-error', 'module_install_failed', 'module_metadata_invalid', 'module_integrity_failed', 'module_download_failed'] as const;
function validInstalledObservation(row: any, stage: string): boolean {
  const hasParent = row?.parentDeadlineMonotonicMs !== undefined || row?.startedMonotonicMs !== undefined;
  const parentBound = !hasParent || Number.isFinite(row.parentDeadlineMonotonicMs) && Number.isFinite(row.startedMonotonicMs)
    && row.startedMonotonicMs >= 0 && row.elapsedMs <= row.parentDeadlineMonotonicMs - row.startedMonotonicMs
    && row.parentDeadlineMonotonicMs - row.startedMonotonicMs <= INSTALLED_CONSUMER_PARENT_MS
    && row.timeoutMs <= Math.floor(row.parentDeadlineMonotonicMs - row.startedMonotonicMs - INSTALLED_CONSUMER_CLEANUP_MS);
  return row === undefined || row && parentBound && Number.isInteger(row.timeoutMs) && row.timeoutMs > 0
    && row.timeoutMs <= installedConsumerWatchdogMs(stage, hasParent ? INSTALLED_CONSUMER_PARENT_MS : undefined)
    && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 && row.elapsedMs <= 86_400_000
    && ['timeoutObserved', 'closeObserved', 'groupClosed'].every(key => typeof row[key] === 'boolean');
}
function validInstalledSummary(row: any): boolean {
  return row && Number.isSafeInteger(row.bytes) && row.bytes >= 0 && typeof row.truncated === 'boolean'
    && Array.isArray(row.codes) && row.codes.length <= INSTALLED_SUMMARY_CODES.length
    && new Set(row.codes).size === row.codes.length && row.codes.every((code: any) => INSTALLED_SUMMARY_CODES.includes(code))
    && (row.installPhases === undefined || validInstallPhases(row.installPhases))
    && (row.installPhasesTruncated === undefined || typeof row.installPhasesTruncated === 'boolean');
}
function validInstallPhase(row: any): row is ModuleInstallPhaseEvent {
  return row && typeof row === 'object' && !Array.isArray(row) && row.kind === 'module-install-phase'
    && Object.keys(row).every(key => ['kind', 'phase', 'state', 'elapsedMs', 'durationMs'].includes(key))
    && MODULE_INSTALL_PHASES.includes(row.phase) && ['started', 'completed', 'failed'].includes(row.state)
    && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 && row.elapsedMs <= 86_400_000
    && (row.state === 'started' ? row.durationMs === undefined : Number.isFinite(row.durationMs)
      && row.durationMs >= 0 && row.durationMs <= row.elapsedMs + 0.001);
}
/** A bounded chronological prefix may end with an interrupted started phase. */
function validInstallPhases(rows: any): rows is ModuleInstallPhaseEvent[] {
  if (!Array.isArray(rows) || rows.length > MODULE_INSTALL_DIAGNOSTIC_LIMIT) return false;
  let active: string | undefined; let elapsed = 0;
  for (const row of rows) {
    if (!validInstallPhase(row) || row.elapsedMs < elapsed) return false;
    elapsed = row.elapsedMs;
    if (row.state === 'started') { if (active) return false; active = row.phase; }
    else { if (active !== row.phase) return false; active = undefined; }
  }
  return true;
}
/** Read only a bounded prefix after the caller has verified raw custody and closure. */
function summarizeInstalledStream(file: string, allowInstallPhases = false) {
  const fd = openSync(file, 'r');
  try {
    const bytes = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(bytes, 64 * 1024));
    let offset = 0;
    while (offset < buffer.length) { const count = readSync(fd, buffer, offset, buffer.length - offset, offset); if (!count) break; offset += count; }
    const text = buffer.subarray(0, offset).toString('utf8').replace(/\u001b\[[0-9;]*m/g, '');
    const codes = new Set<string>();
    const installPhases: ModuleInstallPhaseEvent[] = []; let installPhasesTruncated = false;
    const inspectJSON = (value: string, inspectPhases = false) => {
      try {
        const json = JSON.parse(value);
        if (json?.ok === true) codes.add('cli-ok');
        if (json?.ok === false) codes.add('cli-error');
        if (typeof json?.code === 'string' && INSTALLED_SUMMARY_CODES.includes(json.code)) codes.add(json.code);
        if (allowInstallPhases && inspectPhases && json?.kind === 'module-install-phase') {
          if (!installPhasesTruncated && validInstallPhases([...installPhases, json])) installPhases.push(json);
          else installPhasesTruncated = true;
        }
      } catch { /* Arbitrary text is never projected. */ }
    };
    if (offset === bytes) inspectJSON(text);
    for (const line of text.split('\n').slice(0, 1024)) {
      if (/^(?:\(node:[0-9]+\) )?ExperimentalWarning: SQLite is an experimental feature and might change at any time$/.test(line)) codes.add('sqlite-experimental-warning');
      const error = /^(?:npm (?:ERR!|error) code |error code: )(E[A-Z]+)$/.exec(line)?.[1];
      if (error && INSTALLED_SUMMARY_CODES.includes(error as any)) codes.add(error);
      if (line.length <= 4096) inspectJSON(line, true);
      else if (allowInstallPhases) installPhasesTruncated = true;
    }
    return { bytes, truncated: offset < bytes || text.split('\n').length > 1024, codes: [...codes],
      installPhases, installPhasesTruncated: installPhasesTruncated || installPhases.length === MODULE_INSTALL_DIAGNOSTIC_LIMIT
        || allowInstallPhases && (offset < bytes || text.split('\n').length > 1024) };
  } finally { closeSync(fd); }
}
export function projectReceipt(name: string, original: unknown): unknown {
  if (name === 'linux-container-binding.json') {
    const row = original as Record<string, unknown> | null;
    const codes = ['cid', 'imageID', 'privileged', 'AppArmorProfile', 'NetworkMode', 'SecurityOpt', 'Devices', 'CapAdd', 'CapDrop', 'Mounts', 'container-state', 'daemon-seccomp', 'pid1-seccomp', 'readiness-deadline'];
    const container = row?.container as Record<string, unknown> | undefined;
    if (row?.validationFailures !== undefined && (!Array.isArray(row.validationFailures) || row.validationFailures.length > codes.length
      || row.validationFailures.some(code => typeof code !== 'string' || code.length > 32 || !codes.includes(code)))
      || row?.observationPhase !== undefined && (typeof row.observationPhase !== 'string' || !['readiness', 'final'].includes(row.observationPhase))
      || container?.status !== undefined && (typeof container.status !== 'string' || !['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'].includes(container.status))) throw new Error('invalid container binding diagnostic');
    return projectBySchema(original, receipts[name]);
  }

  if (name === 'cli-bare-bootstrap.safe.json') {
    const row = original as Record<string, any> | null; const schema = receipts[name] as Record<string, Projection>;
    if (!row || Object.keys(row).some(key => !(key in schema)) || !['node', 'bun'].includes(row.runtime)
      || row.actualWait !== true || row.actualSignal !== null || !Number.isSafeInteger(row.actualExit) || row.actualExit <= 0
      || row.category !== 'missing_public_runtime_client'
      || !['coreSHA256', 'stdoutSHA256', 'stderrSHA256'].every(key => typeof row[key] === 'string' && /^[a-f0-9]{64}$/.test(row[key]))) throw new Error('invalid bare CLI bootstrap receipt');
    return projectBySchema(row, schema);
  }
  if (name === 'cli-runtime.safe.json' || name === 'cli-runtime-final.safe.json') {
    const row = original as Record<string, any> | null;
    const schema = receipts[name] as Record<string, Projection>;
    if (!row || Object.keys(row).some(key => !(key in schema)) || !['node', 'bun'].includes(row.runtime)
      || typeof row.directory !== 'string' || !path.isAbsolute(row.directory) || !/^xpod-afs-cli-runtime-[A-Za-z0-9]+$/.test(path.basename(row.directory))
      || !['binSHA256', 'coreSHA256', 'clientCoreSHA256', 'cliArchiveSHA256', 'clientArchiveSHA256', 'bootstrapStdoutSHA256', 'bootstrapStderrSHA256'].every(key => typeof row[key] === 'string' && /^[a-f0-9]{64}$/.test(row[key]))
      || row.bootstrapActualWait !== true || row.bootstrapActualExit !== null && (!Number.isSafeInteger(row.bootstrapActualExit) || row.bootstrapActualExit < 0)
      || row.bootstrapSignal !== null && !/^SIG[A-Z0-9]+$/.test(row.bootstrapSignal)
      || row.scope !== 'Exact validated tar dependency layout; not package-manager installation or registry publication'
      || name === 'cli-runtime-final.safe.json' && row.inventoryReverified !== true) throw new Error('invalid CLI bootstrap receipt');
    return projectBySchema(row, schema);
  }
  if (name === 'installed-consumer.safe.json') {
    const row = original as Record<string, any> | null;
    if (Array.isArray(row?.stages) && row.stages.some((stage: any) => !validInstalledObservation(stage.observation, stage.stage) || stage.installPhases !== undefined
      && (!validInstallPhases(stage.installPhases) || !['node-cli-install', 'bun-cli-install'].includes(stage.stage)
        || row?.producerClosed !== true || row?.groupAbsent !== true || row?.rawClosedBeforeHash !== true
        || stage.actualWait !== true || stage.rawClosed !== true || stage.groupAbsent !== true
        || !['stdoutSHA256', 'stderrSHA256'].every(key => typeof stage[key] === 'string' && /^[a-f0-9]{64}$/.test(stage[key])))
      || stage.installPhasesTruncated !== undefined && typeof stage.installPhasesTruncated !== 'boolean')) throw new Error('invalid installed phase diagnostic');
  }
  if (name === 'installed-consumer-failure.safe.json') {
    const row = original as Record<string, any> | null;
    const validHash = (value: unknown) => value === null || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const validExit = (value: unknown) => value === null || Number.isSafeInteger(value) && Number(value) >= 0;
    if (!row || row.diagnosticOnly !== true || row.accepted !== false
      || !INSTALLED_FAILURE_CATEGORIES.includes(row.category)
      || !['observed', 'missing', 'ambiguous', 'invalid', 'unknown'].includes(row.receiptInventoryState)
      || row.lastObservedStage !== null && !INSTALLED_CONSUMER_STAGES.includes(row.lastObservedStage)
      || !['producerClosed', 'groupAbsent', 'rawClosedBeforeHash'].every(key => typeof row[key] === 'boolean')
      || !validExit(row.producerExit) || installedSignal(row.producerSignal) !== row.producerSignal || !validHash(row.parentRawSHA256)
      || row.parentRawSHA256 !== null && !(row.producerClosed && row.groupAbsent && row.rawClosedBeforeHash)
      || !Array.isArray(row.observedStages) || row.observedStages.length > INSTALLED_CONSUMER_STAGES.length
      || new Set(row.observedStages.map((stage: any) => stage.stage)).size !== row.observedStages.length
      || row.observedStages.some((stage: any) => !INSTALLED_CONSUMER_STAGES.includes(stage.stage)
        || !Number.isSafeInteger(stage.pid) || stage.pid <= 1 || !validExit(stage.actualExit) || installedSignal(stage.actualSignal) !== stage.actualSignal
        || !['actualWait', 'rawClosed', 'groupAbsent', 'rawHashesBound'].every(key => typeof stage[key] === 'boolean')
        || !validInstalledObservation(stage.observation, stage.stage)
        || stage.installPhases !== undefined && (!validInstallPhases(stage.installPhases) || !stage.rawHashesBound || !['node-cli-install', 'bun-cli-install'].includes(stage.stage))
        || stage.summary != null && (!stage.rawHashesBound || !validInstalledSummary(stage.summary.stdout) || !validInstalledSummary(stage.summary.stderr))
        || !validHash(stage.stdoutSHA256) || !validHash(stage.stderrSHA256)
        || stage.rawHashesBound && stage.observation && (!stage.observation.closeObserved || !stage.observation.groupClosed)
        || stage.rawHashesBound && !(row.producerClosed && row.groupAbsent && row.rawClosedBeforeHash && stage.actualWait && stage.rawClosed && stage.groupAbsent && stage.stdoutSHA256 !== null && stage.stderrSHA256 !== null)
        || !stage.rawHashesBound && (stage.stdoutSHA256 !== null || stage.stderrSHA256 !== null))) throw new Error('invalid installed failure diagnostic');
  }
  if (name === 'module-chain-failure.safe.json') {
    const row = original as Record<string, unknown> | null;
    if (!row || typeof row.backend !== 'string' || !['fuse', 'nfs'].includes(row.backend)
      || !MODULE_CHAIN_STAGES.includes(row.stage as typeof MODULE_CHAIN_STAGES[number])
      || !MODULE_CHAIN_ERROR_CODES.includes(row.errorCode as typeof MODULE_CHAIN_ERROR_CODES[number])
      || typeof row.errorSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.errorSHA256)
      || row.primaryFailureObserved !== true) throw new Error('invalid module chain failure receipt');
  }
  const schema = receipts[name]; if (!schema) throw new Error('unapproved receipt'); return projectBySchema(original, schema);
}
const diagnosticKernelState = (value: unknown) => typeof value === 'string' && ['absent', 'mounted', 'unknown'].includes(value) ? value : 'unknown';
const diagnosticEnum = (value: unknown, choices: string[]) => typeof value === 'string' && choices.includes(value) ? value : 'unknown';
const projectKernelObservation = (value: any) => ({ state: diagnosticKernelState(value?.state),
  reason: typeof value?.reason === 'string' && value.reason.startsWith('classify-unknown:') ? 'classify-unknown' : diagnosticEnum(value?.reason,
    ['invalid-mount-path', 'python-observer-nonzero', 'json-parse-failed', 'mountinfo-parse-failed', 'unsupported-platform', 'observer-threw', 'classify-absent', 'classify-mounted']),
  classifyReason: typeof value?.classifyReason === 'string' && /^(malformed-row:|ancestor-mount:)/.test(value.classifyReason) ? value.classifyReason.split(':')[0]
    : diagnosticEnum(value?.classifyReason, ['invalid-root', 'empty-rows', 'target-mounted', 'unknown-ancestor-type', 'no-baseline', 'baseline-present']),
  errorCode: value?.errorCode == null ? null : diagnosticEnum(value.errorCode, ['ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOTCONN', 'ENODEV', 'ETIMEDOUT', 'EINVAL', 'ENOSYS', 'ENOTDIR', 'ELOOP', 'EBUSY']),
});
const projectCommandResult = (value: any) => {
  const text = [value?.stdout, value?.stderr].filter(v => typeof v === 'string').join('\n').toLowerCase();
  let failure = value?.state === 'closed' && value.actualExit === 0 ? 'none' : 'unclassified';
  for (const [phrase, code] of [
    ['crashed runtime kernel binding changed or unknown', 'crashed-kernel-binding-mismatch'],
    ['runtime identity', 'runtime-identity-mismatch'], ['socket binding', 'socket-binding-mismatch'],
    ['unmount child failed', 'unmount-child-failed'], ['transport endpoint is not connected', 'disconnected-fuse'],
    ['permission denied', 'permission-denied'],
  ]) if (text.includes(phrase)) { failure = code; break; }
  return { state: ['closed', 'pending', 'spawn-error'].includes(value?.state) ? value.state : 'unknown',
    actualExit: Number.isInteger(value?.actualExit) ? value.actualExit : null,
    signal: value?.signal === null ? null : ['SIGTERM', 'SIGKILL', 'SIGINT'].includes(value?.signal) ? value.signal : 'unknown',
    failure, errorSHA256: text ? hashBytes(text) : null };
};

/** Diagnostic only: fixed enums and closed command facts, never admission or free error text. */
export function projectRecoveryDiagnostic(original: unknown): Record<string, unknown> {
  const row = original as Record<string, any> | null;
  if (!row || row.label !== 'recovery-final' || !['fuse', 'nfs'].includes(row.backend)) throw new Error('invalid recovery diagnostic');
  const category = (error: unknown): string => {
    if (error === null || error === undefined) return 'none';
    if (typeof error !== 'string') return 'unclassified';
    for (const [pattern, code] of [
      ['owned unmount after-sigkill failed', 'first-unmount-failed'],
      ['owned unmount second', 'second-unmount-failed'],
      ['the copy-up GET must', 'copy-up-not-observed'],
      ['a real seed-lease-v1-', 'partial-seed-not-observed'],
      ['the EXACT observed orphan', 'orphan-not-collected'],
      ['OLD remote', 'remote-baseline-changed'],
      ['OLD complete remote', 'remote-baseline-changed'],
      ['owned writer did not settle', 'writer-not-closed'],
      ['actual closed conditional 412', 'conditional-conflict-not-observed'],
      ['scene retained', 'scene-retained'],
    ]) if (error.includes(pattern)) return code;
    return 'unclassified';
  };
  const stageNames = ['copyUpObserved', 'seedObserved', 'killedClosed', 'unmountSucceeded', 'writerClosed', 'remountObserved', 'orphanRemoved', 'conditionalConflictObserved'];
  const stages = Object.fromEntries(stageNames.map(name => { const stage = row.recoveryStages?.[name]; return [name, {
    executed: typeof stage?.executed === 'boolean' ? stage.executed : null,
    success: stage?.executed === true && typeof stage.success === 'boolean' ? stage.success : null,
  }]; }));
  return { diagnosticOnly: true, stages, backend: row.backend, primaryFailure: category(row.primaryError), cleanupFailure: category(row.cleanupError),
    kernelState: diagnosticKernelState(row.kernelState), finalKernel: projectKernelObservation(row.finalKernel), sceneRetained: row.sceneRetained === true,
    writerOutcome: ['not-started', 'write-completed'].includes(row.writerOutcome) ? row.writerOutcome : 'write-failed-or-unknown',
    unmounts: (Array.isArray(row.unmountResults) ? row.unmountResults : []).filter((v: any) => ['first', 'second'].includes(v?.instance)
      && ['after-sigkill', 'second-cleanup', 'first-cleanup', 'second-final-cleanup'].includes(v?.phase)).map((v: any) => ({
        instance: v.instance, phase: v.phase, result: projectCommandResult(v.result ?? v.retainedProof?.result),
        preKernel: projectKernelObservation(v.preKernel), postKernel: projectKernelObservation(v.postKernel ?? { state: v.retainedProof?.postKernel }),
      })) };
}
/** Exact ordinary-consumer scene only; free paths, arguments, output and error text never leave the runner. */
export function projectConsumerDiagnostic(original: unknown): Record<string, unknown> {
  const row = original as Record<string, any> | null;
  if (!row || row.label !== 'consumers' || !['fuse', 'nfs'].includes(row.backend) || !Array.isArray(row.commands) || row.commands.length > 128) throw new Error('invalid consumer diagnostic');
  const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const digest = (value: unknown) => value === undefined || value === null ? null : hashBytes(typeof value === 'string' ? value : JSON.stringify(value));
  const error = (value: unknown) => ({ present: value != null, sha256: digest(value) });
  const worker = (value: any) => value == null ? null : ({
    launchState: diagnosticEnum(value.launchState, ['not-observed', 'returned', 'threw']), workerExit: Number.isInteger(value.workerExit) ? value.workerExit : null,
    actualWait: value.actualWait === true, childCloseObserved: value.childCloseObserved === true, observedChildExit: Number.isInteger(value.observedChildExit) ? value.observedChildExit : null,
    observedChildSignal: value.observedChildSignal === null ? null : diagnosticEnum(value.observedChildSignal, ['SIGTERM', 'SIGKILL', 'SIGINT']),
    pipeEOF: [value.pipeEOF?.[0] === true, value.pipeEOF?.[1] === true], timeoutObserved: value.timeoutObserved === true,
    elapsedMs: finite(value.elapsedMs), timeoutMs: finite(value.timeoutMs), waitBudgetMs: finite(value.waitBudgetMs), outputComplete: value.outputComplete === true,
    launchError: value.launchError == null ? null : { code: diagnosticEnum(value.launchError.code, ['ETIMEDOUT', 'ENOENT', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE', 'EIO']),
      errno: Number.isInteger(value.launchError.errno) ? value.launchError.errno : null, syscall: value.launchError.syscall === 'spawn' ? 'spawn' : 'unknown', messageSHA256: digest(value.launchError.message) },
    errors: (Array.isArray(value.errors) ? value.errors : []).slice(0, 8).map((v: any) => ({ source: diagnosticEnum(v.source, ['observer', 'control', 'worker', 'worker-start']), messageSHA256: digest(v.message) })),
    errorsTruncated: Array.isArray(value.errors) && value.errors.length > 8, descendantClosureVerified: false,
  });
  const timing = row.commandTiming;
  const windows = Array.isArray(timing?.windows) ? timing.windows : [];
  return { diagnosticOnly: true, accepted: false, backend: row.backend, sceneRetained: row.sceneRetained === true,
    primaryError: error(row.primaryError), cleanupError: error(row.cleanupError), kernel: projectKernelObservation(row.kernel),
    daemon: { state: diagnosticEnum(row.closeState, ['closed', 'pending', 'spawn-error']), actualExit: Number.isInteger(row.closeCode) ? row.closeCode : null,
      signal: row.closeSignal === null ? null : diagnosticEnum(row.closeSignal, ['SIGTERM', 'SIGKILL', 'SIGINT']) },
    unmount: { daemonClosed: row.proof?.daemonClosed === true, postKernel: diagnosticKernelState(row.proof?.postKernel), result: projectCommandResult(row.proof?.result) },
    commands: row.commands.map((command: any) => ({ role: command.command === 'git' ? 'git' : command.command === '/bin/sh' ? 'shell' : command.phase === 'unmount' ? 'unmount' : 'consumer-command',
      commandSHA256: digest(command.command), argvSHA256: digest(command.args), cwdSHA256: digest(command.cwd), state: diagnosticEnum(command.state, ['attempted', 'closed', 'pending', 'spawn-error', 'spawn-threw']),
      result: projectCommandResult(command.result), worker: worker(command.result?.workerFacts ?? command.workerFacts),
      error: command.error == null ? null : { code: diagnosticEnum(command.error.code, ['ETIMEDOUT', 'ENOENT', 'EACCES', 'EIO']), messageSHA256: /^[a-f0-9]{64}$/.test(command.error.messageSHA256) ? command.error.messageSHA256 : null },
      preKernel: command.phase === 'unmount' ? projectKernelObservation(command.preKernel) : null, postKernel: command.phase === 'unmount' ? projectKernelObservation(command.postKernel) : null,
    })),
    timing: { observation: 'event-loop-observation-only', windowsDropped: finite(timing?.windowsDropped), truncated: windows.length > 8,
      windows: windows.slice(-8).map((window: any) => ({ id: finite(window.id), startedAtMs: finite(window.startedAtMs), ended: window.ended === true, operation: diagnosticEnum(window.operation, ['metadata-objects', 'metadata-refs', 'metadata-index']),
        counters: Object.fromEntries(['httpStart', 'httpFinish', 'httpClose', 'stdoutBytes', 'stderrBytes'].map(key => [key, finite(window.counters?.[key])])),
        events: (Array.isArray(window.events) ? window.events : []).slice(0, 16).map((event: any) => ({ kind: diagnosticEnum(event.kind, ['mark', 'http', 'helper']), elapsedMs: finite(event.elapsedMs),
          mark: event.kind === 'mark' ? diagnosticEnum(event.mark, ['spawn-returned', 'spawn-threw', 'closed', 'spawn-error', 'pending']) : null,
          phase: event.kind === 'http' ? diagnosticEnum(event.phase, ['start', 'finish', 'close']) : null, requestId: event.kind === 'http' ? finite(event.requestId) : null,
          channel: event.kind === 'helper' ? diagnosticEnum(event.channel, ['stdout', 'stderr']) : null, bytes: event.kind === 'helper' ? finite(event.bytes) : null,
        })), truncated: window.truncated === true || Array.isArray(window.events) && window.events.length > 16,
      })) },
  };
}
function readConsumerDiagnostic(filename: string): Buffer {
  for (let ancestor = path.dirname(path.resolve(filename)); ; ancestor = path.dirname(ancestor)) {
    const stat = lstatSync(ancestor); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('linked consumer diagnostic ancestor');
    if (ancestor === path.dirname(ancestor)) break;
  }
  const before = lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 256 * 1024) throw new Error('invalid consumer diagnostic file');
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); let primary: unknown;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size || stat.nlink !== 1) throw new Error('consumer diagnostic identity changed');
    const data = Buffer.alloc(stat.size); let offset = 0;
    while (offset < data.length) { const count = readSync(fd, data, offset, data.length - offset, offset); if (!count) throw new Error('consumer diagnostic shortened'); offset += count; }
    const after = fstatSync(fd); const named = lstatSync(filename);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || named.isSymbolicLink() || named.ino !== stat.ino || named.dev !== stat.dev) throw new Error('consumer diagnostic changed during read');
    return data;
  } catch (error) { primary = error; throw error; }
  finally { try { closeSync(fd); } catch (error) { throw primary ? new AggregateError([primary, error], 'Consumer diagnostic read and close failed') : error; } }
}
export function exportSafe(evidence: string, destination: string): void {
  mkdirSync(destination, { mode: 0o700 }); const files = [];
  for (const name of readdirSync(evidence)) {
    const recovery = /^daemon-recovery-final-[0-9]+-[0-9]+\.json$/.test(name);
    const consumer = /^daemon-consumers-[0-9]+-[0-9]+\.json$/.test(name);
    if (!recovery && !consumer && !Object.prototype.hasOwnProperty.call(receipts, name)) continue;
    if (consumer) {
      const data = readConsumerDiagnostic(path.join(evidence, name));
      const bytes = JSON.stringify({ ...projectConsumerDiagnostic(JSON.parse(data.toString('utf8'))), sourceReceiptSHA256: hashBytes(data) }, null, 2) + '\n';
      if (Buffer.byteLength(bytes) > 128 * 1024) throw new Error('consumer diagnostic projection budget exceeded');
      const safeName = 'consumer-scene.safe.json';
      writeFileSync(path.join(destination, safeName), bytes, { flag: 'wx', mode: 0o600 }); files.push({ name: safeName, sha256: hashBytes(bytes) });
      continue;
    }
    const filename = path.join(evidence, name); const sha256 = hashFile(filename); verifyBoundFile({ path: filename, sha256 });
    const original = JSON.parse(readFileSync(filename, 'utf8'));
    const projection = recovery ? projectRecoveryDiagnostic(original) : projectReceipt(name, original) as Record<string, unknown>;
    const bytes = JSON.stringify({ ...projection, sourceReceiptSHA256: sha256 }, null, 2) + '\n';
    const safeName = recovery ? 'recovery-diagnostic.safe.json' : name === 'linux-container-binding.json' ? 'linux-container-binding.safe.json' : /^rss-/.test(name) ? name.replace('.json', '.safe.json') : name;
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
    const expectedExit = stage === 'node-startup-cancel' ? 143 : stage.endsWith('-cli-tampered-list') ? 1 : 0;
    if (!validInstalledObservation(row.observation, stage) || row.observation && (row.observation.timeoutObserved || !row.observation.closeObserved || !row.observation.groupClosed)
      || row.stage !== stage || row.actualExit !== expectedExit || row.actualSignal !== null
      || row.actualWait !== true || row.rawClosed !== true || row.groupAbsent !== true || !Number.isSafeInteger(row.pid) || row.pid <= 1) throw new Error('installed consumer stage incomplete');
    for (const stream of ['stdout', 'stderr']) verifyBoundFile({ path: path.join(directory, `${stage}.${stream}`), sha256: row[`${stream}SHA256`] });
    const stderr = path.join(directory, `${stage}.stderr`);
    const diagnostic = stage.endsWith('-cli-install') ? summarizeInstalledStream(stderr, true) : undefined;
    if (diagnostic) verifyBoundFile({ path: stderr, sha256: row.stderrSHA256 });
    return projectBySchema({ ...row, ...(diagnostic ? { installPhases: diagnostic.installPhases, installPhasesTruncated: diagnostic.installPhasesTruncated } : {}) }, installedStage);
  });
  const proxy = path.join(directory, 'proxy-cancel.safe.json'); verifyBoundFile({ path: proxy, sha256: hashFile(proxy) }); const proxyCancel = JSON.parse(readFileSync(proxy, 'utf8'));
  if (!Number.isSafeInteger(proxyCancel.pid) || proxyCancel.pid <= 1 || proxyCancel.groupAbsent !== true || proxyCancel.tokenFixtureObserved !== true || proxyCancel.nativeMountStarted !== false) throw new Error('installed consumer proxy cleanup incomplete');
  return { stages, proxyCancel: projectBySchema(proxyCancel, installedProxy) };
}
export const INSTALLED_FAILURE_CATEGORIES = ['producer-unclosed', 'producer-group-not-absent', 'observed-stage-nonexpected-exit',
  'consumer-timeout-observed', 'test-failed-cause-unknown', 'invalid-stage-receipt', 'stage-group-not-absent'] as const;
const installedSignal = (signal: unknown): string | null => signal === null ? null
  : typeof signal === 'string' && ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGPIPE', 'SIGHUP', 'SIGBUS'].includes(signal) ? signal : 'unknown';
/** Observations only. Missing stages remain unknown; unclosed raw streams are
 * never hashed or used to infer the cause. This cannot satisfy acceptance. */
export function recordInstalledConsumerFailure(evidence: string, run: string, producer: {
  producerClosed: boolean; groupAbsent: boolean; rawClosedBeforeHash: boolean; code: number | null; signal: string | null;
}, raw: Buffer): void {
  const closed = producer.producerClosed && producer.groupAbsent && producer.rawClosedBeforeHash;
  const observedStages: Array<Record<string, any>> = [];
  let receiptInventoryState = 'unknown'; let lastObservedStage: string | null = null;
  let category: typeof INSTALLED_FAILURE_CATEGORIES[number] = !producer.producerClosed ? 'producer-unclosed'
    : !producer.groupAbsent ? 'producer-group-not-absent' : 'test-failed-cause-unknown';
  try {
    const parent = path.join(run, '.test-data/afs-installed-receipts');
    const directories = readdirSync(parent);
    if (directories.length !== 1) receiptInventoryState = 'ambiguous';
    else {
      const directory = path.join(parent, directories[0]); const names = readdirSync(directory).filter(name => name.endsWith('.safe.json'));
      if (names.some(name => name !== 'proxy-cancel.safe.json' && !INSTALLED_CONSUMER_STAGES.some(stage => name === stage + '.safe.json'))) throw new Error('invalid inventory');
      receiptInventoryState = 'observed';
      for (const stage of INSTALLED_CONSUMER_STAGES) {
        if (!names.includes(stage + '.safe.json')) continue;
        const file = path.join(directory, stage + '.safe.json'); verifyBoundFile({ path: file, sha256: hashFile(file) });
        const row = JSON.parse(readFileSync(file, 'utf8'));
        if (row.stage !== stage || !Number.isSafeInteger(row.pid) || row.pid <= 1 || row.actualExit !== null && !Number.isSafeInteger(row.actualExit)
          || !validInstalledObservation(row.observation, stage) || typeof row.actualWait !== 'boolean' || typeof row.rawClosed !== 'boolean' || typeof row.groupAbsent !== 'boolean') throw new Error('invalid stage');
        const bound = closed && row.actualWait === true && row.rawClosed === true && row.groupAbsent === true
          && (!row.observation || row.observation.closeObserved && row.observation.groupClosed);
        if (bound) for (const stream of ['stdout', 'stderr']) verifyBoundFile({ path: path.join(directory, `${stage}.${stream}`), sha256: row[`${stream}SHA256`] });
        const summary = bound ? Object.fromEntries(['stdout', 'stderr'].map(stream => {
          const file = path.join(directory, `${stage}.${stream}`); const value = summarizeInstalledStream(file, stream === 'stderr' && stage.endsWith('-cli-install'));
          verifyBoundFile({ path: file, sha256: row[`${stream}SHA256`] }); return [stream, value];
        })) : null;
        observedStages.push({ stage, pid: row.pid, observation: row.observation, summary, actualExit: row.actualExit, actualSignal: installedSignal(row.actualSignal),
          actualWait: row.actualWait, rawClosed: row.rawClosed, groupAbsent: row.groupAbsent, rawHashesBound: bound,
          stdoutSHA256: bound ? row.stdoutSHA256 : null, stderrSHA256: bound ? row.stderrSHA256 : null });
      }
      if (closed) {
        const text = raw.toString('utf8').replace(/\u001b\[[0-9;]*m/g, '');
        for (const line of text.split('\n')) {
          try {
            const row = JSON.parse(line);
            if (observedStages.some(stage => stage.stage === row.stage && stage.pid === row.pid && stage.rawHashesBound
              && stage.actualExit === row.actualExit && stage.stdoutSHA256 === row.stdoutSHA256 && stage.stderrSHA256 === row.stderrSHA256)) lastObservedStage = row.stage;
          } catch { /* Non-receipt output never enters the public diagnostic. */ }
        }
        if (observedStages.some(stage => stage.groupAbsent === false)) category = 'stage-group-not-absent';
        else if (observedStages.some(stage => stage.actualSignal !== null || stage.actualExit !== (stage.stage === 'node-startup-cancel' ? 143 : stage.stage.endsWith('-cli-tampered-list') ? 1 : 0))) category = 'observed-stage-nonexpected-exit';
        if (category !== 'stage-group-not-absent' && /^(?:error: |Received: )?(?:Error: )?Owned consumer timeout\s*$/m.test(text)) category = 'consumer-timeout-observed';
      }
    }
  } catch (error) {
    receiptInventoryState = (error as NodeJS.ErrnoException).code === 'ENOENT' && observedStages.length === 0 ? 'missing' : 'invalid';
    if (receiptInventoryState === 'invalid' && closed) category = 'invalid-stage-receipt';
  }
  const diagnostic = { diagnosticOnly: true, accepted: false, category, receiptInventoryState,
    producerClosed: producer.producerClosed, groupAbsent: producer.groupAbsent, rawClosedBeforeHash: producer.rawClosedBeforeHash,
    producerExit: producer.code, producerSignal: installedSignal(producer.signal), parentRawSHA256: closed ? hashBytes(raw) : null,
    lastObservedStage, observedStages };
  writeFileSync(path.join(evidence, 'installed-consumer-failure.safe.json'), JSON.stringify(projectReceipt('installed-consumer-failure.safe.json', diagnostic), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
export function assertInstalledConsumerProducer(row: { state: string; code: number | null; signal: string | null; groupAbsent: boolean;
  nodeVersion: string | null; bunVersion: string | undefined; passed: number; failed: number; skipped: number; sourceUnchanged: boolean }): void {
  if (row.state !== 'closed' || row.code !== 0 || row.signal !== null || !row.groupAbsent || row.nodeVersion !== 'v22.21.1'
    || row.bunVersion !== '1.4.2' || row.passed !== 1 || row.failed !== 0 || row.skipped !== 0 || !row.sourceUnchanged) throw new Error('installed consumer producer incomplete');
}
export function persistInstalledConsumerReceipt(evidence: string, run: string, parent: Record<string, unknown> & {
  accepted: boolean; producerClosed: boolean; code: number | null; signal: string | null; groupAbsent: boolean; rawClosedBeforeHash: boolean;
}, raw: Buffer): void {
  writeFileSync(path.join(evidence, 'installed-consumer.safe.json'), JSON.stringify(projectReceipt('installed-consumer.safe.json', parent), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (!parent.accepted) {
    try { recordInstalledConsumerFailure(evidence, run, parent, raw); }
    catch { /* Preserve the original pending rejection and authoritative parent receipt when diagnostic I/O fails. */ }
  }
}
export async function runInstalledConsumer(archive: string, archiveSHA: string, sourceSHA: string, workspace: string, evidence: string): Promise<void> {
  verifyBoundFile({ path: archive, sha256: archiveSHA }); if (!/^[a-f0-9]{40}$/.test(sourceSHA)) throw new Error('invalid consumer source authority');
  const c = JSON.parse(execFileSync('python3', ['-c', collectArchive, archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })) as Collected;
  const properties = validateCollectedModule(c, `${process.platform}-${process.arch}`, sourceSHA, c.hashes['provenance/native-build.receipt.json']?.sha256, c.hashes['provenance/native-source-kit.json']?.sha256);
  mkdirSync(evidence, { mode: 0o700 }); const run = path.join(evidence, 'private-run'); mkdirSync(run, { mode: 0o700 }); const home = path.join(run, 'home'); mkdirSync(home, { mode: 0o700 });
  const sourceTest = path.join(workspace, 'packages/xpod-afs/tests/installed-module.test.ts'); const env = { ...isolatedModuleEnvironment(home), PATH: process.env.PATH, XPOD_AFS_TEST_ARCHIVE: archive };
  const sourceTestSHA256 = hashFile(sourceTest);
  const sourceHelper = path.join(workspace, 'scripts/agentfs-native-ci/mounted/owned-installed-consumer.ts');
  const sourceHelperSHA256 = hashFile(sourceHelper);
  const nodeVersion = (() => { try { return execFileSync('node', ['--version'], { encoding: 'utf8', env }).trim(); } catch { return null; } })();
  const child = spawn(process.execPath, ['test', sourceTest], { cwd: run, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const lifecycle = observeChildLifecycle(child); const raw: Buffer[] = []; child.stdout.on('data', (b: Buffer) => raw.push(b)); child.stderr.on('data', (b: Buffer) => raw.push(b));
  let fact = await lifecycle.wait(180_000); const groupAbsent = await reapOwnedGroup(child.pid, 15_000); if (fact.state !== 'closed') fact = await lifecycle.waitClose(15_000);
  const bytes = Buffer.concat(raw); writeFileSync(path.join(evidence, 'installed-consumer.raw.log'), bytes, { flag: 'wx', mode: 0o600 });
  const text = bytes.toString('utf8').replace(/\u001b\[[0-9;]*m/g, ''); const count = (name: string) => Number(new RegExp(`(?:^|\\n)\\s*(\\d+) ${name}\\b`).exec(text)?.[1] ?? 0);
  let stages: unknown[] = []; let proxyCancel: unknown = null; let accepted = false;
  try {
    assertInstalledConsumerProducer({ state: fact.state, code: fact.code, signal: fact.signal, groupAbsent, nodeVersion, bunVersion: process.versions.bun,
      passed: count('pass'), failed: count('fail'), skipped: count('skip'), sourceUnchanged: hashFile(sourceTest) === sourceTestSHA256 && hashFile(sourceHelper) === sourceHelperSHA256 });
    const parent = path.join(run, '.test-data/afs-installed-receipts'); const directories = readdirSync(parent); if (directories.length !== 1) throw new Error('fresh consumer receipt directory required');
    ({ stages, proxyCancel } = verifyInstalledConsumerReceipts(path.join(parent, directories[0]))); verifyBoundFile({ path: archive, sha256: archiveSHA }); accepted = true;
  } finally {
    persistInstalledConsumerReceipt(evidence, run, { status: accepted ? 'passed' : 'failed', accepted, archiveSHA256: archiveSHA, moduleSourceSHA: sourceSHA, manifestSHA256: properties.manifestSHA256,
      sourceTestSHA256, sourceHelperSHA256, lifecycle: lifecycle.facts(), producerClosed: fact.state === 'closed', code: fact.code, signal: fact.signal, groupAbsent,
      rawClosedBeforeHash: fact.state === 'closed' && groupAbsent, rawSHA256: fact.state === 'closed' && groupAbsent ? hashBytes(bytes) : null,
      nodeVersion, bunVersion: process.versions.bun, passed: count('pass'), failed: count('fail'), skipped: count('skip'), stages, proxyCancel }, bytes);
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
  if (native['source-kit.json'] !== artifacts[target as keyof typeof artifacts].sourceKit) throw new Error('native source-kit authority mismatch');
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
  const cliArchive = bound('--cli-archive', 'cli.tgz');
  const clientArchive = bound('--client-archive', 'client.tgz');
  // Reuse the serialized product validators; import after initialization of this module.
  const { validateCliProduct, validateClientProduct } = await import('./export-products');
  const cliProduct = await validateCliProduct(path.join(out, 'cli.tgz'), path.join(out, 'cli-validation'), sourceSHA, core.sha256,
    JSON.parse(readFileSync(path.join(workspace, 'packages/xpod-cli/package.json'), 'utf8')), workspace);
  const clientProduct = validateClientProduct(path.join(out, 'client.tgz'), path.join(out, 'client-validation'),
    path.join(workspace, 'packages/xpod-client'), sourceSHA);
  const cliManifest = JSON.parse(execFileSync('tar', ['-xOf', path.join(out, 'cli.tgz'), 'package/package.json'], { encoding: 'utf8' }));
  if (Object.keys(cliManifest.dependencies ?? {}).length !== 1
    || cliManifest.dependencies['@undefineds.co/xpod-client'] !== clientProduct.version) {
    throw new Error('CLI tar must declare the exact public runtime client dependency');
  }
  const runtime = (name: 'node' | 'bun') => { const filename = path.resolve(option(`--${name}`)); const sha256 = hashFile(filename); verifyBoundFile({ path: filename, sha256 }); const version = execFileSync(filename, ['--version'], { encoding: 'utf8' }).trim(); if (version !== (name === 'node' ? 'v22.21.1' : '1.4.2')) throw new Error('runtime pin mismatch'); return { path: path.resolve(option(`--consumer-${name}`)), sha256 }; };
  const input: ModuleAdmissionInputs = { schemaVersion: 1, target: target as ModuleAdmissionInputs['target'], workspace: path.resolve(option('--consumer-workspace')), evidence: path.resolve(option('--evidence')), home: path.resolve(option('--home')),
    moduleSourceSHA: sourceSHA, nativeBuildSourceSHA: source, driver: { ...driver, sourceSHA }, core: { ...core, sourceSHA },
    cli: { archive: cliArchive, clientArchive, version: cliProduct.version, clientVersion: clientProduct.version,
      files: cliProduct.files, clientFiles: clientProduct.files },
    module: { ...module, ...properties, integrity: `sha512-${createHash('sha512').update(readFileSync(path.join(out, 'module.tgz'))).digest('base64')}` },
    native: { archive, pins, receiptSHA256: native['native-receipt.json'], sourceKitSHA256: native['source-kit.json'] }, runtimes: { node: runtime('node'), bun: runtime('bun') } };
  if (git('rev-parse', 'HEAD') !== sourceSHA || git('status', '--porcelain', '--untracked-files=all')) throw new Error('source changed during preparation');
  const bytes = JSON.stringify(input, null, 2) + '\n'; writeFileSync(path.join(out, 'inputs.json'), bytes, { flag: 'wx', mode: 0o600 });
  writeFileSync(path.join(out, 'preparation.safe.json'), JSON.stringify({ schemaVersion: 1, sourceSHA, sourceClean: true, buildReceiptSHA256: hashFile(buildPath), build, native: facts, inputSHA256: hashBytes(bytes), input, archiveMembersValidated: true }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(hashBytes(bytes) + '\n');
}
if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) { main().catch(() => { process.stderr.write('module preparation rejected\n'); process.exitCode = 1; }); }
