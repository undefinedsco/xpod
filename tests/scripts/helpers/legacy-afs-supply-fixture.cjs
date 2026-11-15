/** Reusable builder for the complete normal-AFS original verifier fixture.
 *
 * Extracted from the portable-original test so the same REAL originals (three
 * tgz members, the closed producer/command/CLI source records, the generated
 * supply index, the real ZIP and same-run custody metadata) can be reused by
 * later chain tests without copying the setup.
 *
 * Every producer-side coordinate (runAttempt, source, head, runId, artifact
 * name/id/digest, job closure, index and CLI context) is derived from the same
 * options, so a fixture is internally consistent by construction. The consumer
 * coordinate is NOT part of the producer originals: it exists only on the
 * request top level, and only when the caller asks for a split record.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const normal = require('../../../scripts/lib/legacy-afs-supply.cjs');
const helper = require('../../../scripts/lib/root-registry-supply.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
};

/** Artifact metadata fixture for the legacy producer job.
 * Defaults reproduce the historical values used by the existing tests. */
function contextFixture(options = {}) {
  const sourceSha = options.sourceSha ?? 'a'.repeat(40);
  const runHeadSha = options.runHeadSha ?? 'b'.repeat(40);
  const runId = options.runId ?? 21;
  const runAttempt = options.runAttempt ?? 3;
  const artifactId = options.artifactId ?? 47;
  const artifactSha256 = options.artifactSha256 ?? 'c'.repeat(64);
  const jobName = options.jobName ?? 'legacy-root-normal-afs';
  const startedAt = options.startedAt ?? '2026-10-16T01:00:00Z';
  const completedAt = options.completedAt ?? '2026-10-16T01:02:00Z';
  const createdAt = options.createdAt ?? '2026-10-16T01:01:00Z';
  const sizeInBytes = options.sizeInBytes ?? 100;
  const input = { schemaVersion: 1, sourceSha, runHeadSha, runId, runAttempt, artifactId, artifactSha256 };
  const run = { id: runId, run_attempt: runAttempt, head_sha: runHeadSha, status: 'in_progress',
    event: 'pull_request', workflow_id: 9, path: '.github/workflows/legacy-root-compat.yml',
    repository: { full_name: 'undefinedsco/xpod' }, head_repository: { full_name: 'undefinedsco/xpod' } };
  const workflow = { id: 9, path: run.path };
  const artifact = { id: artifactId, name: `legacy-root-normal-afs-${sourceSha}-${runId}-${runAttempt}`,
    digest: 'sha256:' + artifactSha256, expired: false, size_in_bytes: sizeInBytes,
    workflow_run: { id: runId, head_sha: runHeadSha }, created_at: createdAt };
  const jobs = { total_count: 1, jobs: [{ name: jobName, status: 'completed', conclusion: 'success',
    run_id: runId, run_attempt: runAttempt, head_sha: runHeadSha, started_at: startedAt, completed_at: completedAt }] };
  return { input, metadata: { run, workflow, artifact }, jobs };
}

const closed = (root, originals, directory, prefix) => {
  const raw = ['stdout', 'stderr'].map(channel => {
    const name = prefix + '.' + channel + '.raw.log';
    write(path.join(originals, directory, name), 'synthetic closed output');
    return { ...helper.reference(path.join(originals, directory, name)), path: name };
  });
  return { spawnError: null, code: 0, signal: null, actualWait: true, actualClose: true,
    groupAbsent: true, rawComplete: true, rawClosed: true, rawClosedBeforeHash: true,
    pipeEOF: [true, true], raw };
};

/** Build the complete fixture under `root`. Returns every path and record that a
 * later generic-fetch / wrapper test needs. `options.runAttempt` (default 3) is
 * the PRODUCER attempt threaded through every producer-side coordinate.
 * `options.consumerAttempt` adds an explicit split request top-level record; it is
 * never written into the producer originals. */
