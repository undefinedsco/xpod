#!/usr/bin/env node
'use strict';
// Actual isolated workspace producer. No publication or private consumer-manifest rewrite.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { copyCliBuildInputs } = require('./cli-build-inputs.cjs');
const { runPublicationCommand } = require('./lib/afs-publication-command.cjs');
const { inspectTarballBuffer, sha512Integrity } = require('./workspace-package-payload.cjs');
const TOOLS = ['scripts/prepare-cli-publication.ts', 'scripts/independent-release-plan.ts', 'scripts/workspace-package-payload.cjs', 'scripts/lib/afs-publication-command.cjs', 'scripts/lib/module-source-materials.py', 'scripts/lib/module-artifact-limits.json'];
const PATCHES = ['patch-jose.js', 'patch-inrupt-authn-refresh.js', 'patch-inrupt-authn-transport.js', 'patch-inrupt-authn-operation-cleanup.js'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash = file => {
  const digest = crypto.createHash('sha256'), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), block = Buffer.alloc(65536);
  try { for (let count; (count = fs.readSync(fd, block, 0, block.length, null)) > 0;) digest.update(block.subarray(0, count)); }
  finally { fs.closeSync(fd); }
  return digest.digest('hex');
};
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function directChildOutcome(result) {
  return { exitCode: result.status ?? null, signal: result.signal ?? null,
    error: result.error ? { code: result.error.code ?? null, message: result.error.message } : null,
    directChildWaited: Number.isInteger(result.status) || (typeof result.signal === 'string' && result.signal.length > 0) };
}
function childEvidence(commands) {
  return { directChildrenWaited: commands.length > 0 && commands.every(command => command.directChildWaited),
    descendantClosureVerified: false, commandOutcomes: commands };
}
// The shared supervisor owns wait/close/group probes and hashes raw originals
// only after EOF. CLI's smaller raw budget is a fail-closed artifact-size bound.
function runCliPublicationCommand(command, args, options) {
  return runPublicationCommand(command, args, { ...options, rawLimit: 262144 });
}
function context(root, env = process.env) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const checkoutSha = result.stdout.trim();
  if (result.status !== 0 || !/^[a-f0-9]{40}$/.test(checkoutSha) || (env.GITHUB_SHA && env.GITHUB_SHA !== checkoutSha)) throw new Error('publication_checkout_mismatch');
  const ci = env.GITHUB_ACTIONS === 'true';
  if (ci && (!/^\d+$/.test(env.GITHUB_RUN_ID || '') || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT || ''))) throw new Error('publication_run_context_missing');
  return { checkoutSha, eventHeadSha: env.EVENT_HEAD_SHA || null, runId: env.GITHUB_RUN_ID || 'local', runAttempt: env.GITHUB_RUN_ATTEMPT || '1',
    environment: ci ? 'github-actions' : 'local', runnerOS: env.RUNNER_OS || process.platform,
    workingTreeDirty: Boolean(spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.trim()) };
}
function inventory(root) {
  const files = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile() && !stat.isSymbolicLink()) files.push({ path: path.relative(root, file).split(path.sep).join('/'), bytes: stat.size, mode: stat.mode & 0o777, sha256: fileHash(file) });
      else throw new Error('publication_output_not_regular');
    }
  }
  visit(root); return files;
}
function publicationBuildInputInventory(source, files) {
  return files.map(row => {
    const relative = row.path === 'packages/xpod-cli/publication.bun.lock' ? 'bun.lock' : row.path;
    const file = path.join(source, relative), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('publication_build_input_not_regular');
    return { path: row.path, buildPath: relative, bytes: stat.size, sha256: fileHash(file) };
  }).sort((a, b) => a.path.localeCompare(b.path));
}
function retainBuildMetafiles(directory, evidence, label) {
  if (!fs.existsSync(directory)) return [];
  const rows = [];
  function visit(relative) {
    const file = path.join(directory, relative), stat = fs.lstatSync(file);
    if (stat.isDirectory()) { for (const name of fs.readdirSync(file).sort()) visit(relative ? relative + '/' + name : name); return; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('publication_output_not_regular');
    if (stat.size > 4 * 1024 * 1024) throw new Error('publication_metafile_budget_exceeded');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); let bytes;
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.size !== stat.size || before.size > 4 * 1024 * 1024) throw new Error('publication_metafile_changed');
      const buffer = Buffer.alloc(before.size + 1); let total = 0;
      for (let count; total < buffer.length && (count = fs.readSync(fd, buffer, total, buffer.length - total, null)) > 0;) total += count;
      bytes = buffer.subarray(0, total); const after = fs.fstatSync(fd);
      if (total !== before.size || after.size !== before.size || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) throw new Error('publication_metafile_changed');
    } finally { fs.closeSync(fd); }
    const original = label + '.metafiles/' + relative, target = path.join(evidence, original), sha256 = hash(bytes);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o644 });
    rows.push({ path: relative, bytes: bytes.length, mode: stat.mode & 0o777, sha256, original: { path: original, sha256 } });
  }
  visit(''); return rows;
}

