/** Formal positive chain for the legacy-root normal AFS producer/consumer split.
 *
 * Drives the REAL production entry points end to end with a synthetic GitHub
 * transport (no network): generic acquireLegacyRootSupply -> legacy wrapper
 * acquire(input, output, {fetch}) which projects the ZIP and writes the request ->
 * normal.verifyCustody -> root-registry readRootSupply -> verifyRetainedSupply.
 *
 * Producer coordinates are attempt 1; the consuming lane runs attempt 2. The
 * retained originals must stay bound to attempt 1 while the request records both.
 */
import {afterEach, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {acquire} from '../../scripts/legacy-root-afs-supply';
import {acquireLegacyRootSupply} from '../../scripts/acquire-independent-product-input';

const require = createRequire(import.meta.url);
const normal = require('../../scripts/lib/legacy-afs-supply.cjs');
const rootSupply = require('../../scripts/lib/root-registry-supply.cjs');

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const {buildNormalSupplyFixture} = require('../scripts/helpers/legacy-afs-supply-fixture.cjs') as {
  buildNormalSupplyFixture: (root: string, options?: Record<string, unknown>) => any;
};

/** Synthetic GitHub transport serving the producer-attempt-1 metadata endpoints.
 * Records every request so the test can prove which attempt path was read. */
/** Install the npm->bun pack shim on PATH; returns a restore function. */
function installNpmShim(root: string) {
  const bin = path.join(root, 'bin');
  mkdirSync(bin, {recursive: true});
  const packer = path.join(root, 'npm-pack-shim.cjs');
  writeFileSync(packer, [
    "const cp = require('node:child_process');",
    "const fs = require('node:fs');",
    "const p = require('node:path');",
    "const args = process.argv.slice(2);",
    "const dir = args[args.indexOf('--pack-destination') + 1];",
    "const before = new Set(fs.readdirSync(dir));",
    "const r = cp.spawnSync('bun', ['pm', 'pack', ...args], {encoding: 'utf8'});",
    "if (r.status !== 0) { process.stderr.write(r.stderr ?? ''); process.exit(r.status ?? 1); }",
    "const produced = fs.readdirSync(process.cwd()).filter(f => f.endsWith('.tgz') && !before.has(f));",
    "if (produced.length !== 1) { process.stderr.write('expected one tarball\\n'); process.exit(1); }",
    "for (const f of produced) fs.renameSync(p.join(process.cwd(), f), p.join(dir, f));",
    "process.stdout.write(JSON.stringify([{filename: produced[0]}]));",
  ].join('\n') + '\n');
  writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\nexec bun ${JSON.stringify(packer)} "$@"\n`, {mode: 0o755});
  const savedPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + (savedPath ?? '');
  return () => { if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; };
}

/** Build the real registry-supply retained layout from produced artifacts. */
function buildRetainedLayout({root, destination, receiptPath, rootArtifact}: any) {
// The actual retained consumer readback: build the registry-supply retained
// layout from the REAL readRootSupply artifacts and the produceRootSupply receipt,
// then let verifyRetainedSupply (:354) receive the consumer receipt attempt 2 and
// open the producer-1 originals.
const retainedDir = path.join(root, 'retained');
const base = path.join(retainedDir, 'registry-supply');
mkdirSync(path.join(base, 'archives'), {recursive: true});
writeFileSync(path.join(base, 'supply.original.json'), readFileSync(receiptPath));
cpSync(path.join(destination, 'normal-afs'), path.join(base, 'normal-afs'), {recursive: true});
const sha1 = (bytes: Buffer) => createHash('sha1').update(bytes).digest('hex');
const metadataFor = (name: string, version: string, manifest: any, bytes: Buffer, integrity: string) =>
  ({name, versions: {[version]: {...manifest, dist: {integrity, shasum: sha1(bytes)}}}});
const receiptArtifacts: any[] = JSON.parse(readFileSync(receiptPath, 'utf8')).artifacts;
const publications: any[] = [];
for (const [index, row] of receiptArtifacts.entries()) {
  const bytes = readFileSync(row.path);
  writeFileSync(path.join(base, 'archives', row.file), bytes);
  const file = 'publication-' + index + '.original.json';
  writeFileSync(path.join(base, file),
    JSON.stringify(metadataFor(row.name, row.version, rootSupply.artifact({...row, path: row.path}).manifest, bytes, row.integrity)));
  publications.push({name: row.name, version: row.version, file,
    ...rootSupply.reference(path.join(base, file))});
}
const rootFile = path.join(retainedDir, 'root.tgz');
writeFileSync(rootFile, rootArtifact.bytes);
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
const rootPublication = {...rootSupply.reference(rootFile), path: 'root.tgz',
  name: rootArtifact.manifest.name, version: rootArtifact.manifest.version,
  integrity: rootArtifact.integrity};
writeFileSync(path.join(base, 'publication.original.json'), JSON.stringify({
  source: rootSupply.reference(path.join(base, 'supply.original.json')),
  required: receipt.required,
  root: metadataFor(rootArtifact.manifest.name, rootArtifact.manifest.version,
    rootArtifact.manifest, rootArtifact.bytes, rootArtifact.integrity),
  publications,
}));
const retainedPublication = {...rootSupply.reference(path.join(base, 'publication.original.json')),
  path: 'registry-supply/publication.original.json'};

  return {retainedDir, base, rootFile, rootPublication, publicationRef: retainedPublication, publications, receipt};
}

function transportFor(built: any, overrides: Record<string, any> = {}) {
  const requests: string[] = [];
  const run = {id: built.context.runId, run_attempt: built.context.runAttempt, head_sha: built.context.runHeadSha,
    status: 'completed', conclusion: 'success', event: 'pull_request', workflow_id: 9,
    path: '.github/workflows/legacy-root-compat.yml', run_started_at: '2026-10-16T00:59:00Z',
    updated_at: '2026-10-16T01:03:00Z', repository: {full_name: 'undefinedsco/xpod'},
    head_repository: {full_name: 'undefinedsco/xpod'}};
  const workflow = {id: 9, path: run.path};
  const artifact = {...built.metadata.artifact};
  const jobs = structuredClone(built.jobs);
  const responses: Record<string, any> = {
    run: overrides.run ?? run, workflow: overrides.workflow ?? workflow,
    artifact: overrides.artifact ?? artifact, jobs: overrides.jobs ?? jobs,
  };
  const zip = readFileSync(built.archive);
  const syntheticFetch: typeof fetch = (async (url: string | URL | Request) => {
    const address = String(url);
    requests.push(address);
    if (address.includes(`/attempts/${built.context.runAttempt}/jobs`)) return Response.json(responses.jobs);
    if (address.endsWith(`/attempts/${built.context.runAttempt}`)) return Response.json(responses.run);
    if (address.endsWith(`/workflows/${responses.run.workflow_id}`)) return Response.json(responses.workflow);
    if (address.endsWith(`/artifacts/${built.input.artifactId}`)) return Response.json(responses.artifact);
    if (address.endsWith(`/artifacts/${built.input.artifactId}/zip`)) return new Response(zip);
    throw Error('unexpected endpoint ' + address);
  }) as typeof fetch;
  return {fetch: syntheticFetch, requests};
}

test('producer attempt 1 originals reach the consumer as REAL artifacts', async () => {
  mkdirSync('.test-data/legacy-afs-producer-attempt', {recursive: true});
  const root = mkdtempSync(path.resolve('.test-data/legacy-afs-producer-attempt/chain-'));
  roots.push(root);
  // Real originals, producer attempt 1, explicit split request recording consumer 2.
  const built = buildNormalSupplyFixture(root, {runAttempt: 1, consumerAttempt: 2});
  const {fetch, requests} = transportFor(built);

  const saved = {...process.env};
  try {
    Object.assign(process.env, {GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'undefinedsco/xpod',
      GITHUB_RUN_ID: String(built.context.runId), GITHUB_RUN_ATTEMPT: '2',
      SUPPLY_ARTIFACT_ID: String(built.input.artifactId),
      SOURCE_SHA: built.context.sourceSha, RUN_HEAD_SHA: built.context.runHeadSha});
    // Snapshot the producer's original index bytes BEFORE acquisition so the
    // comparison afterwards is meaningful (previously both sides were the same file).
    const originalIndexBytes = readFileSync(built.indexFile);
    const output = path.join(root, 'acquired');
    await acquire(built.input, output, {fetch});

    // The historical PRODUCER attempt path was read, never the consumer's.
    expect(requests.some(url => url.includes('/attempts/1'))).toBe(true);
    expect(requests.some(url => url.includes('/attempts/2/jobs'))).toBe(false);

    // The request records both coordinates; producer originals are untouched.
    const request = JSON.parse(readFileSync(path.join(output, 'request.original.json'), 'utf8'));
    expect(request.producerAttempt).toBe(1);
    expect(request.consumerAttempt).toBe(2);
    expect(request.input.runAttempt).toBe(1);
    // The acquired copy must be byte-identical to the pre-acquire snapshot, and the
    // fixture's own index must not have been mutated by the acquisition.
    expect(readFileSync(path.join(output, 'originals', 'supply-index.original.json')).equals(originalIndexBytes))
      .toBe(true);
    expect(readFileSync(built.indexFile).equals(originalIndexBytes)).toBe(true);

    // The consumer's own build input is attempt 2 while custody stays on 1.
    const verified = normal.verifyCustody(output, {...built.context, runAttempt: 2}, root);
    expect(verified.artifacts.length).toBe(3);
    expect(verified.index.runAttempt).toBe(1);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('retained normal supply keeps producer 1 for a consumer lane on attempt 2', async () => {
  // Drives the REAL retained readback: produceRootSupply -> readRootSupply ->
  // verifyRetainedSupply over a real clean Git root with the acquired normal
  // originals supplied through XPOD_LEGACY_AFS_SUPPLY.
  mkdirSync('.test-data/legacy-afs-producer-attempt', {recursive: true});
  const root = mkdtempSync(path.resolve('.test-data/legacy-afs-producer-attempt/retained-'));
  roots.push(root);
  const saved = {...process.env};
  const oldCache = process.env.npm_config_cache;
  let restorePath: (() => void) | undefined;
  try {
    // The synthetic root is created first so the fixture can use its REAL commit SHA:
    // custody binds the acquired originals to the same source as the retained build.
    const source = path.join(root, 'source');
    mkdirSync(source, {recursive: true});
    const git = (...args: string[]) => spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args],
      {cwd: source, encoding: 'utf8'}).stdout.trim();
    writeFileSync(path.join(source, '.gitignore'), '.test-data/\n');
    writeFileSync(path.join(source, 'package.json'), JSON.stringify({name: '@undefineds.co/xpod', version: '1.0.0',
      workspaces: ['packages/*'], dependencies: {'@fixture/first': 'workspace:*'}}));
    for (const name of ['first', 'leaf']) {
      mkdirSync(path.join(source, 'packages', name), {recursive: true});
      writeFileSync(path.join(source, 'packages', name, 'package.json'), JSON.stringify({name: '@fixture/' + name,
        version: '1.0.0', files: ['index.js'], main: 'index.js',
        ...(name === 'first' ? {dependencies: {'@fixture/leaf': 'workspace:*'}} : {})}));
      writeFileSync(path.join(source, 'packages', name, 'index.js'), 'module.exports = ' + JSON.stringify(name) + ';\n');
    }
    // The retained originals verify every producer tool against this root, so the
    // synthetic source must carry BOTH tool sets (normal's 16 and root's 4).
    for (const name of new Set([...normal.tools, ...rootSupply.ROOT_SUPPLY_TOOLS])) {
      mkdirSync(path.dirname(path.join(source, name)), {recursive: true});
      writeFileSync(path.join(source, name), readFileSync(path.resolve(name)));
    }
    // verifyCustody resolves the ZIP parser relative to the supplied root, so the
    // synthetic source must carry it too (the real producer root has it).
    mkdirSync(path.join(source, 'scripts/lib'), {recursive: true});
    for (const name of ['inspect-product-artifact.py', 'module-artifact-limits.json']) {
      writeFileSync(path.join(source, 'scripts/lib', name), readFileSync(path.resolve('scripts/lib', name)));
    }
    // The original verifier anchors several workspace manifests at this root; copy the
    // whole manifests-only tree rather than chasing them one by one.
    for (const pkg of readdirSync(path.resolve('packages'))) {
      const manifest = path.resolve('packages', pkg, 'package.json');
      if (!existsSync(manifest)) continue;
      mkdirSync(path.join(source, 'packages', pkg), {recursive: true});
      writeFileSync(path.join(source, 'packages', pkg, 'package.json'), readFileSync(manifest));
    }
    git('init', '-q'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
    const sha = git('rev-parse', 'HEAD');

    const built = buildNormalSupplyFixture(root, {runAttempt: 1, consumerAttempt: 2, sourceSha: sha});
    // Acquire the real originals through the wrapper with a synthetic transport.
    const {fetch} = transportFor(built);
    Object.assign(process.env, {GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'undefinedsco/xpod',
      GITHUB_RUN_ID: String(built.context.runId), GITHUB_RUN_ATTEMPT: '2'});
    const acquired = path.join(root, 'acquired');
    await acquire(built.input, acquired, {fetch});

    // (root, tools and commit were created above so the fixture shares its SHA)
    const evidence = path.join(source, '.test-data/evidence');
    mkdirSync(evidence, {recursive: true});
    process.env.npm_config_cache = path.join(source, '.test-data/npm-cache');
    const bytes = Buffer.from('synthetic root bytes, not an actual Xpod producer');
    const original = path.join(evidence, 'root.tgz');
    writeFileSync(original, bytes);
    for (const kind of ['stdout', 'stderr']) writeFileSync(path.join(evidence, 'build.' + kind), 'synthetic parent build output');
    const input = {kind: 'legacy-root-normal-build-input', sourceSha: sha,
      runId: String(built.context.runId), runAttempt: 2, sourceBeforeStatus: '',
      build: {command: ['bun', 'run', 'build'], actualExit: 0, signal: null, spawnError: null,
        actualWaitCompleted: true, rawLogsClosed: true,
        stdout: rootSupply.reference(path.join(evidence, 'build.stdout')),
        stderr: rootSupply.reference(path.join(evidence, 'build.stderr'))},
      archive: {...rootSupply.reference(original), integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64')}};
    const inputFile = path.join(evidence, 'input.json');
    writeFileSync(inputFile, JSON.stringify(input));
    // The root manifest must declare the normal distributions it depends on, or the
    // producer rejects them as being outside the private graph.
    const rootArtifact = {bytes, integrity: input.archive.integrity,
      manifest: {name: '@undefineds.co/xpod', version: '1.0.0',
        // Versions must agree with the workspace manifests the producer packed.
        dependencies: {'@fixture/first': '1.0.0',
          '@undefineds.co/xpod-afs': JSON.parse(readFileSync(path.resolve('packages/xpod-afs/package.json'), 'utf8')).version,
          '@undefineds.co/xpod-cli': JSON.parse(readFileSync(path.resolve('packages/xpod-cli/package.json'), 'utf8')).version,
          '@undefineds.co/xpod-client': JSON.parse(readFileSync(path.resolve('packages/xpod-client/package.json'), 'utf8')).version}}};

    // The retained normal supply is the producer-1 originals the consumer acquired.
    process.env.XPOD_LEGACY_AFS_SUPPLY = acquired;
    // This host has no npm: shim `npm pack` onto Bun's real packer.
    restorePath = installNpmShim(root);
    const destination = path.join(evidence, 'registry-supply');
    const produced = await rootSupply.produceRootSupply({root: source, inputFile, rootArtifact, destination,
      cache: path.join(source, '.test-data/cache')});
    const requestFile = path.join(evidence, 'request.json');
    writeFileSync(requestFile, JSON.stringify({receipt: rootSupply.reference(produced.receipt.path)}));

    // The consumer's own lane is attempt 2, but the retained originals are attempt 1.
    const read = rootSupply.readRootSupply(requestFile, source, rootArtifact);
    // The declared graph resolves to the leaf plus the three normal distributions
    // (xpod-cli, xpod-client, xpod-afs); the exact set is asserted by name below.
    expect(read.artifacts.length).toBe(5);
    expect(read.artifacts.map((row: any) => row.manifest.name).sort())
      .toEqual(['@fixture/first', '@fixture/leaf', '@undefineds.co/xpod-afs',
        '@undefineds.co/xpod-cli', '@undefineds.co/xpod-client']);
    const receipt = JSON.parse(readFileSync(produced.receipt.path, 'utf8'));
    expect(receipt.runAttempt).toBe(2);      // consumer build coordinate
    expect(receipt.normalSupply.member).toBe('normal-afs');
    // copyTree reproduces the wrapper output layout, so the index sits under originals/.
    const retainedIndex = JSON.parse(readFileSync(
      path.join(destination, 'normal-afs', 'originals', 'supply-index.original.json'), 'utf8'));
    expect(retainedIndex.runAttempt).toBe(1); // producer originals untouched

    // The retained NORMAL originals remain bound to producer 1 even though the
    // consumer lane and its build receipt are attempt 2: re-verify them directly.
    const retained = normal.verifyCustody(path.join(destination, 'normal-afs'),
      {...built.context, runAttempt: 2}, source, {retained: true});
    expect(retained.artifacts.map((row: any) => row.manifest.name).sort())
      .toEqual(['@undefineds.co/xpod-afs', '@undefineds.co/xpod-cli', '@undefineds.co/xpod-client']);
    expect(retained.index.runAttempt).toBe(1);
    const {retainedDir, base, rootPublication, publicationRef, publications} =
      buildRetainedLayout({root, destination, receiptPath: produced.receipt.path, rootArtifact});
    // The consumer receipt is attempt 2; the originals it opens are producer 1.
    const finalRetained = rootSupply.verifyRetainedSupply(retainedDir, publicationRef, sha, rootPublication);
    expect(finalRetained.originalArchives).toBe(5);
    expect(finalRetained.required).toEqual(read.required);
    expect(finalRetained.sourceSha).toBe(sha);
    // The originals the retained consumer opened are still the producer's.
    expect(JSON.parse(readFileSync(path.join(base, 'normal-afs', 'originals',
      'supply-index.original.json'), 'utf8')).runAttempt).toBe(1);
    expect(receipt.runAttempt).toBe(2);
    expect(publications.length).toBe(5);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    if (oldCache === undefined) delete process.env.npm_config_cache; else process.env.npm_config_cache = oldCache;
    restorePath?.();
  }
});

test('acquisition rejects every forged producer coordinate through the real wrapper', async () => {
  // Table-driven, all through the REAL acquireLegacyRootSupply/wrapper path with the
  // same synthetic transport. Each case mutates ONE real metadata field and asserts
  // the exact terminal rejection, never a missing fixture or a network error.
  mkdirSync('.test-data/legacy-afs-producer-attempt', {recursive: true});
  const root = mkdtempSync(path.resolve('.test-data/legacy-afs-producer-attempt/negative-'));
  roots.push(root);
  const built = buildNormalSupplyFixture(root, {runAttempt: 1, consumerAttempt: 2});
  const saved = {...process.env};
  try {
    Object.assign(process.env, {GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'undefinedsco/xpod',
      GITHUB_RUN_ID: String(built.context.runId), GITHUB_RUN_ATTEMPT: '2'});
    const cases: Array<[string, Record<string, any>, RegExp]> = [
      ['wrong source', {run: {...structuredClone(built.metadata.run), head_sha: 'f'.repeat(40)}},
        /untrusted producer run|head/i],
      ['wrong run id', {run: {...structuredClone(built.metadata.run), id: 999}},
        /run identity|untrusted producer run/i],
      ['wrong artifact id', {artifact: {...structuredClone(built.metadata.artifact), id: 1}},
        /artifact identity|digest|attempt window/i],
      ['wrong artifact digest', {artifact: {...structuredClone(built.metadata.artifact),
        digest: 'sha256:' + '0'.repeat(64)}}, /artifact identity|digest|attempt window/i],
      ['wrong artifact name', {artifact: {...structuredClone(built.metadata.artifact),
        name: built.metadata.artifact.name.replace(/-1$/, '-2')}}, /artifact identity|digest|attempt window/i],
      ['expired artifact', {artifact: {...structuredClone(built.metadata.artifact), expired: true}},
        /artifact identity|digest|attempt window/i],
      ['artifact before window', {artifact: {...structuredClone(built.metadata.artifact),
        created_at: '2026-10-15T00:00:00Z'}}, /artifact identity|digest|attempt window/i],
      ['artifact after window', {artifact: {...structuredClone(built.metadata.artifact),
        created_at: '2026-10-17T00:00:00Z'}}, /artifact identity|digest|attempt window/i],
      ['job failed', {jobs: {total_count: 1, jobs: [{...structuredClone(built.jobs.jobs[0]),
        conclusion: 'failure'}]}}, /producer|failure|closure/i],
      ['job attempt mismatch', {jobs: {total_count: 1, jobs: [{...structuredClone(built.jobs.jobs[0]),
        run_attempt: 2}]}}, /producer job identity mismatch|attempt/i],
      ['job missing', {jobs: {total_count: 0, jobs: []}}, /producer job is not unique|job/i],
    ];
    for (const [label, overrides, expected] of cases) {
      const {fetch} = transportFor(built, overrides);
      const output = path.join(root, 'neg-' + label.replace(/\W+/g, '-'));
      const error = await acquire(built.input, output, {fetch}).then(() => undefined, (v: Error) => v);
      expect(error).toBeDefined();
      const message = String((error as Error).message);
      expect(expected.test(message)).toBe(true);
      // Never a missing-fixture / transport artefact: the reason must be a real guard,
      // either the acquirer's own `Artifact acquisition:` prefix or a closure assert.
      expect(/^(?:Artifact acquisition: )?[A-Za-z]/.test(message)).toBe(true);
      expect(/ENOENT|unexpected endpoint|GitHub metadata request failed/.test(message)).toBe(false);
      // A rejected coordinate must not leave a verified output behind.
      expect(existsSync(path.join(output, 'request.original.json'))).toBe(false);
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

/** Produce the real retained layout once, for tamper cases. */
async function retainedFixture(root: string) {
  // The synthetic root comes first so the fixture can use its real commit SHA.
  const source = path.join(root, 'source');
  mkdirSync(source, {recursive: true});
  const git = (...args: string[]) => spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args],
    {cwd: source, encoding: 'utf8'}).stdout.trim();
  writeFileSync(path.join(source, '.gitignore'), '.test-data/\n');
  for (const name of new Set([...normal.tools, ...rootSupply.ROOT_SUPPLY_TOOLS])) {
    mkdirSync(path.dirname(path.join(source, name)), {recursive: true});
    writeFileSync(path.join(source, name), readFileSync(path.resolve(name)));
  }
  for (const name of ['inspect-product-artifact.py', 'module-artifact-limits.json']) {
    mkdirSync(path.join(source, 'scripts/lib'), {recursive: true});
    writeFileSync(path.join(source, 'scripts/lib', name), readFileSync(path.resolve('scripts/lib', name)));
  }
  for (const pkg of readdirSync(path.resolve('packages'))) {
    const manifest = path.resolve('packages', pkg, 'package.json');
    if (!existsSync(manifest)) continue;
    mkdirSync(path.join(source, 'packages', pkg), {recursive: true});
    writeFileSync(path.join(source, 'packages', pkg, 'package.json'), readFileSync(manifest));
  }
  for (const name of ['first', 'leaf']) {
    mkdirSync(path.join(source, 'packages', name), {recursive: true});
    writeFileSync(path.join(source, 'packages', name, 'package.json'), JSON.stringify({name: '@fixture/' + name,
      version: '1.0.0', files: ['index.js'], main: 'index.js',
      ...(name === 'first' ? {dependencies: {'@fixture/leaf': 'workspace:*'}} : {})}));
    writeFileSync(path.join(source, 'packages', name, 'index.js'), 'module.exports = ' + JSON.stringify(name) + ';\n');
  }
  const versions: Record<string, string> = {};
  for (const pkg of ['xpod-afs', 'xpod-cli', 'xpod-client']) {
    versions[pkg] = JSON.parse(readFileSync(path.resolve('packages', pkg, 'package.json'), 'utf8')).version;
  }
  writeFileSync(path.join(source, 'package.json'), JSON.stringify({name: '@undefineds.co/xpod', version: '1.0.0',
    workspaces: ['packages/*'], dependencies: {'@fixture/first': 'workspace:*'}}));
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  const built = buildNormalSupplyFixture(root, {runAttempt: 1, consumerAttempt: 2, sourceSha: sha});
  const {fetch} = transportFor(built);
  Object.assign(process.env, {GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'undefinedsco/xpod',
    GITHUB_RUN_ID: String(built.context.runId), GITHUB_RUN_ATTEMPT: '2'});
  const acquired = path.join(root, 'acquired');
  await acquire(built.input, acquired, {fetch});
  const evidence = path.join(source, '.test-data/evidence');
  mkdirSync(evidence, {recursive: true});
  const bytes = Buffer.from('synthetic root bytes, not an actual Xpod producer');
  const original = path.join(evidence, 'root.tgz');
  writeFileSync(original, bytes);
  for (const kind of ['stdout', 'stderr']) writeFileSync(path.join(evidence, 'build.' + kind), 'synthetic parent build output');
  const input = {kind: 'legacy-root-normal-build-input', sourceSha: sha,
    runId: String(built.context.runId), runAttempt: 2, sourceBeforeStatus: '',
    build: {command: ['bun', 'run', 'build'], actualExit: 0, signal: null, spawnError: null,
      actualWaitCompleted: true, rawLogsClosed: true,
      stdout: rootSupply.reference(path.join(evidence, 'build.stdout')),
      stderr: rootSupply.reference(path.join(evidence, 'build.stderr'))},
    archive: {...rootSupply.reference(original), integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64')}};
  const inputFile = path.join(evidence, 'input.json');
  writeFileSync(inputFile, JSON.stringify(input));
  const rootArtifact = {bytes, integrity: input.archive.integrity,
    manifest: {name: '@undefineds.co/xpod', version: '1.0.0',
      dependencies: {'@fixture/first': '1.0.0', '@undefineds.co/xpod-afs': versions['xpod-afs'],
        '@undefineds.co/xpod-cli': versions['xpod-cli'], '@undefineds.co/xpod-client': versions['xpod-client']}}};
  process.env.XPOD_LEGACY_AFS_SUPPLY = acquired;
  const destination = path.join(evidence, 'registry-supply');
  const produced = await rootSupply.produceRootSupply({root: source, inputFile, rootArtifact, destination,
    cache: path.join(source, '.test-data/cache')});
  const layout = buildRetainedLayout({root, destination, receiptPath: produced.receipt.path, rootArtifact});
  return {built, source, sha, rootArtifact, produced, layout};
}

test('retained readback rejects tampered archives and publish metadata', async () => {
  // Uses the SAME real retained layout as the positive case, one tamper at a time.
  mkdirSync('.test-data/legacy-afs-producer-attempt', {recursive: true});
  const root = mkdtempSync(path.resolve('.test-data/legacy-afs-producer-attempt/retained-tamper-'));
  roots.push(root);
  const saved = {...process.env};
  const oldCache = process.env.npm_config_cache;
  let restorePath: (() => void) | undefined;
  try {
    restorePath = installNpmShim(root);
    const f = await retainedFixture(root);
    const {layout, sha, rootArtifact} = f;
    const base = layout.base;
    const goodPublication = readFileSync(path.join(base, 'publication.original.json'));
    const supplyFile = path.join(base, 'supply.original.json');
    const goodSupply = readFileSync(supplyFile);
    const archive = layout.receipt.artifacts[0];
    const archiveFile = path.join(base, 'archives', archive.file);
    const goodArchive = readFileSync(archiveFile);
    const call = () => rootSupply.verifyRetainedSupply(layout.retainedDir, layout.publicationRef, sha, layout.rootPublication);

    // Baseline: the untouched retained layout verifies.
    expect(call().originalArchives).toBe(5);

    // 1. Changed archive bytes (real file, hash no longer matches its reference).
    writeFileSync(archiveFile, Buffer.concat([goodArchive, Buffer.from('x')]));
    expect(() => call()).toThrow();
    writeFileSync(archiveFile, goodArchive);

    // 2. Changed publication metadata (integrity no longer derived from the bytes).
    const tampered = JSON.parse(goodPublication.toString('utf8'));
    tampered.required = [];
    writeFileSync(path.join(base, 'publication.original.json'), JSON.stringify(tampered));
    expect(() => call()).toThrow();
    writeFileSync(path.join(base, 'publication.original.json'), goodPublication);

    // 3. Missing archive file (real deletion, not a fixture gap).
    rmSync(archiveFile);
    expect(() => call()).toThrow();
    writeFileSync(archiveFile, goodArchive);

    // 4. Supply receipt source changed away from the requested source SHA.
    const supply = JSON.parse(goodSupply.toString('utf8'));
    supply.sourceSha = '0'.repeat(40);
    writeFileSync(supplyFile, JSON.stringify(supply));
    expect(() => call()).toThrow(/source mismatch|Supply reference mismatch|reference mismatch/i);
    writeFileSync(supplyFile, goodSupply);

    // 5. Root identity changed.
    const wrongRoot = {...layout.rootPublication, name: '@undefineds.co/other'};
    expect(() => rootSupply.verifyRetainedSupply(layout.retainedDir, layout.publicationRef, sha, wrongRoot))
      .toThrow();
    // Restored layout verifies again.
    expect(call().originalArchives).toBe(5);
    expect(rootArtifact.manifest.name).toBe('@undefineds.co/xpod');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    if (oldCache === undefined) delete process.env.npm_config_cache; else process.env.npm_config_cache = oldCache;
    restorePath?.();
  }
});
