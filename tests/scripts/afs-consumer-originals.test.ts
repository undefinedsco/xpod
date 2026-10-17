import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { afsConsumerOriginalSelection, inspectAfsConsumerOriginals } from '../../scripts/lib/independent-admission/afs-consumer-originals';
import { REQUIRED_MOUNTED_CASES, MODULE_CHAIN_CASE } from '../../scripts/agentfs-native-ci/mounted/required-cases';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const cases = [...REQUIRED_MOUNTED_CASES, MODULE_CHAIN_CASE];
const bytes = (value: unknown) => Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
function fixture() {
  const files = new Map<string, Buffer>();
  const put = (name: string, value: unknown) => { const data = bytes(value); files.set(name, data); return { path: name, bytes: data.length, sha256: hash(data) }; };
  const get = (name: string) => JSON.parse(files.get(name)!.toString());
  const change = (name: string, mutate: (value: any) => void) => { const value = get(name); mutate(value); put(name, value); };
  const sourceSha = 'a'.repeat(40), target = 'darwin-arm64', owned = '/tmp/xpod-afs-consumer-owned', output = '/tmp/output-private';
  const identities = ['afs-darwin-arm64', 'cli', 'client'].map(name => ({ sourceSha, package: '@undefineds.co/xpod-' + name, version: '0.1.0', archiveSha256: hash(Buffer.from(name)), integrity: 'sha512-' + name, archiveBytes: 10, ...(name.startsWith('afs') ? { target } : {}) }));
  const [product, cliIdentity, clientIdentity] = identities;
  const productMembers = [
    { path: 'helper/agentfs-pod', bytes: 6, sha256: hash(Buffer.from('helper')), mode: 493 },
    { path: 'dist/entry.mjs', bytes: 5, sha256: hash(Buffer.from('entry')), mode: 420 },
  ];
  const pkg = { name: product!.package, version: product!.version, xpodModule: { id: 'afs', files: productMembers.map(row => ({ path: row.path, size: row.bytes, sha256: row.sha256, mode: row.mode })) } };
  const manifest = bytes(pkg); productMembers.push({ path: 'package.json', bytes: manifest.length, sha256: hash(manifest), mode: 420 });
  const result: any = { schemaVersion: 1, kind: 'afs-public-cli-consumer', status: 'passed', sourceSha, transport: 'collected-product-archives', realConsumerValidated: true, forcedCleanup: false, signal: null, processGroupsUnknown: false, ownedTemporaryRootRemoved: true, driverSourcesUnchanged: true, releaseQualified: false, ownedTemporaryRoot: owned,
    inputs: Object.fromEntries(['afs', 'cli', 'client'].map((name, index) => [name + 'Archive', { sha256: identities[index]!.archiveSha256, integrity: identities[index]!.integrity, bytes: 10 }])), records: [], privateOriginalReferences: {}, installedVerification: {} };
  const summary: any = { schemaVersion: 1, kind: 'fixed-afs-consumer-safe-originals', sourceSha, target, files: [] };
  const addRecord = (label: string, argv: string[], stdout = '') => {
    const raw = ['stdout', 'stderr'].map(stream => ({ ...put(label + '.' + stream + '.raw.log', stream === 'stdout' ? stdout : ''), sizeIsFinal: true }));
    result.records.push({ label, argv, status: 'passed', returncode: 0, waitStatus: 'known', rawHandlesClosed: true, rawClosed: true, rawClosedBeforeHash: true, rawEligible: true, ownedGroupAbsent: true, pid: 101, raw });
  };
  for (const runtime of ['node', 'bun']) {
    const cycle = owned + '/' + runtime, prefix = runtime + '-mounted/', evidence = output + '/' + runtime + '-mounted', scene = 'module-chain-owned', mountpoint = evidence + '/' + scene + '/mnt';
    const packageRoot = cycle + '/home/.xpod/modules/afs/' + target + '/0.1.0/package', launcherPath = output + '/.private-originals/' + runtime + '/afs-installed-cli';
    const cli = ['/installed/cli'];
    const launcher = '#!/bin/sh\nunset NODE_PATH NODE_OPTIONS BUN_OPTIONS\n' + Object.entries({ HOME: cycle + '/home', TMPDIR: cycle, PATH: cycle + '/runtime-bin:/usr/bin:/bin', LANG: 'en_US.UTF-8', SOLID_HOME: cycle + '/home/.solid' }).map(([key, value]) => 'export ' + key + '=' + value + '\n').join('') + 'exec /installed/cli "$@"\n';
    const bound = (path: string, sha256 = hash(Buffer.from(path))) => ({ path, sha256 });
    const handoff: any = { schemaVersion: 1, sourceSha, target, workspace: '/workspace', evidence, home: cycle + '/home', packageRoot, storeRoot: cycle + '/home/.xpod/modules', runtime,
      archive: bound('/archive/afs.tgz', product!.archiveSha256), packageManifest: bound(packageRoot + '/package.json', hash(manifest)), helper: bound(packageRoot + '/helper/agentfs-pod', productMembers[0]!.sha256), entry: bound(packageRoot + '/dist/entry.mjs', productMembers[1]!.sha256), launcher: bound(launcherPath, hash(bytes(launcher))), cliCore: bound(cycle + '/node_modules/@undefineds.co/xpod-cli/dist/xpod.mjs'), node: bound('/fixed/node'), selectedRuntime: bound('/fixed/' + runtime), preflightDriver: bound('/fixed/module-admission.mjs'), runtimes: { node: bound('/fixed/node'), bun: bound('/fixed/bun') } };
    result.privateOriginalReferences[runtime] = {};
    for (const [role, value] of [['handoff', handoff], ['launcher', launcher]] as const) {
      const name = runtime + '/' + (role === 'handoff' ? 'handoff.json' : 'launcher'), ref = put('safe-evidence/afs-checked-originals/' + name, value);
      const original = { path: '.private-originals/' + runtime + '/' + (role === 'handoff' ? 'afs-installed-handoff.json' : 'afs-installed-cli'), bytes: ref.bytes, sha256: ref.sha256 };
      result.privateOriginalReferences[runtime][role] = original; summary.files.push({ runtime, role, path: name, bytes: ref.bytes, sha256: ref.sha256, original });
    }
    put(runtime + '-installed-package.json', manifest); put(runtime + '-pointer.json', { package: product!.package, version: '0.1.0', integrity: product!.integrity, manifestSha256: hash(manifest) });
    for (const name of ['registry-tools.json', 'registry-package.json', 'registry-bun.lock', 'binding.json', 'probe.mjs', 'deny.sb', 'transport.mjs', 'transport.jsonl']) put(runtime + '-' + name, 'fixed');
    const report = { testResults: [{ assertionResults: cases.map(title => ({ title, status: 'passed' })) }], numFailedTests: 0, numFailedTestSuites: 0 };
    const reportRef = put(prefix + 'mounted-darwin.vitest-report.json', report), rawRef = put(prefix + 'mounted-darwin.raw.log', '7 named cases passed\n');
    const children = Array.from({ length: 5 }, (_, index) => {
      const stdout = index === 0 ? 'mounted at ' + mountpoint + '\n' : index === 1 ? 'AUTHENTICATED_MODULE_READ\n' : index === 3 ? 'commit applied=1 conflicts=0 errors=0\n' : '';
      const refs = ['stdout', 'stderr'].map(stream => put(prefix + scene + '/child-' + (index + 1) + '.' + stream + '.raw.log', stream === 'stdout' ? stdout : ''));
      return { command: '/installed/cli', args: index === 0 ? ['afs', 'mount', '--mountpoint', mountpoint] : [], state: 'closed', code: 0, signal: null, rawClosedBeforeHash: true, stdoutSHA256: refs[0]!.sha256, stderrSHA256: refs[1]!.sha256 };
    });
    put(prefix + 'module-chain.safe.json', { status: 'executed', actualAuthenticatedRead: true, actualConditionalWriteback: true, authExchanges: 1, daemonAbsenceProven: true, kernelAbsent: true, children, entrySHA256: handoff.entry.sha256, helperSHA256: handoff.helper.sha256, runtimeSHA256: handoff.selectedRuntime.sha256, launcherSHA256: handoff.launcher.sha256 });
    put(prefix + 'module-chain-cleanup.safe.json', { cleanupVerified: true, kernelAbsent: true, daemonsAbsent: true, groupsAbsent: true, identitiesKnown: true, unmountClosedSuccessfully: true, sceneRetained: false, children });
    put(prefix + scene + '/auth/credentials.json', { secrets: { clientSecret: 'must-never-be-selected' } });
    put(prefix + scene + '/session/proxy.json', { capability: 'must-never-be-selected' });
    put(prefix + 'mounted-darwin.receipt.json', { schemaVersion: 1, os: 'darwin', backend: 'nfs', producerStarted: true, producerClosed: true, actualWait: true, rawClosedBeforeHash: true, exit: 0, signal: null, ownedGroupAbsent: true, status: 'ok', mountExecuted: true, failureReason: null, rawSHA256: rawRef.sha256, rawLog: evidence + '/mounted-darwin.raw.log', vitestReport: { sha256: reportRef.sha256, requiredCases: cases }, productArchiveSha256: handoff.archive.sha256, installedHelperSha256: handoff.helper.sha256, installedLauncherPath: launcherPath, moduleBinding: { profile: 'afs-normal-installed-consumer', moduleSourceSHA: sourceSha, target, runtime, installedEntrySHA256: handoff.entry.sha256, installedHelperSHA256: handoff.helper.sha256 } });
    const profile = { status: 'complete-mounted-profile-verified', target, runtime, requiredCases: cases, authenticatedRead: true, conditionalWriteback: true, cleanupVerified: true };
    result.installedVerification[runtime] = { mountedProfile: profile };
    for (const suffix of ['runtime-version', 'runtime-target', 'probe', 'normal-cli-install', 'install-afs', 'list-afs', 'afs-help', 'afs-native-version', 'afs-full-mounted-profile', 'remove-afs']) {
      let argv = ['/fixed/' + runtime];
      if (suffix === 'afs-help') argv = [...cli, 'afs', '--help'];
      if (suffix === 'install-afs') argv = [...cli, 'module', 'install', 'afs', '--version', '0.1.0'];
      if (suffix === 'list-afs') argv = [...cli, 'module', 'list'];
      if (suffix === 'remove-afs') argv = [...cli, 'module', 'remove', 'afs'];
      if (suffix === 'normal-cli-install') argv = ['/fixed/bun', 'install', '--no-progress', '--no-cache', '--registry', 'https://registry.npmjs.org/', '--backend=copyfile', '--linker=hoisted', '--cache-dir=' + cycle + '/cache'];
      addRecord(runtime + '-' + suffix, argv, suffix === 'afs-full-mounted-profile' ? JSON.stringify(profile) + '\n' : '');
    }
  }
  put('safe-evidence/afs-checked-originals/summary.json', summary); put('result.json', result);
  const input = { stage: 'prepublish' as const, sourceSha, target, product: product!, productMembers, tools: [cliIdentity!, clientIdentity!],
    get originals() { return [...files].map(([path, data]) => ({ path, sha256: hash(data), bytes: data.length, mode: 420 })); },
    readOriginal(name: string, maximum: number) { const data = files.get(name); if (!data || data.length > maximum) throw Error('fixture bounded original'); return Buffer.from(data); },
    readOriginalRange(name: string, offset: number, length: number) { if (length > 65536) throw Error('fixture range bound'); return Buffer.from(files.get(name)!.subarray(offset, offset + length)); } };
  return { input, files, put, get, change };
}