function write(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
function produce(root, evidence, updateLock = false) {
  if (fs.existsSync(evidence)) throw new Error('publication_evidence_already_exists');
  fs.mkdirSync(evidence, { recursive: true });
  return produceOwned(root, evidence, updateLock);
}
async function produceOwned(root, evidence, updateLock) {
  const started = Date.now(), sourceContext = context(root);
  const parent = path.join(os.tmpdir(), '.test-data/xpod-cli-publication-builds'); fs.mkdirSync(parent, { recursive: true });
  const source = fs.mkdtempSync(path.join(parent, 'case-'));
  let success = false, resultRecord;
  const commandOutcomes = [], buildPhases = [], sourceCaptureCommands = [];
  const free = () => { const stat = fs.statfsSync(root); return stat.bavail * stat.bsize; };
  const phaseLog = path.join(evidence, 'phases.jsonl');
  const event = value => fs.appendFileSync(phaseLog, JSON.stringify({ time: Date.now(), freeBytes: free(), ...value }) + '\n');
  const execute = async (command, args, cwd) => {
    const phase = command + ' ' + args.join(' '), label = 'phase-' + String(commandOutcomes.length).padStart(3, '0');
    event({ event: 'start', phase, cwd, commandEvidence: label + '.receipt.json', rawLimitPerStream: 262144, timeoutMs: 180000 });
    try {
      const outcome = await runCliPublicationCommand(command, args, { cwd, env: process.env, evidence, label });
      const reference = { phase, receipt: { path: label + '.receipt.json', sha256: fileHash(path.join(evidence, label + '.receipt.json')) } };
      commandOutcomes.push({ ...reference, ...outcome });
      event({ event: 'close', phase, ...reference, actualWait: outcome.actualWait, actualClose: outcome.actualClose, groupAbsent: outcome.groupAbsent });
      return outcome;
    } catch (error) {
      commandOutcomes.push({ phase, receipt: fs.existsSync(path.join(evidence, label + '.receipt.json'))
        ? { path: label + '.receipt.json', sha256: fileHash(path.join(evidence, label + '.receipt.json')) } : null, ...(error.outcome || {}) });
      event({ event: 'close', phase, failure: String(error), ...(error.outcome || {}) }); throw error;
    }
  };

  try {
    const copied = copyCliBuildInputs(root, source);
    const cli = path.join(source, 'packages/xpod-cli'), client = path.join(source, 'packages/xpod-client');
    const information = json(path.join(cli, 'package.json')), rootManifest = json(path.join(root, 'package.json'));
    if (typeof rootManifest.devDependencies?.semver !== 'string') throw new Error('publication_semver_declaration_missing');
    const buildManifest = { name: 'xpod-cli-publication-build', private: true,
      workspaces: ['packages/xpod-cli', 'packages/xpod-client'],
      devDependencies: { ...information.devDependencies, semver: rootManifest.devDependencies.semver } };
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify(buildManifest, null, 2));
    const additional = [...TOOLS, ...PATCHES.map(name => 'scripts/' + name), 'scripts/check-cli-publication.cjs', 'scripts/cli-build-inputs.cjs', '.github/workflows/cli-package.yml', 'bunfig.toml', 'package.json'];
    for (const relative of additional) {
      const file = path.join(root, relative); copied.files.push({ path: relative, bytes: fs.statSync(file).size, sha256: fileHash(file) });
      if (relative !== 'package.json') { const target = path.join(source, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(file, target); }
    }
    const lock = path.join(root, 'packages/xpod-cli/publication.bun.lock');
    if (fs.existsSync(lock)) { fs.copyFileSync(lock, path.join(source, 'bun.lock')); copied.files.push({ path: 'packages/xpod-cli/publication.bun.lock', bytes: fs.statSync(lock).size, sha256: fileHash(lock) }); }
    else if (!updateLock) throw new Error('publication_build_lock_missing');
    await execute('bun', ['install', '--ignore-scripts', ...(updateLock ? [] : ['--frozen-lockfile'])], source);
    if (updateLock) {
      fs.copyFileSync(path.join(source, 'bun.lock'), lock);
      write(path.join(evidence, 'lock-generation.json'), { kind: 'cli-publication-lock-generation', context: sourceContext,
        generatedBuildManifest: buildManifest, lockSha256: fileHash(lock), published: false, releaseQualified: false });
      success = true; return;
    }
    for (const absent of ['@solid/community-server', '@undefineds.co/models', 'inngest-cli', 'react']) {
      if (fs.existsSync(path.join(source, 'node_modules', absent))) throw new Error('publication_server_dependency_present');
    }
    for (const patch of PATCHES) await execute('bun', ['scripts/' + patch], source);
    const captureSource = async (action, request) => {
      const label = 'source-capture-' + action, requestFile = path.join(evidence, label + '.request.json');
      write(requestFile, request);
      let outcome;
      try { outcome = await runPublicationCommand('python3', ['-I', '-B', path.join(source, 'scripts/lib/module-source-materials.py'),
        'portable-' + action, source, evidence, requestFile], { cwd: source, env: process.env, evidence, label,
        timeoutMs: Math.min(JSON.parse(fs.readFileSync(path.join(source, 'scripts/lib/module-artifact-limits.json'))).captureTimeoutMs, 600000), rawLimit: 262144 });
        sourceCaptureCommands.push(outcome);
      } catch (error) { sourceCaptureCommands.push(error.outcome || {}); throw error; }
      if (!outcome.actualWait || !outcome.actualClose || !outcome.groupAbsent || !outcome.rawComplete) throw new Error('publication_source_capture_unclosed');
      return JSON.parse(fs.readFileSync(path.join(evidence, outcome.raw[0].path), 'utf8'));
    };
    await captureSource('before', { sourcePaths: publicationBuildInputInventory(source, copied.files).map(row => row.buildPath) });
    const compile = async (args, cwd, role) => {
      const snapshotInputs = () => publicationBuildInputInventory(source, copied.files);
      const before = snapshotInputs();
      await execute('bun', args, cwd);
      const after = snapshotInputs();
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('publication_build_input_changed');
      const command = commandOutcomes[commandOutcomes.length - 1];
      const filename = command.receipt.path.replace('.receipt.json', '.build.json');
      const metafiles = path.join(cwd, '.test-data/build');
      write(path.join(evidence, filename), { schemaVersion: 1, kind: 'cli-publication-build-phase', role,
        command: command.receipt, inputsBefore: before, inputsAfter: after,
        generatedBuildManifest: { bytes: fs.statSync(path.join(source, 'package.json')).size, sha256: fileHash(path.join(source, 'package.json')) },
        outputs: inventory(path.join(cwd, 'dist')), metafiles: retainBuildMetafiles(metafiles, evidence, filename.replace('.build.json', '')) });
      buildPhases.push({ role, path: filename, sha256: fileHash(path.join(evidence, filename)) });
    };
    await compile(['run', 'build:tools'], cli, 'cli-build-tools');
    await compile(['run', 'build'], client, 'client-build');
    await compile(['run', 'build'], cli, 'cli-build');
    const sourceMaterials = await captureSource('after', { phases: buildPhases, archive: { kind: 'cli-client-dist-inventories' },
      outputs: ['cli', 'client'].flatMap(role => inventory(path.join(source, 'packages/xpod-' + role, 'dist')).map(row => ({ ...row, path: role + '/dist/' + row.path }))) });
    const materials = path.join(cli, 'dist/producer-materials'), producer = json(path.join(materials, 'index.json'));
    const runtimeClients = producer.runtimeClients.filter(row => row.name === '@undefineds.co/xpod-client');
    if (runtimeClients.length !== 1) throw new Error('publication_runtime_client_ambiguous');
    const relative = runtimeClients[0].publication.archive;
    if (typeof relative !== 'string' || relative.startsWith('/') || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('publication_client_archive_reference_invalid');
    fs.copyFileSync(path.join(materials, relative), path.join(evidence, 'client.tgz'));
    await execute('bun', ['pm', 'pack', '--ignore-scripts', '--filename', path.join(evidence, 'cli.tgz')], cli);
    fs.mkdirSync(path.join(evidence, 'source-manifests'));
    fs.copyFileSync(path.join(cli, 'package.json'), path.join(evidence, 'source-manifests/cli.package.json'));
    fs.copyFileSync(path.join(client, 'package.json'), path.join(evidence, 'source-manifests/client.package.json'));
    const archiveRef = name => { const bytes = fs.readFileSync(path.join(evidence, name)); return { path: name, sha256: hash(bytes), integrity: sha512Integrity(bytes) }; };
    const originalRef = name => ({ path: name, sha256: fileHash(path.join(evidence, name)) });
    const input = { schemaVersion: 1, cli: archiveRef('cli.tgz'), client: archiveRef('client.tgz'), sourceManifests: {
      cli: originalRef('source-manifests/cli.package.json'), client: originalRef('source-manifests/client.package.json') } };
    write(path.join(evidence, 'input.json'), input);
    event({ event: 'start', phase: 'prepare-publication' });
    const prepared = await execute('bun', ['scripts/prepare-cli-publication.ts', path.join(evidence, 'input.json')], source);
    const preparation = JSON.parse(fs.readFileSync(path.join(evidence, prepared.raw[0].path), 'utf8'));
    if (!preparation.embeddedClientIdentityVerified || preparation.releaseQualified || preparation.published) throw new Error('publication_preparation_flags_invalid');
    write(path.join(evidence, 'preparation.json'), preparation);
    write(path.join(evidence, 'producer-index.json'), producer);
    copied.files.sort((a, b) => a.path.localeCompare(b.path));
    for (const file of copied.files) if (fileHash(path.join(root, file.path)) !== file.sha256) throw new Error('publication_source_changed');
    write(path.join(evidence, 'source-inputs.json'), { schemaVersion: 1, context: sourceContext, generatedBuildManifest: buildManifest, files: copied.files });
    const products = Object.fromEntries(['cli', 'client'].map(id => { const ref = input[id], data = fs.readFileSync(path.join(evidence, ref.path));
      const inspected = inspectTarballBuffer(data); return [id, { package: inspected.manifest.name, version: inspected.manifest.version, archive: { ...ref, bytes: data.length } }]; }));
    resultRecord = { schemaVersion: 1, kind: 'cli-publication-preparation-producer', status: 'prepared-not-published',
      context: sourceContext, products, buildPhases, sourceMaterials, durationMs: Date.now() - started,
      sourceInputs: originalRef('source-inputs.json'), producerIndex: originalRef('producer-index.json'), preparation: originalRef('preparation.json'),
      embeddedClientIdentityVerified: true, privateConsumerArtifactsReused: false,
      legalQualified: false, nativeQualified: false, releaseQualified: false, published: false };
    success = true;
  } catch (error) {
    write(path.join(evidence, 'failure.json'), { kind: 'cli-publication-preparation-failure', context: sourceContext, error: String(error), published: false, releaseQualified: false });
    throw error;
  } finally {
    // Delete the owned build tree only after every observed command/group and
    // inherited output pipe has actually closed. Unknown closure retains it.
    const ownedClosed = [...commandOutcomes, ...sourceCaptureCommands].every(command => command.actualWait === true && command.actualClose === true
      && command.groupAbsent === true && command.rawClosed === true && command.rawComplete === true);
    if (ownedClosed) fs.rmSync(source, { recursive: true, force: true });
    event({ event: 'cleanup', sourceAbsent: !fs.existsSync(source) });
    write(path.join(evidence, 'cleanup.json'), { schemaVersion: 1, kind: 'cli-publication-owned-command-cleanup',
      scope: 'owned direct children and inherited process groups/pipes; deliberately escaped sessions are not attested',
      source, sourceAbsent: !fs.existsSync(source), success, rawLimitPerStream: 262144, timeoutMs: 180000,
      // This compatibility field never grants authority; use original receipts.
      descendantClosureVerified: false, commandOutcomes });
  }
  const files = inventory(evidence);
  write(path.join(evidence, 'inventory.json'), { schemaVersion: 1, scope: 'all artifact members except this inventory and result.json, avoiding self-reference', files });
  resultRecord.inventory = { path: 'inventory.json', sha256: fileHash(path.join(evidence, 'inventory.json')) };
  write(path.join(evidence, 'result.json'), resultRecord);
}
if (require.main === module) {
  const root = path.resolve(__dirname, '..'), args = process.argv.slice(2);
  const index = args.indexOf('--evidence'), value = index < 0 ? '.test-data/cli-publication-preparation' : args[index + 1];
  if (!value || value.startsWith('--')) throw new Error('publication_evidence_missing');
  const evidence = path.resolve(root, value), relative = path.relative(path.join(root, '.test-data'), evidence);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('publication_evidence_invalid');
  Promise.resolve(produce(root, evidence, args.includes('--update-lock'))).catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
}
module.exports = { produce, context, inventory, directChildOutcome, childEvidence, TOOLS, PATCHES, runCliPublicationCommand, publicationBuildInputInventory, retainBuildMetafiles };
