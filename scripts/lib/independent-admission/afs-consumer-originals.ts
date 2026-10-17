import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import type { CollectedArtifactIdentity, CollectedArtifactMember } from './artifact-contract';
import limits from '../module-artifact-limits.json';
import { afsConsumerBudget } from '../afs-consumer-budget';
import { registryLegalLockEntries } from './legal-registry-originals';
import { derivedSourceView, assertDerivedSourceCurrent } from './source-context';
import { REQUIRED_MOUNTED_CASES, MODULE_CHAIN_CASE } from '../../agentfs-native-ci/mounted/required-cases';

export interface AfsConsumerOriginalInput {
  readonly source?: unknown;
  readonly stage: 'prepublish' | 'postpublish'; readonly sourceSha: string; readonly target: string;
  readonly product: Readonly<CollectedArtifactIdentity>;
  readonly productMembers: readonly CollectedArtifactMember[];
  readonly tools: readonly Readonly<CollectedArtifactIdentity>[];
  readonly originals: readonly CollectedArtifactMember[];
  readOriginal(path: string, maximumBytes: number): Buffer;
  readOriginalRange(path: string, offset: number, length: number): Buffer;
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const safe = (name: unknown): name is string => typeof name === 'string' && Boolean(name) && !name.startsWith('/') &&
  !/[\\\u0000-\u001f\u007f]/u.test(name) && !name.split('/').some(part => !part || part === '.' || part === '..');
const SHA = /^[a-f0-9]{64}$/u;
const harnessLabels = new Set(afsConsumerBudget().harnessCommands.map(row => row.label));
const requiredCases = Object.freeze([...REQUIRED_MOUNTED_CASES, MODULE_CHAIN_CASE]);
function need(value: unknown, code: string): asserts value { if (!value) throw Error(code); }
function safeChainRaw(bytes: Buffer, index: number, stream: string, mountpoint: string): boolean {
  const value = bytes.toString();
  if (stream === 'stderr') return !value || index === 4 && /^(?:agentfs-pod: umount pid=[1-9][0-9]* actual_exit=0 actual_signal=null\n)+$/u.test(value);
  if (index === 0) return value === 'mounted at ' + mountpoint + '\n';
  if (index === 1) return value === 'AUTHENTICATED_MODULE_READ\n';
  if (index === 3) return /^commit applied=1 conflicts=0 errors=0\n$/u.test(value);
  return value === '';
}
export interface AfsConsumerOriginalSelectionInput {
  readonly target: string; readonly originals: readonly CollectedArtifactMember[];
  readOriginal(path: string, maximumBytes: number): Buffer;
}
/** The single transport allowlist. Directory membership never selects siblings.
 * Returned refs carry no custody/approval and must be rechecked by the copier. */
export function afsConsumerOriginalSelection(input: AfsConsumerOriginalSelectionInput): Readonly<{
  files: readonly Readonly<CollectedArtifactMember & { role: string }>[]; pending: readonly string[];
}> {
  const members = new Map(input.originals.map(row => [row.path, row])), selected = new Map<string, CollectedArtifactMember & { role: string }>(), pending = new Set<string>();
  const add = (name: string, role: string) => {
    const row = members.get(name);
    if (!safe(name) || !row || !SHA.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0) { pending.add('afs-transport-original-missing:' + name); return; }
    selected.set(name, Object.freeze({ ...row, role }));
  };
  const json = (name: string): any => {
    const row = members.get(name); need(row && row.bytes <= limits.metadataBytes, 'afs-transport-small-original-required:' + name);
    const bytes = input.readOriginal(name, limits.metadataBytes); need(bytes.length === row.bytes && hash(bytes) === row.sha256, 'afs-transport-original-bytes-differ:' + name);
    return JSON.parse(bytes.toString());
  };
  const guarded = (work: () => void) => { try { work(); } catch (error) { pending.add(String((error as Error).message)); } };
  add('result.json', 'consumer-result');
  let transport: string | undefined;
  guarded(() => { transport = json('result.json').transport; need(['collected-product-archives', 'production-npm-registry'].includes(transport!), 'afs-transport-kind-invalid'); });
  for (const runtime of ['node', 'bun']) {
    for (const suffix of ['installed-package.json', 'pointer.json', 'registry-tools.json', 'registry-package.json', 'registry-bun.lock', 'binding.json', 'probe.mjs', 'deny.sb']) add(runtime + '-' + suffix, 'fixed-runtime-original');
    if (transport === 'collected-product-archives') for (const suffix of ['transport.mjs', 'transport.jsonl']) add(runtime + '-' + suffix, 'fixed-archive-transport-original');
    const prefix = runtime + '-mounted/', os = input.target.split('-')[0];
    for (const name of ['mounted-' + os + '.receipt.json', 'mounted-' + os + '.raw.log', 'mounted-' + os + '.vitest-report.json', 'module-chain.safe.json', 'module-chain-cleanup.safe.json']) add(prefix + name, 'mounted-profile-original');
    guarded(() => {
      const chain = json(prefix + 'module-chain.safe.json');
      need(Array.isArray(chain.children) && chain.children.length <= 5, 'afs-transport-chain-child-bound');
      if (!chain.children.length) return;
      const args = chain.children[0].args, at = Array.isArray(args) ? args.indexOf('--mountpoint') : -1;
      const mountpoint = args?.[at + 1], scene = typeof mountpoint === 'string' ? path.posix.basename(path.posix.dirname(mountpoint)) : '';
      need(at >= 0 && /^module-chain-[A-Za-z0-9_-]+$/u.test(scene), 'afs-transport-chain-scene-invalid');
      for (let index = 0; index < chain.children.length; index++) for (const stream of ['stdout', 'stderr']) {
        const name = prefix + scene + '/child-' + (index + 1) + '.' + stream + '.raw.log', actual = members.get(name);
        need(actual?.sha256 === chain.children[index][stream + 'SHA256'], 'afs-transport-chain-raw-binding-differs:' + name);
        const bytes = input.readOriginal(name, 16 * 1024 ** 2);
        need(actual && bytes.length === actual.bytes && hash(bytes) === actual.sha256 && safeChainRaw(bytes, index, stream, mountpoint), 'afs-transport-chain-raw-safe-schema-differs:' + name);
        add(name, 'chain-child-' + stream);
      }
    });
  }
  for (const name of ['summary.json', 'node/handoff.json', 'node/launcher', 'bun/handoff.json', 'bun/launcher']) add('safe-evidence/afs-checked-originals/' + name, 'checked-handoff-launcher-original');
  guarded(() => {
    const result = json('result.json');
    need(Array.isArray(result.records) && result.records.length <= 64, 'afs-transport-command-record-bound');
    for (const record of result.records) {
      need(harnessLabels.has(record.label) || /^(?:(?:node|bun)-(?:runtime-version|runtime-target|probe|normal-cli-install|install-afs|list-afs|afs-help|afs-native-version|afs-full-mounted-profile|remove-afs)|verifier-(?:node|bun|python|git|rg|mount|fusermount)-version)$/u.test(record.label), 'afs-transport-command-label-invalid');
      for (const stream of ['stdout', 'stderr']) {
        const name = record.label + '.' + stream + '.raw.log';
        need(Array.isArray(record.raw) && record.raw.filter((row: any) => row.path === name && row.sha256 === members.get(name)?.sha256 && row.bytes === members.get(name)?.bytes).length === 1, 'afs-transport-command-raw-ref-differs:' + name);
        add(name, 'command-' + stream);
      }
    }
    const ref = result.verifierToolOriginals;
    need(/^verifier-tools\/manifest-[0-9]{4}\.json$/u.test(ref?.path) && members.get(ref.path)?.sha256 === ref.sha256 && members.get(ref.path)?.bytes === ref.bytes, 'afs-transport-tool-master-ref-invalid');
    add(ref.path, 'verifier-tool-master');
    const master = json(ref.path);
    need(Array.isArray(master.roots) && master.roots.length <= 16 && Array.isArray(master.observations), 'afs-transport-tool-master-shape');
    const toolRef = (ref: any, pattern: RegExp, role: string) => {
      need(pattern.test(ref?.path) && members.get(ref.path)?.sha256 === ref.sha256 && members.get(ref.path)?.bytes === ref.bytes, 'afs-transport-tool-ref-invalid'); add(ref.path, role);
    };
    for (const root of master.roots) {
      need(/^[a-z0-9-]+$/u.test(root.rootId) && ['source', 'dependencies', 'toolchain'].includes(root.domain), 'afs-transport-tool-root-invalid');
      const prefix = 'verifier-tools/' + root.rootId + '/' + root.domain;
      for (const ref of root.inventories ?? []) {
        toolRef(ref, new RegExp('^' + prefix + '-inventory-[0-9]{4}\\.json$', 'u'), 'verifier-tool-inventory');
        const rows = json(ref.path);
        need(Array.isArray(rows) && rows.every(row => safe(row.path) && !row.path.toLowerCase().split('/').some((part: string) => ['.env', '.env.local', '.env.cloud', '.env.server', 'credentials.json', '.npmrc', '.netrc', '.ssh', '.git', '.test-data'].includes(part))), 'afs-transport-sensitive-tool-input');
      }
      for (const ref of root.archives ?? []) toolRef(ref, new RegExp('^' + prefix + '-[0-9]{4}\\.tar$', 'u'), 'verifier-tool-archive');
    }
    for (const value of master.installOriginals ?? []) {
      const name = value?.path;
      need(typeof name === 'string' && (/^verifier-tools\/install\/(?:prepared|complete|verifier-harness-(?:checkout|install|build-tools|client|patch-check|remove))\.json$/u.test(name) ||
        /^verifier-tools\/install\/inputs\/(?:package\.json|bun\.lock|bunfig\.toml|patches\/(?:[A-Za-z0-9@_.+/-]|%2[Ff])+\.patch|scripts\/(?:check-dependency-state\.ts|patch-(?:jose|inrupt-authn-refresh|inrupt-authn-transport|inrupt-authn-operation-cleanup)\.js)|packages\/xpod-(?:cli\/scripts\/build-tools-package|client\/scripts\/build)\.ts)$/u.test(name)), 'afs-transport-install-original-role-invalid');
      need(safe(name), 'afs-transport-install-original-path-invalid'); toolRef(value, /^verifier-tools\/install\//u, 'verifier-install-original');
    }
    for (const observation of master.observations) for (const root of observation.roots ?? []) for (const ref of root.inventories ?? []) toolRef(ref, /^verifier-tools\/(?:node|bun)-(?:before|after)-mounted-[a-z0-9-]+-[0-9]{4}\.json$/u, 'verifier-tool-observation');
  });
  return Object.freeze({ files: Object.freeze([...selected.values()]), pending: Object.freeze([...pending]) });
}

/** This checks original-byte semantics only. The caller owns origin/custody and
 * trusted-tool admission. No object returned here is an issued capability. */
export function inspectAfsConsumerOriginals(input: AfsConsumerOriginalInput): Readonly<{
  verified: boolean; pending: readonly string[]; facts: Readonly<Record<string, unknown>>;
}> {
  const pending = new Set<string>(), facts: Record<string, unknown> = {};
  const deadline = Date.now() + limits.timeoutMs;
  const originals = new Map(input.originals.map(row => [row.path, row]));
  const check = () => need(Date.now() <= deadline, 'afs-original-verification-deadline');
  const original = (name: string, maximum = limits.metadataBytes): Buffer => {
    check(); const row = originals.get(name);
    need(safe(name) && row && Number.isSafeInteger(row.bytes) && row.bytes >= 0 && row.bytes <= maximum && SHA.test(row.sha256), 'afs-registered-bounded-original:' + name);
    const bytes = input.readOriginal(name, maximum);
    need(bytes.length === row.bytes && hash(bytes) === row.sha256, 'afs-original-bytes-differ:' + name);
    return bytes;
  };
  const json = (name: string) => JSON.parse(original(name).toString());
  const ref = (value: any, prefix?: string) => {
    const row = originals.get(value?.path);
    need(value && safe(value.path) && (!prefix || value.path.startsWith(prefix)) && row && row.bytes === value.bytes && row.sha256 === value.sha256, 'afs-original-reference-differs');
    return row;
  };
  const toolLocations = new Map<string, {archive: string; offset: number; bytes: number}>();
  const inspectTar = (archive: CollectedArtifactMember, rows: readonly any[]) => {
    const expected = new Map(rows.filter(row => row.archive === archive.path).map(row => [row.path, row]));
    const seen = new Set<string>();
    const read = (offset: number, size: number) => {
      check(); need(Number.isSafeInteger(offset) && Number.isSafeInteger(size) && offset >= 0 && size >= 0 && size <= limits.rangeBytes && offset + size <= archive.bytes, 'afs-tool-tar-range-bound');
      const bytes = input.readOriginalRange(archive.path, offset, size); need(bytes.length === size, 'afs-tool-tar-truncated'); return bytes;
    };
    const string = (value: Buffer) => value.subarray(0, value.indexOf(0) < 0 ? value.length : value.indexOf(0)).toString();
    const octal = (value: Buffer) => { const text = string(value).trim(); need(/^[0-7]+$/u.test(text), 'afs-tool-tar-number'); return parseInt(text, 8); };
    let offset = 0, longName: string | undefined, longLink: string | undefined, ended = false;
    while (offset + 512 <= archive.bytes) {
      const header = read(offset, 512); offset += 512;
      if (header.every(value => value === 0)) { ended = true; break; }
      const checksum = [...header].reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0);
      need(checksum === octal(header.subarray(148, 156)), 'afs-tool-tar-checksum');
      const size = octal(header.subarray(124, 136)), type = String.fromCharCode(header[156]!);
      need(Number.isSafeInteger(size) && size >= 0 && offset + Math.ceil(size / 512) * 512 <= archive.bytes, 'afs-tool-tar-item-bound');
      if (type === 'L' || type === 'K') {
        need(size > 0 && size <= 4096, 'afs-tool-tar-long-object-bound');
        const value = string(read(offset, size));
        if (type === 'L') { need(longName === undefined, 'afs-tool-tar-duplicate-long-name'); longName = value; }
        else { need(longLink === undefined, 'afs-tool-tar-duplicate-long-link'); longLink = value; }
      } else {
        const name = longName ?? [string(header.subarray(345, 500)), string(header.subarray(0, 100))].filter(Boolean).join('/');
        const link = longLink ?? string(header.subarray(157, 257)); longName = undefined; longLink = undefined;
        const row = expected.get(name);
        need(safe(name) && !seen.has(name) && row, 'afs-tool-tar-unbound-or-duplicate-item'); seen.add(name);
        if (type === '2') need(size === 0 && row.kind === 'symlink' && row.target === link, 'afs-tool-tar-link-differs');
        else {
          need((type === '0' || type === '\0') && row.kind === 'file' && row.bytes === size && row.mode === (octal(header.subarray(100, 108)) & 0o777), 'afs-tool-tar-file-metadata-differs');
          const digest = createHash('sha256');
          for (let at = 0; at < size; at += limits.rangeBytes) digest.update(read(offset + at, Math.min(limits.rangeBytes, size - at)));
          need(digest.digest('hex') === row.sha256, 'afs-tool-tar-file-bytes-differ');
          toolLocations.set(archive.path + '\0' + name, {archive: archive.path, offset, bytes: size});
        }
      }
      offset += Math.ceil(size / 512) * 512;
    }
    need(ended && longName === undefined && longLink === undefined && seen.size === expected.size, 'afs-tool-tar-incomplete-item-set');
    while (offset < archive.bytes) { const size = Math.min(limits.rangeBytes, archive.bytes - offset); need(read(offset, size).every(value => value === 0), 'afs-tool-tar-trailing-data'); offset += size; }
  };
  const axis = (name: string, work: () => void) => {
    try { work(); facts[name] = true; } catch (error) { facts[name] = false; pending.add(String((error as Error).message)); }
  };
  let result: any;
  axis('consumerDualRawOriginalsVerified', () => {
    need(originals.size === input.originals.length && input.originals.length <= limits.sourceMembers && input.originals.every(row => safe(row.path)), 'afs-original-inventory-invalid');
    need(['prepublish', 'postpublish'].includes(input.stage) && /^[a-f0-9]{40}$/u.test(input.sourceSha) &&
      ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'].includes(input.target) && input.product.sourceSha === input.sourceSha &&
      input.product.target === input.target && input.product.package === '@undefineds.co/xpod-afs-' + input.target, 'afs-product-identity-differs');
    result = json('result.json');
    need(result.schemaVersion === 1 && result.kind === 'afs-public-cli-consumer' && result.sourceSha === input.sourceSha && result.status === 'passed' &&
      result.realConsumerValidated === true && result.forcedCleanup === false && result.signal === null && result.processGroupsUnknown === false &&
      result.ownedTemporaryRootRemoved === true && result.driverSourcesUnchanged === true && result.releaseQualified === false, 'afs-consumer-result-not-closed');
    need(result.transport === (input.stage === 'prepublish' ? 'collected-product-archives' : 'production-npm-registry'), 'afs-consumer-transport-differs');
    const tuples = [['afs', input.product], ...['cli', 'client'].map(id => [id, input.tools.find(row => row.package === '@undefineds.co/xpod-' + id)] as const)];
    for (const [id, identity] of tuples as [string, CollectedArtifactIdentity | undefined][]) {
      const archive = result.inputs?.[id + 'Archive'];
      need(identity && archive?.sha256 === identity.archiveSha256 && archive.bytes === identity.archiveBytes && archive.integrity === identity.integrity, 'afs-consumer-archive-tuple-differs:' + id);
    }
    const ordinary = ['runtime-version', 'runtime-target', 'probe', 'normal-cli-install', 'install-afs', 'list-afs', 'afs-help', 'afs-native-version', 'afs-full-mounted-profile', 'remove-afs'];
    need(Array.isArray(result.records) && result.records.length <= 64, 'afs-consumer-record-set-invalid');
    const labels = new Set<string>();
    for (const record of result.records) {
      need(typeof record.label === 'string' && !labels.has(record.label) && (ordinary.some(suffix => record.label === 'node-' + suffix || record.label === 'bun-' + suffix) || /^verifier-(?:node|bun|python|git|rg|mount|fusermount)-version$/u.test(record.label) || harnessLabels.has(record.label)), 'afs-command-label-invalid');
      labels.add(record.label);
      need(record.status === 'passed' && record.returncode === 0 && record.waitStatus === 'known' && record.rawHandlesClosed === true && record.rawClosed === true && record.rawClosedBeforeHash === true && record.rawEligible === true && record.ownedGroupAbsent === true && Number.isSafeInteger(record.pid) && record.pid > 0 && Array.isArray(record.argv) && record.argv.length > 0, 'afs-command-not-closed:' + record.label);
      need(Array.isArray(record.raw) && record.raw.length === 2, 'afs-command-dual-raw-missing:' + record.label);
      for (const stream of ['stdout', 'stderr']) {
        const name = record.label + '.' + stream + '.raw.log', rows = record.raw.filter((row: any) => row.path === name);
        need(rows.length === 1 && rows[0].sizeIsFinal === true, 'afs-command-stream-reference-missing:' + name);
        ref(rows[0]); original(name, 16 * 1024 ** 2);
      }
    }
    for (const runtime of ['node', 'bun']) for (const suffix of ordinary) need(labels.has(runtime + '-' + suffix), 'afs-required-command-missing:' + runtime + '-' + suffix);
  });
  for (const runtime of ['node', 'bun']) {
    axis(runtime + 'InstalledProductVerified', () => {
      need(result, 'afs-consumer-result-unavailable');
      const bytes = original(runtime + '-installed-package.json'), pkg = JSON.parse(bytes.toString()), pointer = json(runtime + '-pointer.json');
      const manifest = input.productMembers.find(row => row.path === 'package.json');
      need(manifest && hash(bytes) === manifest.sha256 && bytes.length === manifest.bytes && pkg.name === input.product.package && pkg.version === input.product.version && pkg.xpodModule?.id === 'afs' &&
        pointer.package === pkg.name && pointer.version === pkg.version && pointer.integrity === input.product.integrity && pointer.manifestSha256 === manifest.sha256, 'afs-installed-product-manifest-differs:' + runtime);
      need(Array.isArray(pkg.xpodModule.files) && pkg.xpodModule.files.length + 1 === input.productMembers.length, 'afs-installed-full-file-set-differs:' + runtime);
      const names = new Set<string>();
      for (const row of pkg.xpodModule.files) {
        const actual = input.productMembers.find(item => item.path === row.path);
        need(safe(row.path) && !names.has(row.path) && actual && row.sha256 === actual.sha256 && row.size === actual.bytes && row.mode === actual.mode, 'afs-installed-member-differs:' + runtime);
        names.add(row.path);
      }
    });
    axis(runtime + 'FullMountedOriginalsVerified', () => {
      need(result, 'afs-consumer-result-unavailable');
      const prefix = runtime + '-mounted/', os = input.target.split('-')[0]!, receipt = json(prefix + 'mounted-' + os + '.receipt.json');
      need(receipt.schemaVersion === 1 && receipt.os === os && receipt.backend === (os === 'linux' ? 'fuse' : 'nfs') && receipt.producerStarted === true && receipt.producerClosed === true && receipt.actualWait === true &&
        receipt.rawClosedBeforeHash === true && receipt.exit === 0 && receipt.signal === null && receipt.ownedGroupAbsent === true && receipt.status === 'ok' && receipt.mountExecuted === true && receipt.failureReason === null, 'afs-mounted-receipt-not-closed:' + runtime);
      const raw = original(prefix + 'mounted-' + os + '.raw.log', 16 * 1024 ** 2);
      need(hash(raw) === receipt.rawSHA256, 'afs-mounted-raw-binding-differs:' + runtime);
      const reportBytes = original(prefix + 'mounted-' + os + '.vitest-report.json'), report = JSON.parse(reportBytes.toString());
      need(hash(reportBytes) === receipt.vitestReport?.sha256 && isDeepStrictEqual(receipt.vitestReport.requiredCases, requiredCases), 'afs-mounted-report-binding-differs:' + runtime);
      const assertions = (report.testResults ?? []).flatMap((file: any) => file.assertionResults ?? []);
      for (const name of requiredCases) {
        const rows = assertions.filter((row: any) => (row.title ?? row.fullName) === name);
        need(rows.length === 1 && rows[0].status === 'passed', 'afs-required-mounted-case-not-passed:' + runtime + ':' + name);
      }
      need(!report.testResults?.some((file: any) => file.failureMessage || file.message || file.status === 'failed') && !(report.numFailedTests > 0) && !(report.numFailedTestSuites > 0), 'afs-mounted-report-has-failure:' + runtime);
      const chain = json(prefix + 'module-chain.safe.json'), cleanup = json(prefix + 'module-chain-cleanup.safe.json');
      need(chain.status === 'executed' && chain.actualAuthenticatedRead === true && chain.actualConditionalWriteback === true && chain.authExchanges > 0 && chain.daemonAbsenceProven === true && chain.kernelAbsent === true &&
        cleanup.cleanupVerified === true && cleanup.kernelAbsent === true && cleanup.daemonsAbsent === true && cleanup.groupsAbsent === true && cleanup.identitiesKnown === true && cleanup.unmountClosedSuccessfully === true && cleanup.sceneRetained === false, 'afs-mounted-chain-cleanup-unresolved:' + runtime);
      need(Array.isArray(chain.children) && chain.children.length === 5 && isDeepStrictEqual(chain.children, cleanup.children), 'afs-mounted-chain-child-set-differs:' + runtime);
      for (const child of chain.children) need(child.state === 'closed' && child.code === 0 && child.signal === null && child.rawClosedBeforeHash === true && SHA.test(child.stdoutSHA256) && SHA.test(child.stderrSHA256), 'afs-mounted-chain-child-not-closed:' + runtime);
      const mountArguments = chain.children[0].args, at = Array.isArray(mountArguments) ? mountArguments.indexOf('--mountpoint') : -1;
      const mountpoint = mountArguments?.[at + 1], scene = typeof mountpoint === 'string' ? path.posix.basename(path.posix.dirname(mountpoint)) : '';
      need(at >= 0 && /^module-chain-[A-Za-z0-9_-]+$/u.test(scene) && mountpoint === path.posix.dirname(receipt.rawLog) + '/' + scene + '/mnt', 'afs-chain-owned-scene-differs:' + runtime);
      for (const [index, child] of chain.children.entries()) for (const stream of ['stdout', 'stderr']) {
        const bytes = original(prefix + scene + '/child-' + (index + 1) + '.' + stream + '.raw.log', 16 * 1024 ** 2);
        need(hash(bytes) === child[stream + 'SHA256'], 'afs-chain-child-raw-differs:' + runtime);
        if (index === 1 && stream === 'stdout') need(bytes.equals(Buffer.from('AUTHENTICATED_MODULE_READ\n')), 'afs-chain-authenticated-read-raw-differs:' + runtime);
      }
      facts[runtime + 'ChainChildDualRawVerified'] = true;
      const lines = original(runtime + '-afs-full-mounted-profile.stdout.raw.log', 16 * 1024 ** 2).toString().trim().split(/\r?\n/u);
      const actual = JSON.parse(lines.at(-1)!);
      need(actual.status === 'complete-mounted-profile-verified' && actual.target === input.target && actual.runtime === runtime && actual.authenticatedRead === true && actual.conditionalWriteback === true && actual.cleanupVerified === true && isDeepStrictEqual(actual.requiredCases, requiredCases) && isDeepStrictEqual(actual, result.installedVerification?.[runtime]?.mountedProfile), 'afs-full-profile-raw-output-differs:' + runtime);
      facts[runtime + 'NamedMountedCases'] = requiredCases;
    });
  }
  axis('checkedHandoffLauncherOriginalsVerified', () => {
    need(result, 'afs-consumer-result-unavailable');
    const prefix = 'safe-evidence/afs-checked-originals/', summary = json(prefix + 'summary.json');
    need(summary.schemaVersion === 1 && summary.kind === 'fixed-afs-consumer-safe-originals' && summary.sourceSha === input.sourceSha && summary.target === input.target && Array.isArray(summary.files) && summary.files.length === 4, 'afs-safe-original-summary-invalid');
    const expectedFiles = new Set(['summary.json', 'node/handoff.json', 'node/launcher', 'bun/handoff.json', 'bun/launcher']);
    need(input.originals.filter(row => row.path.startsWith(prefix)).length === expectedFiles.size && input.originals.filter(row => row.path.startsWith(prefix)).every(row => expectedFiles.has(row.path.slice(prefix.length))), 'afs-safe-original-extra-file');
    for (const runtime of ['node', 'bun']) {
      const values: Record<string, Buffer> = {};
      for (const role of ['handoff', 'launcher']) {
        const name = runtime + '/' + (role === 'handoff' ? 'handoff.json' : 'launcher');
        const rows = summary.files.filter((row: any) => row.runtime === runtime && row.role === role && row.path === name);
        const retained = result.privateOriginalReferences?.[runtime]?.[role];
        need(rows.length === 1 && retained && rows[0].original?.path === retained.path && rows[0].original.bytes === retained.bytes && rows[0].original.sha256 === retained.sha256 && rows[0].bytes === retained.bytes && rows[0].sha256 === retained.sha256, 'afs-safe-retained-reference-differs:' + runtime + ':' + role);
        ref({ ...rows[0], path: prefix + name }); values[role] = original(prefix + name);
      }
      const handoff = JSON.parse(values.handoff!.toString()), cycle = result.ownedTemporaryRoot + '/' + runtime;
      const keys = ['schemaVersion', 'sourceSha', 'target', 'workspace', 'evidence', 'home', 'packageRoot', 'packageManifest', 'storeRoot', 'runtime', 'archive', 'helper', 'entry', 'launcher', 'cliCore', 'node', 'selectedRuntime', 'preflightDriver', 'runtimes'].sort();
      need(isDeepStrictEqual(Object.keys(handoff).sort(), keys) && handoff.schemaVersion === 1 && handoff.sourceSha === input.sourceSha && handoff.target === input.target && handoff.runtime === runtime && handoff.home === cycle + '/home' && handoff.storeRoot === cycle + '/home/.xpod/modules', 'afs-safe-handoff-fields-or-coordinate-differ:' + runtime);
      const packageRoot = cycle + '/home/.xpod/modules/afs/' + input.target + '/' + input.product.version + '/package';
      need(handoff.packageRoot === packageRoot && handoff.archive.sha256 === input.product.archiveSha256 && handoff.packageManifest.path === packageRoot + '/package.json', 'afs-safe-handoff-product-differs:' + runtime);
      for (const [role, name] of [['helper', 'helper/agentfs-pod'], ['entry', 'dist/entry.mjs'], ['packageManifest', 'package.json']]) {
        const row = input.productMembers.find(row => row.path === name);
        need(row && handoff[role!]?.path === packageRoot + '/' + name && handoff[role!]?.sha256 === row.sha256 && isDeepStrictEqual(Object.keys(handoff[role!]).sort(), ['path', 'sha256']), 'afs-safe-handoff-member-differs:' + runtime + ':' + role);
      }
      const cli = result.records.find((row: any) => row.label === runtime + '-afs-help')?.argv?.slice(0, -2);
      need(Array.isArray(cli) && cli.length > 0, 'afs-safe-launcher-cli-original-missing:' + runtime);
      const command = (suffix: string) => result.records.find((row: any) => row.label === runtime + '-' + suffix)?.argv;
      for (const [suffix, tail] of [['install-afs', ['module', 'install', 'afs', '--version', input.product.version]], ['list-afs', ['module', 'list']], ['remove-afs', ['module', 'remove', 'afs']]] as const)
        need(isDeepStrictEqual(command(suffix), [...cli, ...tail]), 'afs-fixed-cli-command-differs:' + runtime + ':' + suffix);
      const install = command('normal-cli-install');
      need(Array.isArray(install) && isDeepStrictEqual(install.slice(-8), ['install', '--no-progress', '--no-cache', '--registry', 'https://registry.npmjs.org/', '--backend=copyfile', '--linker=hoisted', '--cache-dir=' + cycle + '/cache']) && !install.includes('--ignore-scripts') && !install.includes('--offline'), 'afs-normal-installed-tools-command-differs:' + runtime);
      const quote = (value: string) => value && !/[^\w@%+=:,./-]/u.test(value) ? value : "'" + value.replaceAll("'", "'\"'\"'") + "'";
      const env = { HOME: cycle + '/home', TMPDIR: cycle, PATH: cycle + '/runtime-bin:/usr/bin:/bin', LANG: 'en_US.UTF-8', SOLID_HOME: cycle + '/home/.solid' };
      const expected = '#!/bin/sh\nunset NODE_PATH NODE_OPTIONS BUN_OPTIONS\n' + Object.entries(env).map(([key, value]) => 'export ' + key + '=' + quote(value) + '\n').join('') + 'exec ' + cli.map(quote).join(' ') + ' "$@"\n';
      need(values.launcher!.equals(Buffer.from(expected)), 'afs-safe-launcher-generated-bytes-differ:' + runtime);
      need(handoff.launcher.sha256 === hash(values.launcher!) && handoff.launcher.path.endsWith('/.private-originals/' + runtime + '/afs-installed-cli'), 'afs-safe-launcher-execution-reference-differs:' + runtime);
      const chain = json(runtime + '-mounted/module-chain.safe.json'), receipt = json(runtime + '-mounted/mounted-' + input.target.split('-')[0] + '.receipt.json');
      need(chain.entrySHA256 === handoff.entry.sha256 && chain.helperSHA256 === handoff.helper.sha256 && chain.runtimeSHA256 === handoff.selectedRuntime.sha256 && chain.launcherSHA256 === handoff.launcher.sha256 &&
        receipt.productArchiveSha256 === handoff.archive.sha256 && receipt.installedHelperSha256 === handoff.helper.sha256 && receipt.installedLauncherPath === handoff.launcher.path && receipt.moduleBinding?.profile === 'afs-normal-installed-consumer' && receipt.moduleBinding.runtime === runtime && receipt.moduleBinding.moduleSourceSHA === input.sourceSha && receipt.moduleBinding.target === input.target && receipt.moduleBinding.installedEntrySHA256 === handoff.entry.sha256 && receipt.moduleBinding.installedHelperSHA256 === handoff.helper.sha256, 'afs-mounted-actual-handoff-bindings-differ:' + runtime);
    }
  });
  axis('toolSnapshotOriginalReferencesVerified', () => {
    need(result, 'afs-consumer-result-unavailable');
    const masterRef = ref(result.verifierToolOriginals, 'verifier-tools/'), master = json(masterRef.path);
    need(master.schemaVersion === 1 && master.kind === 'fixed-afs-consumer-tool-originals' && master.sourceSha === input.sourceSha && Array.isArray(master.roots) && master.roots.length >= 4 && master.roots.length <= 16 && Array.isArray(master.observations), 'afs-tool-snapshot-master-invalid');
    const ids = new Set<string>(), archiveNames = new Set<string>();
    const domainBytes: Record<string, number> = { source: 0, dependencies: 0, toolchain: 0 };
    const inventories = new Map<string, any[]>();
    for (const root of master.roots) {
      need(/^[a-z0-9-]+$/u.test(root.rootId) && !ids.has(root.rootId) && ['source', 'dependencies', 'toolchain'].includes(root.domain) && Array.isArray(root.archives) && root.archives.length && Array.isArray(root.inventories) && root.inventories.length, 'afs-tool-root-invalid'); ids.add(root.rootId);
      const prefix = 'verifier-tools/' + root.rootId + '/';
      for (const archive of root.archives) { const actual = ref(archive, prefix); need(actual.bytes <= limits.shardBytes && !archiveNames.has(actual.path), 'afs-tool-archive-bound-or-duplicate'); archiveNames.add(actual.path); domainBytes[root.domain] += actual.bytes; }
      const rows: any[] = [];
      for (const inventory of root.inventories) { ref(inventory, prefix); const values = json(inventory.path); need(Array.isArray(values), 'afs-tool-inventory-invalid'); rows.push(...values); }
      need(rows.length > 0 && rows.length <= limits.sourceMembers && new Set(rows.map(row => row.path)).size === rows.length, 'afs-tool-inventory-duplicate-or-bound');
      for (const row of rows) need(safe(row.path) && root.archives.some((archive: any) => archive.path === row.archive) && ['file', 'symlink'].includes(row.kind) &&
        (row.kind === 'symlink' ? typeof row.target === 'string' && safe(path.posix.normalize(path.posix.join(path.posix.dirname(row.path), row.target))) : Number.isSafeInteger(row.bytes) && row.bytes >= 0 && SHA.test(row.sha256)), 'afs-tool-item-invalid');
      for (const archive of root.archives) inspectTar(ref(archive), rows);
      inventories.set(root.rootId, rows);
    }
    need(domainBytes.source! <= limits.sourceBytes && domainBytes.dependencies! <= limits.dependencyBytes && domainBytes.toolchain! <= limits.toolchainBytes && Object.values(domainBytes).reduce((a, b) => a + b, 0) <= limits.sourceMaterialBytes, 'afs-tool-domains-byte-bound');
    need(master.roots.some((row: any) => row.role === 'harness' && row.domain === 'source') && master.roots.some((row: any) => row.role === 'harness' && row.domain === 'dependencies') && ids.has('executables') && ids.has('node-registry-tools') && ids.has('bun-registry-tools'), 'afs-tool-required-roots-missing');
    for (const runtime of ['node', 'bun']) for (const moment of ['before', 'after']) {
      const label = runtime + '-' + moment + '-mounted', observations = master.observations.filter((row: any) => row.label === label);
      need(observations.length === 1 && Array.isArray(observations[0].roots), 'afs-tool-before-after-observation-missing:' + label);
      const expected = master.roots.filter((row: any) => row.rootId === runtime + '-registry-tools' || row.role !== 'registry-tools');
      for (const root of expected) {
        const rows = observations[0].roots.filter((row: any) => row.rootId === root.rootId);
        need(rows.length === 1 && Array.isArray(rows[0].inventories), 'afs-tool-before-after-root-missing:' + label);
        const actual: any[] = [];
        for (const inventory of rows[0].inventories) { ref(inventory, 'verifier-tools/'); const values = json(inventory.path); need(Array.isArray(values), 'afs-tool-observed-inventory-invalid'); actual.push(...values); }
        need(isDeepStrictEqual(actual, inventories.get(root.rootId)), 'afs-tool-before-after-inputs-differ:' + label + ':' + root.rootId);
      }
    }
    const executableRows = inventories.get('executables')!;
    const roles = ['node', 'bun', 'python', 'git', 'rg', 'mount', ...(input.target.startsWith('linux-') ? ['fusermount'] : [])];
    need(Array.isArray(master.executables) && master.executables.length === roles.length, 'afs-tool-executable-set-incomplete');
    for (const role of roles) {
      const values = master.executables.filter((row: any) => row.role === role), physical = executableRows.filter(row => row.path === role);
      need(values.length === 1 && physical.length === 1 && values[0].sha256 === physical[0].sha256 && values[0].bytes === physical[0].bytes && values[0].executable === physical[0].executable && values[0].invokedPath === physical[0].invokedPath, 'afs-tool-executable-physical-binding-differs:' + role);
      const value = values[0], label = 'verifier-' + role + '-version', record = result.records.find((row: any) => row.label === label);
      need(record && value.supervisionLabel === label && Array.isArray(value.versionOriginals) && value.versionOriginals.length === 2, 'afs-tool-version-process-originals-missing:' + role);
      const platformBuild = role === 'mount' && input.target.startsWith('darwin-');
      need(isDeepStrictEqual(record.argv, platformBuild ? ['/usr/bin/sw_vers'] : [value.executable, '--version']) && value.versionKind === (platformBuild ? 'platform-build' : 'executable-version'), 'afs-tool-version-command-differs:' + role);
      for (const stream of ['stdout', 'stderr']) {
        const refs = value.versionOriginals.filter((row: any) => row.path === label + '.' + stream + '.raw.log');
        need(refs.length === 1, 'afs-tool-version-dual-raw-missing:' + role); ref(refs[0]); original(refs[0].path);
      }
    }
    facts.toolSnapshotRoots = ids.size;
    // Registry custody and the controlled frozen installation must be verified
    // from their actual process originals, not inferred from installed bytes.
    need(Array.isArray(master.installOriginals), 'afs-tool-install-original-list-missing');
    for (const value of master.installOriginals) ref(value, 'verifier-tools/');
    if (!master.installOriginals.length) {
      pending.add('afs-harness-frozen-install-process-originals-unavailable');
      pending.add('afs-harness-registry-lock-patch-authority-not-established');
      facts.trustedVerifierToolsVerified = false;
    } else {
      const prepared = json('verifier-tools/install/prepared.json'), complete = json('verifier-tools/install/complete.json');
      const workspace = result.ownedTemporaryRoot + '/verifier-harness';
      need(prepared.schemaVersion === 1 && prepared.kind === 'controlled-frozen-afs-verifier-install' && complete.schemaVersion === 1 && complete.kind === 'controlled-frozen-afs-verifier-install-complete' &&
        prepared.workspace === workspace && complete.workspace === workspace && prepared.sourceSha === input.sourceSha && complete.sourceSha === input.sourceSha &&
        isDeepStrictEqual(prepared.sourceBefore, { sha: input.sourceSha, status: '' }) && isDeepStrictEqual(prepared.sourceAfter, prepared.sourceBefore) && isDeepStrictEqual(complete.sourceBefore, prepared.sourceBefore) && isDeepStrictEqual(complete.sourceAfter, prepared.sourceBefore), 'afs-fresh-harness-source-differs');
      ref(complete.prepared, 'verifier-tools/install/');
      need(complete.prepared.path === 'verifier-tools/install/prepared.json' && Array.isArray(complete.commands) && complete.commands.length === harnessLabels.size, 'afs-fresh-harness-command-set-incomplete');
      const expectedGit = master.executables.find((row: any) => row.role === 'git')?.executable, expectedBun = master.executables.find((row: any) => row.role === 'bun')?.invokedPath;
      need(expectedGit && expectedBun && prepared.registry === 'https://registry.npmjs.org/', 'afs-fresh-harness-registry-or-tools-unbound');
      for (const [index, budget] of afsConsumerBudget().harnessCommands.entries()) {
        const recordRef = complete.commands[index]; ref(recordRef, 'verifier-tools/install/'); const record = json(recordRef.path), actual = result.records.find((row: any) => row.label === budget.label);
        need(record.label === budget.label && isDeepStrictEqual(record, actual), 'afs-fresh-harness-command-original-differs:' + budget.label);
        if (budget.label === 'verifier-harness-install') need(isDeepStrictEqual(record.argv, [expectedBun, 'install', '--frozen-lockfile', '--no-cache', '--registry', 'https://registry.npmjs.org/', '--backend=copyfile', '--linker=hoisted', '--cache-dir=' + result.ownedTemporaryRoot + '/verifier-cache']), 'afs-fresh-frozen-install-command-differs');
        if (budget.label === 'verifier-harness-build-tools') need(isDeepStrictEqual(record.argv, [expectedBun, 'run', '--filter', '@undefineds.co/xpod-cli', 'build:tools']), 'afs-fresh-build-tools-command-differs');
        if (budget.label === 'verifier-harness-client') need(isDeepStrictEqual(record.argv, [expectedBun, 'run', '--filter', '@undefineds.co/xpod-client', 'build']), 'afs-fresh-client-command-differs');
        if (budget.label === 'verifier-harness-patch-check') need(isDeepStrictEqual(record.argv, [expectedBun, 'scripts/check-dependency-state.ts', '--runtime-only']), 'afs-fresh-patch-check-command-differs');
        if (budget.label === 'verifier-harness-checkout') need(record.argv[0] === expectedGit && isDeepStrictEqual(record.argv.slice(1, 4), ['-c', 'core.hooksPath=/dev/null', '-C']) && typeof record.argv[4] === 'string' && isDeepStrictEqual(record.argv.slice(5), ['worktree', 'add', '--detach', workspace, input.sourceSha]), 'afs-fresh-checkout-command-differs');
        if (budget.label === 'verifier-harness-remove') need(record.argv[0] === expectedGit && isDeepStrictEqual(record.argv.slice(1, 4), ['-c', 'core.hooksPath=/dev/null', '-C']) && isDeepStrictEqual(record.argv.slice(5), ['worktree', 'remove', '--force', workspace]), 'afs-fresh-remove-command-differs');
      }
      need(Array.isArray(prepared.inputs) && prepared.inputs.length >= 9, 'afs-fresh-install-source-originals-missing');
      const sourceRows = master.roots.filter((root: any) => root.domain === 'source').flatMap((root: any) => inventories.get(root.rootId) ?? []);
      const source = derivedSourceView(input.source);
      need(source && source.sourceSha === input.sourceSha && source.readTrackedGitObject, 'afs-fresh-harness-immutable-private-source-missing');
      assertDerivedSourceCurrent(input.source);
      for (const row of sourceRows) {
        const actual = source.readTrackedGitObject(row.path);
        need(row.kind === 'file' && ['100644', '100755'].includes(actual.mode) && actual.bytes.length === row.bytes && hash(actual.bytes) === row.sha256 &&
          row.mode === (actual.mode === '100755' ? 0o755 : 0o644), 'afs-fresh-harness-immutable-Git-source-differs:' + row.path);
      }
      for (const value of prepared.inputs) { const physical = sourceRows.find((row: any) => row.path === value.sourcePath); const actual = ref(value.original, 'verifier-tools/install/inputs/');
        need(physical?.kind === 'file' && physical.sha256 === actual.sha256 && physical.bytes === actual.bytes, 'afs-fresh-install-input-original-differs'); original(actual.path);
      }
      const packageInput = prepared.inputs.find((row: any) => row.sourcePath === 'package.json'), lock = prepared.inputs.find((row: any) => row.sourcePath === 'bun.lock');
      need(packageInput && lock, 'afs-fresh-package-lock-originals-missing');
      const pkg = json(packageInput.original.path);
      const postinstall = 'bun scripts/patch-jose.js && bun scripts/patch-inrupt-authn-refresh.js && bun scripts/patch-inrupt-authn-transport.js && bun scripts/patch-inrupt-authn-operation-cleanup.js';
      need(pkg.scripts?.postinstall === postinstall && prepared.postinstall === postinstall && Object.values(pkg.patchedDependencies ?? {}).every(name => prepared.inputs.some((row: any) => row.sourcePath === name)), 'afs-fresh-exact-patch-inputs-missing');
      const lockBytes = original(lock.original.path);
      const locked = registryLegalLockEntries(lockBytes);
      need(locked.size > 0, 'afs-fresh-immutable-integrity-lock-missing');
      let packageCount = 0;
      for (const root of master.roots.filter((root: any) => root.role === 'harness' && root.domain === 'dependencies')) {
        need(Array.isArray(root.packages) && root.packages.length > 0, 'afs-fresh-harness-package-identities-missing');
        for (const item of root.packages) {
          need(safe(item.path) && typeof item.name === 'string' && typeof item.version === 'string', 'afs-fresh-package-coordinate-invalid');
          const row = inventories.get(root.rootId)!.find(row => row.path === item.path + '/package.json');
          const location = row && toolLocations.get(row.archive + '\0' + row.path);
          need(location && location.bytes <= 65536, 'afs-fresh-package-manifest-original-missing-or-bound');
          const bytes = input.readOriginalRange(location.archive, location.offset, location.bytes);
          need(bytes.length === location.bytes && hash(bytes) === row.sha256, 'afs-fresh-package-manifest-bytes-differ');
          const manifest = JSON.parse(bytes.toString());
          need(manifest.name === item.name && manifest.version === item.version, 'afs-fresh-package-manifest-identity-differs');
          const sourceManifest = sourceRows.find((source: any) => source.path === item.path + '/package.json');
          if (!item.path.startsWith('node_modules/')) {
            // A workspace is an immutable Git input, never a registry package.
            need(sourceManifest?.sha256 === row.sha256, 'afs-fresh-workspace-manifest-source-unbound');
          } else need(locked.has(item.name + '@' + item.version), 'afs-fresh-package-lock-SRI-missing:' + item.name + '@' + item.version);
          packageCount++;
        }
      }
      facts.freshHarnessPackageManifestLockSriBindings = packageCount;
      for (const runtime of ['node', 'bun']) need(json('safe-evidence/afs-checked-originals/' + runtime + '/handoff.json').workspace === workspace, 'afs-fresh-harness-not-used:' + runtime);
      assertDerivedSourceCurrent(input.source);
      facts.immutableVerifierSourceOriginalsVerified = true;
      facts.controlledFrozenVerifierInstallOriginalsVerified = true;
      facts.trustedVerifierToolsVerified = false;
      pending.add('afs-fresh-harness-target-Bun-runtime-and-upstream-patch-byte-authority-not-yet-independent');
    }

    for (const value of master.pending ?? []) if (typeof value === 'string') pending.add('afs-tool-producer-pending:' + value);
  });
  facts.toolSnapshotEntryBytesVerified = facts.toolSnapshotOriginalReferencesVerified === true;
  const values = Object.freeze([...pending]);
  return Object.freeze({ verified: values.length === 0 && Object.values(facts).every(value => value !== false), pending: values, facts: Object.freeze(facts) });
}