describe('AFS original semantics (origin-free fixtures never issue authority)', () => {
  it('verifies mounted/raw/product semantics but keeps absent tool recipe pending', () => {
    const { input } = fixture(), actual = inspectAfsConsumerOriginals(input);
    expect(actual.facts.consumerDualRawOriginalsVerified).toBe(true);
    expect(actual.facts.nodeFullMountedOriginalsVerified).toBe(true);
    expect(actual.facts.bunFullMountedOriginalsVerified).toBe(true);
    expect(actual.facts.checkedHandoffLauncherOriginalsVerified).toBe(true);
    expect(actual.facts.nodeInstalledProductVerified).toBe(true);
    expect(actual.verified).toBe(false);
  });
  it('does not accept hash-rebound skipped named cases', () => {
    const f = fixture(); f.change('node-mounted/mounted-darwin.vitest-report.json', value => { value.testResults[0].assertionResults[0].status = 'pending'; });
    f.change('node-mounted/mounted-darwin.receipt.json', value => { value.vitestReport.sha256 = hash(f.files.get('node-mounted/mounted-darwin.vitest-report.json')!); });
    expect(inspectAfsConsumerOriginals(f.input).pending.some(value => value.includes('required-mounted-case-not-passed'))).toBe(true);
  });
  it('requires both actual streams and actual child raw bytes', () => {
    const f = fixture(); f.files.delete('bun-afs-full-mounted-profile.stderr.raw.log');
    expect(inspectAfsConsumerOriginals(f.input).facts.consumerDualRawOriginalsVerified).toBe(false);
    const g = fixture(); g.put('node-mounted/module-chain-owned/child-2.stdout.raw.log', 'different content');
    expect(inspectAfsConsumerOriginals(g.input).facts.nodeFullMountedOriginalsVerified).toBe(false);
  });
  it('selects only registered fixed roles, never scene credential or proxy siblings', () => {
    const f = fixture(), selected = afsConsumerOriginalSelection(f.input);
    expect(selected.files.some(row => row.path.endsWith('child-2.stdout.raw.log'))).toBe(true);
    expect(selected.files.some(row => /credentials|proxy\.json|\.private-originals/u.test(row.path))).toBe(false);
  });
  it('requires archive transport originals but excludes them for real registry transport', () => {
    const f = fixture(); f.files.delete('node-transport.jsonl');
    expect(afsConsumerOriginalSelection(f.input).pending).toContain('afs-transport-original-missing:node-transport.jsonl');
    f.change('result.json', value => { value.transport = 'production-npm-registry'; });
    const actual = afsConsumerOriginalSelection(f.input);
    expect(actual.files.some(row => row.path.endsWith('-transport.mjs') || row.path.endsWith('-transport.jsonl'))).toBe(false);
    expect(actual.files.some(row => row.path === 'node-binding.json')).toBe(true);
    expect(actual.pending).not.toContain('afs-transport-original-missing:node-transport.jsonl');
  });
  it('withholds hash-rebound child raw containing an arbitrary credential field', () => {
    const f = fixture(), name = 'node-mounted/module-chain-owned/child-1.stdout.raw.log'; f.put(name, 'token=secret-marker\n');
    f.change('node-mounted/module-chain.safe.json', value => { value.children[0].stdoutSHA256 = hash(f.files.get(name)!); });
    const actual = afsConsumerOriginalSelection(f.input);
    expect(actual.files.some(row => row.path === name)).toBe(false);
    expect(actual.pending.some(value => value.includes('raw-safe-schema-differs'))).toBe(true);
  });
  it('rejects unknown launcher environment content and normal-install lifecycle bypass', () => {
    const f = fixture(); f.put('safe-evidence/afs-checked-originals/node/launcher', '#!/bin/sh\nexport TOKEN=secret\n');
    expect(inspectAfsConsumerOriginals(f.input).facts.checkedHandoffLauncherOriginalsVerified).toBe(false);
    const g = fixture(); g.change('result.json', value => { value.records.find((row: any) => row.label === 'node-normal-cli-install').argv.push('--ignore-scripts'); });
    expect(inspectAfsConsumerOriginals(g.input).pending.some(value => value.includes('normal-installed-tools-command-differs'))).toBe(true);
  });
});