function buildNormalSupplyFixture(root, options = {}) {
  const context = contextFixture(options);
  const sourceSha = context.input.sourceSha;
  const runAttempt = context.input.runAttempt;
  const originals = path.join(root, 'originals');
  fs.mkdirSync(originals);

  const files = normal.tools.map(file => {
    const bytes = fs.readFileSync(path.resolve(file));
    write(path.join(root, file), bytes);
    return { path: file, bytes: bytes.length, sha256: hash(bytes), matchesGit: true };
  });
  // The real manifest bytes: `verify` cross-checks this file against the checked-out
  // repository at process.cwd(), so a synthetic manifest can never verify.
  write(path.join(root, 'packages/xpod-afs/package.json'), fs.readFileSync(path.resolve('packages/xpod-afs/package.json')));
  const sourceHash = helper.reference(path.join(root, 'packages/xpod-afs/package.json')).sha256;
  const snapshot = { sourceSha, clean: true, inputSHA256: 'd'.repeat(64), files };
  for (const stage of ['before', 'after']) write(path.join(originals, 'producer/source-' + stage + '.original.json'), snapshot);

  const pack = (relative, manifest, entries = {}) => {
    const stage = fs.mkdtempSync(path.join(root, 'stage-'));
    write(path.join(stage, 'package/package.json'), manifest);
    for (const [name, body] of Object.entries(entries)) write(path.join(stage, 'package', name), body);
    const target = path.join(originals, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    execFileSync('tar', ['czf', target, '-C', stage, 'package']);
    const bytes = fs.readFileSync(target);
    return { ...helper.reference(target), integrity: 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64') };
  };

  const material = '{"fixture":"original producer materials"}';
  const cliVersion = JSON.parse(fs.readFileSync(path.resolve('packages/xpod-cli/package.json'), 'utf8')).version;
  const clientTgzVersion = JSON.parse(fs.readFileSync(path.resolve('packages/xpod-client/package.json'), 'utf8')).version;
  const cli = pack('cli/cli.tgz', { name: '@undefineds.co/xpod-cli', version: cliVersion,
    exports: { './producer-materials': './dist/producer-materials/index.json' } },
    { 'dist/producer-materials/index.json': material });
  const client = pack('cli/client.tgz', { name: '@undefineds.co/xpod-client', version: clientTgzVersion });
  const cliContext = { checkoutSha: sourceSha, workingTreeDirty: false,
    runId: String(context.input.runId), runAttempt: String(runAttempt) };
  write(path.join(originals, 'cli/result.json'), { kind: 'cli-publication-preparation-producer',
    context: cliContext, privateConsumerArtifactsReused: false, embeddedClientIdentityVerified: true,
    published: false, releaseQualified: false,
    products: { cli: { version: cliVersion, archive: { ...cli, path: 'cli.tgz' } },
      client: { version: clientTgzVersion, archive: { ...client, path: 'client.tgz' } } } });
  write(path.join(originals, 'cli/source-inputs.json'), { context: cliContext, files: [files[0]] });

  const cliCommands = Array.from({ length: 10 }, (_, index) => {
    const label = 'phase-' + String(index).padStart(3, '0');
    const outcome = closed(root, originals, 'cli', label);
    const member = label + '.receipt.json';
    write(path.join(originals, 'cli', member), outcome);
    return { phase: 'synthetic CLI phase ' + index,
      receipt: { path: member, sha256: helper.reference(path.join(originals, 'cli', member)).sha256 }, ...outcome };
  });
  write(path.join(originals, 'cli/cleanup.json'), { schemaVersion: 1,
    kind: 'cli-publication-owned-command-cleanup', success: true, sourceAbsent: true,
    commandOutcomes: cliCommands });

  // Real workspace versions and the real inter-package range, so the packed manifest
  // agrees with the workspace authority a retained/produce chain resolves against.
  const afsVersion = JSON.parse(fs.readFileSync(path.resolve('packages/xpod-afs/package.json'), 'utf8')).version;
  const clientVersion = JSON.parse(fs.readFileSync(path.resolve('packages/xpod-client/package.json'), 'utf8')).version;
  const manifest = { name: '@undefineds.co/xpod-afs', version: afsVersion, private: false,
    // The verifier requires the packed client version to be resolvable from the AFS
    // manifest, so the manifest states the concrete client version.
    dependencies: { '@undefineds.co/xpod-client': clientVersion } };
  const afs = pack('afs/xpod-afs.tgz', manifest);
  const parsed = helper.artifact({ ...afs, name: manifest.name, version: manifest.version });
  const publication = { kind: 'afs-js-normal-publication', name: manifest.name, version: manifest.version,
    archive: { ...afs, path: '/posix/native/afs/xpod-afs.tgz' },
    stage: { manifest, sourceManifestSHA256: sourceHash,
      inventory: parsed.entries.filter(e => e.type === 'file').map(e => ({ path: e.path.slice(8), bytes: e.content.length, sha256: hash(e.content), mode: e.mode })) },
    producerBinding: { indexSHA256: hash(Buffer.from(material)) },
    command: closed(root, originals, 'afs', 'normal-pack') };
  write(path.join(originals, 'afs/publication.original.json'), publication);
  publication.command.command = 'bun';
  publication.command.cwd = '/posix/native/afs/package';
  publication.command.args = ['pm', 'pack', '--ignore-scripts', '--filename', publication.archive.path];
  write(path.join(originals, 'afs/publication.original.json'), publication);

  const phases = [
    { ...closed(root, originals, 'producer', 'normal-cli'), command: '/posix/node', cwd: '/posix/source',
      args: ['/posix/source/scripts/check-cli-publication.cjs', '--evidence', '/posix/source/.test-data/afs-js-archive-ci-producer'] },
    { ...closed(root, originals, 'producer', 'normal-afs'), command: 'bun', cwd: '/posix/source',
      args: ['/posix/source/packages/xpod-afs/scripts/build-client-publication.ts', '--cli-package', '/posix/cli', '--client-package', '/posix/client', '--output', '/posix/native/afs'] }];
  const nodeRuntime = { ...closed(root, originals, 'producer', 'normal-node'), command: 'node', cwd: '/posix/source', args: ['-e', normal.NODE_PROBE] };
  write(path.join(originals, 'producer', nodeRuntime.raw[0].path), { execPath: '/posix/node', node: '22.21.1', bun: null });
  nodeRuntime.raw[0] = { ...helper.reference(path.join(originals, 'producer', nodeRuntime.raw[0].path)), path: nodeRuntime.raw[0].path };

  const index = { kind: 'legacy-root-original-afs-supply', nodeRuntime, nativeSourceRoot: '/posix/source',
    ...context.input, sourceSha, runId: String(context.input.runId), runAttempt, runHeadSha: context.input.runHeadSha,
    sourceBefore: 'producer/source-before.original.json', sourceAfter: 'producer/source-after.original.json',
    phases, producerTools: normal.tools.map(file => ({ file, ...helper.reference(path.join(root, file)) })),
    // Inventory is computed while the index file does not yet exist, exactly as the
    // producer does it; the index itself is the only member outside the inventory.
    members: (() => { const rows = normal.inventory(originals); return rows; })(), releaseQualified: false };
  const indexFile = path.join(originals, 'supply-index.original.json');
  write(indexFile, index);
  const verified = normal.verify(originals, context.input, root);
  if (verified.artifacts.length !== 3) throw new Error('fixture must expose exactly three normal artifacts');

  const custody = path.join(root, 'custody');
  fs.mkdirSync(custody);
  const archive = path.join(custody, 'artifact.zip');
  const zipped = spawnSync('python3', ['-c', "import pathlib,sys,zipfile\nwith zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED) as z:\n for p in pathlib.Path(sys.argv[1]).rglob('*'):\n  if p.is_file(): z.write(p,p.relative_to(sys.argv[1]).as_posix())", originals, archive], { encoding: 'utf8' });
  if (zipped.status !== 0) throw new Error('fixture ZIP failed: ' + zipped.stderr);
  const archiveRef = helper.reference(archive, 16 * 1024 ** 2);
  const f = contextFixture(options);
  f.input.artifactSha256 = archiveRef.sha256;
  f.metadata.artifact.digest = 'sha256:' + archiveRef.sha256;
  f.metadata.artifact.size_in_bytes = archiveRef.bytes;
  const inspected = spawnSync('python3', [path.resolve('scripts/lib/inspect-product-artifact.py'), archive, archiveRef.sha256,
    String(16 * 1024 ** 2), String(40 * 1024 ** 2), '4096'], { encoding: 'utf8' });
  if (inspected.status !== 0) throw new Error('fixture inventory failed: ' + inspected.stderr);
  const originalsBinding = {};
  for (const name of ['run', 'workflow', 'artifact']) {
    const member = 'metadata/' + name + '.original.json';
    write(path.join(custody, member), f.metadata[name]);
    originalsBinding[name] = { ...helper.reference(path.join(custody, member)), path: member };
  }
  write(path.join(custody, 'metadata.json'), f.metadata);
  write(path.join(custody, 'metadata/jobs.original.json'), f.jobs);
  const custodyReceipt = { kind: 'legacy-root-same-run-acquisition', status: 'blocked', ...f.input,
    expectedSourceSha: sourceSha, archive: { ...archiveRef, path: 'artifact.zip' },
    inventory: JSON.parse(inspected.stdout),
    metadata: { originals: originalsBinding, projection: { ...helper.reference(path.join(custody, 'metadata.json')), path: 'metadata.json' } },
    producerJob: { ...helper.reference(path.join(custody, 'metadata/jobs.original.json')), path: 'metadata/jobs.original.json' } };
  write(path.join(custody, 'receipt.json'), custodyReceipt);
  const request = { input: f.input, custodyReceipt: helper.reference(path.join(custody, 'receipt.json')), index: helper.reference(indexFile) };
  if (options.consumerAttempt !== undefined) {
    // Explicit split record: producer coordinates stay untouched in the originals.
    request.producerAttempt = runAttempt;
    request.consumerAttempt = options.consumerAttempt;
  }
  write(path.join(root, 'request.original.json'), request);

  return { root, context: context.input, producerContext: { sourceSha, runId: String(context.input.runId), runAttempt },
    index, indexFile, metadata: f.metadata, jobs: f.jobs, input: f.input,
    originals, custody, archive, archiveBytes: archiveRef.bytes, archiveRef,
    request, requestFile: path.join(root, 'request.original.json'),
    artifacts: verified.artifacts };
}

module.exports = { buildNormalSupplyFixture, contextFixture };
