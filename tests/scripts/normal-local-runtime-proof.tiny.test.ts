/** Ordinary local-runtime evidence: real inspector, no process execution.
 * The fixture builds a genuinely self-consistent master over synthetic bytes so
 * every predicate can be exercised, then mutates one field at a time. It never
 * invokes Docker or a producer and never asserts a legacy observer claim. */
import {test, expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  NORMAL_RUNTIME_KIND,
  NORMAL_RUNTIME_MODEL,
  inspectNormalLocalRuntimeMaster,
} from '../../scripts/lib/independent-admission/candidate-service-native-runtime-originals';
import normalSmokeCases from '../../scripts/lib/normal-local-runtime-smoke-cases.json';

/** The one shared smoke-case source. Responses must carry the exact bindings,
 * not a needle that merely appears somewhere in the body. */
const expectedBody = (bindings: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({head: {vars: []}, results: {bindings}, ...extra});

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const repoRoot = path.resolve(__dirname, '../..');
const collector = path.join(repoRoot, 'scripts/collect-normal-local-runtime-originals.py');
const RECIPE = ['docker/qlever-local-runtime/Dockerfile',
  'qlever/scripts/run-focused-native-build.sh', 'qlever/qlever.lock.json'] as const;
const RECIPE_BYTES: Record<string, Buffer> = Object.fromEntries(
  RECIPE.map(name => [name, Buffer.from('immutable recipe bytes for ' + name)]));

function fixture(options: {body?: (id: string) => string} = {}) {
  const members = new Map<string, Buffer>();
  const put = (name: string, body: string | Buffer) => {
    members.set(name, Buffer.from(body));
    return {path: name, bytes: Buffer.byteLength(body), sha256: sha(body)};
  };
  const runtimeImage = 'ghcr.io/undefinedsco/xpod-qlever-local-runtime@sha256:' + 'e'.repeat(64);
  const sdkImage = 'ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:' + 'd'.repeat(64);
  const executable = put('artifact/runtime/bin/xpod_qlever_local_runtime', 'ELF-runtime');
  put('artifact/runtime/manifest.json', '{"schemaVersion":1}');
  const inventoryRows = RECIPE.map(name => ({path: './' + name,
    bytes: RECIPE_BYTES[name]!.length, sha256: sha(RECIPE_BYTES[name]!), mode: 0o644}));
  put('source-inventory.json', JSON.stringify(inventoryRows));
  const smokeRows = [
    {type: 'ready', adapterAbiVersion: 1, physicalBackendAbiVersion: 1},
    ...normalSmokeCases.map(row => ({id: row.request.id, type: 'result',
      result: {status: 'ok', body: options.body
        ? options.body(row.request.id) : expectedBody(row.bindings)}})),
  ];
  const stdoutBytes = Buffer.from(smokeRows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const stderrBytes = Buffer.from('');
  put('smoke/child/stdout.raw', stdoutBytes);
  put('smoke/child/stderr.raw', stderrBytes);
  const command = ['docker', 'run', '--rm', '-i', '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--user', '1001:1001',
    '--name', 'xpod-normal-runtime-smoke-0123456789abcdef', '--mount',
    'type=bind,src=/x/smoke,dst=/data', runtimeImage, '--sqlite-path',
    '/data/runtime-smoke.sqlite'];
  // The consumer now requires the reviewed sequential driver, never the old
  // `bash -c 'exec docker run …'` string that fed every query before shutdown.
  const driver = ['python3', '-B', path.join(repoRoot,
    'scripts/collect-normal-local-runtime-originals.py'), '--smoke-session',
    JSON.stringify(command)];
  const receipt = {schemaVersion: 1, command: driver,
    actualWait: true, exit: 0, signal: null, rawClosedBeforeHash: true,
    stdout: {path: 'stdout.raw', bytes: stdoutBytes.length, sha256: sha(stdoutBytes)},
    stderr: {path: 'stderr.raw', bytes: 0, sha256: sha(stderrBytes)}};
  put('smoke/child/command.receipt.json', JSON.stringify(receipt));
  const facts = {adapterAbiVersion: 1, physicalBackendAbiVersion: 1,
    resultIds: normalSmokeCases.map(row => row.request.id)};
  const evidence = {schemaVersion: 1, kind: 'normal-local-runtime-functional-smoke',
    proofModel: NORMAL_RUNTIME_MODEL, command, exit: 0, signal: null, actualWait: true,
    rawClosedBeforeHash: true, ownedGroupAbsentAfterWait: true,
    stdout: {path: 'smoke/child/stdout.raw', bytes: stdoutBytes.length, sha256: sha(stdoutBytes)},
    stderr: {path: 'smoke/child/stderr.raw', bytes: 0, sha256: sha(stderrBytes)},
    commandReceipt: {path: 'smoke/child/command.receipt.json',
      bytes: Buffer.byteLength(JSON.stringify(receipt)), sha256: sha(JSON.stringify(receipt))},
    facts};
  put('smoke/functional-smoke.json', JSON.stringify(evidence));
  const originals = [...members.keys()].sort().map(name => ({
    path: name, bytes: members.get(name)!.length, sha256: sha(members.get(name)!) }));
  const master: any = {
    schemaVersion: 1, kind: NORMAL_RUNTIME_KIND, proofModel: NORMAL_RUNTIME_MODEL,
    identity: {sourceSha: '1'.repeat(40), runId: 7, runAttempt: 2, job: 'publish',
      target: 'linux-x64', sdkProfile: 'service-trixie', sdkImage,
      runtimeImage, runtimeConfigDigest: 'sha256:' + 'f'.repeat(64),
      sdkInputHash: 'a'.repeat(64)},
    sdkInputHash: 'a'.repeat(64), runtimeImage,
    runtimeConfigDigest: 'sha256:' + 'f'.repeat(64),
    recipe: {...Object.fromEntries(RECIPE.map(name => [name, sha(RECIPE_BYTES[name]!)])),
      qleverTree: '2'.repeat(40)},
    sourceInventory: {path: 'source-inventory.json',
      bytes: members.get('source-inventory.json')!.length,
      sha256: sha(members.get('source-inventory.json')!)},
    runtimeRoot: 'artifact/runtime',
    runtimeMembers: {'bin': {type: 'directory', mode: 0o755, bytes: 0},
      'bin/xpod_qlever_local_runtime': {type: 'file', mode: 0o755,
        bytes: executable.bytes, sha256: executable.sha256},
      'manifest.json': {type: 'file', mode: 0o644,
        bytes: members.get('artifact/runtime/manifest.json')!.length,
        sha256: sha(members.get('artifact/runtime/manifest.json')!)}},
    smoke: {evidence: {path: 'smoke/functional-smoke.json',
      bytes: members.get('smoke/functional-smoke.json')!.length,
      sha256: sha(members.get('smoke/functional-smoke.json')!)},
      commandReceipt: evidence.commandReceipt, stdout: evidence.stdout, stderr: evidence.stderr},
    guarantees: {generatedInputCausality: false, kernelReadOnlyEnforcement: false,
      syscallSourceReadInventory: false, toolchainExecutionLifetime: false},
    nonClaims: ['syscallSourceReadInventory', 'generatedInputCausality',
      'toolchainExecutionLifetime', 'kernelReadOnlyEnforcement'],
    releaseAccepted: false, pending: [],
    scope: 'normal-runtime-v1 ... It does NOT prove syscall source reads.',
    originals, retainedOriginalBytes: originals.reduce((n, row) => n + row.bytes, 0)};
  const masterBytes = Buffer.from(JSON.stringify(master));
  members.set('materials.json', masterBytes);
  const masterRef = {path: 'materials.json', bytes: masterBytes.length, sha256: sha(masterBytes)};
  const tracked: Record<string, Buffer> = {...RECIPE_BYTES};
  const source = {sourceSha: '1'.repeat(40), trackedPaths: Object.keys(tracked),
    readTracked: (name: string) => tracked[name]};
  const sdkMaster = {schemaVersion: 1, kind: 'qlever-linux-sdk-originals',
    buildExecutionModel: 'normal-build-v1',
    identity: {sourceSha: '9'.repeat(40), runId: 11, runAttempt: 1,
      sdkProfile: 'service-trixie', target: 'linux-x64'},
    image: {referenceByDigest: sdkImage},
    normalBuild: {inputHash: 'a'.repeat(64)}};
  const sdkBytes = Buffer.from(JSON.stringify(sdkMaster));
  const sdk = {masterReference: {path: 'materials.json', bytes: sdkBytes.length,
      sha256: sha(sdkBytes)},
    originFacts: {sourceSha: '9'.repeat(40), runId: 11, runAttempt: 1, artifactId: 5},
    readOriginal: () => sdkBytes};
  let revoked = false;
  const jobBytes = Buffer.from(JSON.stringify({jobs: [{id: 33,
    name: 'publish_qlever_local_runtime / publish', conclusion: 'success'}]}));
  const nativeOriginals = [{name: 'jobs.original.json', endpoint: 'x',
    bytes: jobBytes.length, sha256: sha(jobBytes)}];
  const current = () => { if (revoked) throw Error('custody revoked'); };
  const read = (value: any, maximum = 4 * 1024 ** 2) => {
    current();
    const body = members.get(value?.path);
    if (!body || body.length !== value.bytes || sha(body) !== value.sha256) throw Error('bad ref');
    if (body.length > maximum) throw Error('too big');
    return body;
  };
  const reference = (value: any) => {
    current();
    const body = members.get(value?.path);
    if (!body || body.length !== value.bytes || sha(body) !== value.sha256) throw Error('bad ref');
    return {path: value.path, bytes: value.bytes, sha256: value.sha256};
  };
  return {master, masterRef, members, read, reference, source, sdk, current,
    nativeOriginals, jobBytes,
    admission: {verified: true, facts: {sdkBuildExecutionModel: 'normal-build-v1',
      sdkNormalBuildAdmissionVerified: true}}, revoke() { revoked = true; }, rewrite(name: string, body: string) {
      const next = Buffer.from(body);
      members.set(name, next);
    }};
}

function inspect(value: ReturnType<typeof fixture>) {
  return inspectNormalLocalRuntimeMaster(value.masterRef, value.master, {
    read: value.read, reference: value.reference, members: value.members,
    native: {originFacts: {sourceSha: '1'.repeat(40), runId: 7, runAttempt: 2,
        target: 'linux-x64', producerJobId: 33, originals: value.nativeOriginals},
      metadataOriginals: [{name: 'jobs.original.json', data: value.jobBytes}],
      readOriginal: () => Buffer.from(JSON.stringify(value.master))},
    source: value.source, sdk: value.sdk, admission: value.admission, current: value.current});
}

test('ordinary proof binds source/SDK/runtime/smoke and issues a view with explicit non-claims', () => {
  const value = fixture();
  const result = inspect(value);
  expect(result.observation.proofModel).toBe(NORMAL_RUNTIME_MODEL);
  expect(result.observation.pending).toEqual([]);
  expect([...result.facts.nonClaims].sort()).toEqual(['generatedInputCausality',
    'kernelReadOnlyEnforcement', 'syscallSourceReadInventory', 'toolchainExecutionLifetime']);
  expect(result.view.members.some(row => String(row.path).endsWith('/bin/xpod_qlever_local_runtime'))).toBe(true);
  const bindings = result.view.inputBindingsForMember('bin/xpod_qlever_local_runtime');
  expect(bindings).toHaveLength(3);
  expect(bindings.some(row => row.via === 'git' && row.kind === 'reads'
    && row.path === '/workspace/xpod/docker/qlever-local-runtime/Dockerfile')).toBe(true);
});

test('rejects any mixed proof model, wrong SDK image or fabricated non-claim', () => {
  for (const mutate of [
    (v: ReturnType<typeof fixture>) => { v.master.kind = 'candidate-service-native-runtime-originals'; },
    (v: ReturnType<typeof fixture>) => { v.master.proofModel = 'controller-readonly-v1'; },
    (v: ReturnType<typeof fixture>) => { v.master.identity.sdkImage = 'ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:' + '0'.repeat(64); },
    (v: ReturnType<typeof fixture>) => { v.master.guarantees.syscallSourceReadInventory = true; },
    (v: ReturnType<typeof fixture>) => { v.master.runtimeImage = 'ghcr.io/undefinedsco/xpod-qlever-local-runtime@sha256:' + '0'.repeat(64); },
    (v: ReturnType<typeof fixture>) => { v.master.identity.target = 'linux-arm64'; },
    (v: ReturnType<typeof fixture>) => { v.master.releaseAccepted = true; },
    (v: ReturnType<typeof fixture>) => { v.master.pending = ['invented']; },
  ]) { const value = fixture(); mutate(value); expect(() => inspect(value)).toThrow(); }
});

test('rejects empty or different bindings even when the needle text is present', () => {
  // The historical leak: the body still contains "alpha card" / the graph URI
  // as prose, but the actual SPARQL bindings are empty or reordered.
  const empty = fixture({body: () => expectedBody([],
    {profile: 'alpha card urn:xpod:smoke:g:allowed'})});
  expect(() => inspect(empty)).toThrow(/bindings/u);

  const wrongGraph = fixture({body: id => expectedBody(id === 'default-named-graph'
    ? [{s: {type: 'uri', value: 'urn:xpod:smoke:s:document'},
        o: {type: 'literal', value: 'document'},
        g: {type: 'uri', value: 'urn:xpod:smoke:g:allowed'}}]
    : normalSmokeCases.find(row => row.request.id === id)!.bindings)});
  expect(() => inspect(wrongGraph)).toThrow(/bindings/u);
});

test('rejects a rewritten runtime member, smoke stream or recipe bytes', () => {
  const member = fixture();
  member.rewrite('artifact/runtime/manifest.json', '{"schemaVersion":2}');
  expect(() => inspect(member)).toThrow();

  const stream = fixture();
  stream.rewrite('smoke/child/stdout.raw', '{"type":"ready"}\n');
  expect(() => inspect(stream)).toThrow();

  const recipe = fixture();
  const original = recipe.source.readTracked;
  recipe.source.readTracked = (name: string) => Buffer.concat([original(name), Buffer.from('x')]);
  expect(() => inspect(recipe)).toThrow();

  const revoked = fixture();
  revoked.revoke();
  expect(() => inspect(revoked)).toThrow();
});

test('rejects a non-canonical smoke user or a driver receipt that differs from it', () => {
  const rebuild = (patch: (command: string[], receipt: any) => void) => {
    const value = fixture();
    const evidenceName = 'smoke/functional-smoke.json';
    const receiptName = 'smoke/child/command.receipt.json';
    const evidence: any = JSON.parse(value.members.get(evidenceName)!.toString());
    const receipt: any = JSON.parse(value.members.get(receiptName)!.toString());
    patch(evidence.command, receipt);
    receipt.command = ['python3', '-B', collector, '--smoke-session', JSON.stringify(evidence.command)];
    value.rewrite(receiptName, JSON.stringify(receipt));
    value.rewrite(evidenceName, JSON.stringify(evidence));
    value.master.smoke.evidence = {path: evidenceName,
      bytes: value.members.get(evidenceName)!.length, sha256: sha(value.members.get(evidenceName)!)};
    value.master.smoke.commandReceipt = {path: receiptName,
      bytes: value.members.get(receiptName)!.length,
      sha256: sha(value.members.get(receiptName)!)};
    const originals = value.master.originals as any[];
    for (const row of originals) {
      const body = value.members.get(row.path);
      if (body) { row.bytes = body.length; row.sha256 = sha(body); }
    }
    value.master.retainedOriginalBytes = originals.reduce((n: number, row: any) => n + row.bytes, 0);
    const masterBytes = Buffer.from(JSON.stringify(value.master));
    value.members.set('materials.json', masterBytes);
    value.masterRef = {path: 'materials.json', bytes: masterBytes.length, sha256: sha(masterBytes)};
    return value;
  };
  for (const user of ['1001', '1001:', ':1001', '-1:1001', '01001:1001',
    '1001:01001', ' 1001:1001', '1001:1001 ', '1001:1001:0', '1001.5:1001',
    'root:root', '1001:1001\n', '2147483648:1001', '1001:2147483648', '4000000000:1001', '4294967295:1001', '4294967296:1001']) {
    const value = rebuild(command => { command[command.indexOf('--user') + 1] = user; });
    expect(() => inspect(value)).toThrow(/functional smoke/u);
  }
  // Canonical user but a driver receipt naming the old default (root): the
  // command is well-formed yet the driver would run a different uid:gid.
  const mismatch = fixture();
  const receiptName = 'smoke/child/command.receipt.json';
  const evidenceName = 'smoke/functional-smoke.json';
  const receipt: any = JSON.parse(mismatch.members.get(receiptName)!.toString());
  const dockerArgv = JSON.parse(receipt.command[4]);
  dockerArgv[dockerArgv.indexOf('--user') + 1] = '0:0';
  receipt.command[4] = JSON.stringify(dockerArgv);
  mismatch.rewrite(receiptName, JSON.stringify(receipt));
  const evidence: any = JSON.parse(mismatch.members.get(evidenceName)!.toString());
  evidence.commandReceipt = {path: receiptName,
    bytes: mismatch.members.get(receiptName)!.length,
    sha256: sha(mismatch.members.get(receiptName)!)};
  mismatch.rewrite(evidenceName, JSON.stringify(evidence));
  mismatch.master.smoke.commandReceipt = evidence.commandReceipt;
  mismatch.master.smoke.evidence = {path: evidenceName,
    bytes: mismatch.members.get(evidenceName)!.length,
    sha256: sha(mismatch.members.get(evidenceName)!)};
  for (const row of mismatch.master.originals as any[]) {
    const body = mismatch.members.get(row.path);
    if (body) { row.bytes = body.length; row.sha256 = sha(body); }
  }
  mismatch.master.retainedOriginalBytes =
    (mismatch.master.originals as any[]).reduce((n, row) => n + row.bytes, 0);
  const masterBytes = Buffer.from(JSON.stringify(mismatch.master));
  mismatch.members.set('materials.json', masterBytes);
  mismatch.masterRef = {path: 'materials.json', bytes: masterBytes.length, sha256: sha(masterBytes)};
  expect(() => inspect(mismatch)).toThrow(/driver argv|functional smoke/u);
  // And the command itself must really be the tampered one, proving the throw
  // came from the uid:gid comparison rather than an unrelated reference drift.
  const driverArgv = JSON.parse(JSON.parse(
    mismatch.members.get(receiptName)!.toString()).command[4]);
  expect(driverArgv[driverArgv.indexOf('--user') + 1]).toBe('0:0');
});

test('the normal collector CLI fails closed on unbounded or non-immutable inputs', () => {
  // Behaviour against the real executable; the actual helper reuse and the
  // sequential smoke driver are exercised through the real orchestration in
  // normal-local-runtime-producer-seam.tiny.test.ts, not by reading source.
  const run = (args: string[]) => spawnSync('python3', [collector, ...args],
    {cwd: repoRoot, encoding: 'utf8'});
  const temp = mkdtempSync(path.join(repoRoot, '.test-data/normal-runtime-proof-'));
  try {
    const base = ['--source-sha', '1'.repeat(40),
      '--sdk-image', 'ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:' + '2'.repeat(64),
      '--runtime-image', 'ghcr.io/undefinedsco/xpod-qlever-local-runtime@sha256:' + '3'.repeat(64),
      '--sdk-input-hash', '4'.repeat(64), '--target', 'linux-x64',
      '--run-id', '1', '--run-attempt', '1',
      '--job', 'publish', '--out', path.join(temp, 'out'),
      '--deadline-monotonic', String(Date.now() / 1000 + 3600), '--maximum-bytes', '134217728'];
    const override = (name: string, value: string) => {
      const args = [...base];
      const at = args.indexOf(name);
      if (at >= 0) args[at + 1] = value; else args.push(name, value);
      return args;
    };
    expect(run(override('--sdk-input-hash', 'short')).status).toBe(1);
    expect(run(override('--maximum-bytes', String(129 * 1024 * 1024))).status).toBe(1);
    expect(run(base.slice(0, 6)).status).toBe(2);
    // --target is a required closed choice, not a free-form caller string.
    expect(run(override('--target', 'linux-riscv64')).status).toBe(2);
    expect(run(base.filter((arg, at) => arg !== '--target'
      && base[at - 1] !== '--target')).status).toBe(2);
    mkdirSync(path.join(temp, 'exists'));
    expect(run(override('--out', path.join(temp, 'exists'))).status).toBe(1);
  } finally { rmSync(temp, {recursive: true, force: true}); }
});