it('streams complete tool tar entries and rejects bytes even when outer references are rebound', () => {
  const f = fixture();
  const tar = (content: Buffer) => {
    const h = Buffer.alloc(512), octal = (at: number, size: number, n: number) => h.write(n.toString(8).padStart(size - 1, '0') + '\0', at, size, 'ascii');
    h.write('input'); octal(100, 8, 420); octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, content.length); octal(136, 12, 0);
    h.fill(32, 148, 156); h[156] = 48; const sum = [...h].reduce((a, b) => a + b, 0); h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    return Buffer.concat([h, content, Buffer.alloc((512 - content.length % 512) % 512), Buffer.alloc(1024)]);
  };
  const roots = [['source', 'harness', 'source'], ['harness', 'harness', 'dependencies'], ['executables', 'executables', 'toolchain'], ['node-registry-tools', 'registry-tools', 'dependencies'], ['bun-registry-tools', 'registry-tools', 'dependencies']].map(([rootId, role, domain]) => {
    const archive = f.put('verifier-tools/' + rootId + '/original.tar', tar(Buffer.from('actual')));
    const inventory = f.put('verifier-tools/' + rootId + '/inventory.json', [{path: 'input', archive: archive.path, kind: 'file', bytes: 6, sha256: hash(Buffer.from('actual')), mode: 420}]);
    return {rootId, role, domain, archives: [archive], inventories: [inventory]};
  });
  const save = () => { const master = f.put('verifier-tools/master.json', {schemaVersion: 1, kind: 'fixed-afs-consumer-tool-originals', sourceSha: f.input.sourceSha, roots, observations: [], installOriginals: []}); f.change('result.json', value => {value.verifierToolOriginals = master;}); };
  save();
  expect(inspectAfsConsumerOriginals(f.input).pending).toContain('afs-tool-before-after-observation-missing:node-before-mounted');
  roots[0]!.archives[0] = f.put(roots[0]!.archives[0]!.path, tar(Buffer.from('forged'))); save();
  expect(inspectAfsConsumerOriginals(f.input).pending).toContain('afs-tool-tar-file-bytes-differ');
});

it('exports actual encoded scoped patch filenames and rejects credential-shaped install inputs', () => {
  const f = fixture(), patch = f.put('verifier-tools/install/inputs/patches/@solid%2Fcommunity-server@8.0.0-alpha.1.patch', 'fixed patch');
  const select = (row: typeof patch) => {
    const master = f.put('verifier-tools/manifest-0000.json', {roots: [], observations: [], installOriginals: [row]});
    f.change('result.json', value => {value.verifierToolOriginals = master;});
    return afsConsumerOriginalSelection(f.input);
  };
  expect(select(patch).files.some(row => row.path === patch.path)).toBe(true);
  const secret = f.put('verifier-tools/install/inputs/.npmrc', 'token=secret-marker');
  const actual = select(secret);
  expect(actual.files.some(row => row.path === secret.path)).toBe(false);
  expect(actual.pending).toContain('afs-transport-install-original-role-invalid');
});

it('imports original-only validation without any built runtime client dependency', () => {
  const code = 'import {mock} from "bun:test"; mock.module("@undefineds.co/xpod-client",()=>{throw new Error("built client must not be loaded")}); await import("./scripts/lib/independent-admission/afs-consumer-originals.ts"); console.log("pure-original-import-ok")';
  expect(execFileSync('bun', ['-e', code], {cwd: path.resolve(__dirname, '../..'), encoding: 'utf8'}).trim()).toBe('pure-original-import-ok');
});
