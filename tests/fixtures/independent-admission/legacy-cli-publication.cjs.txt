#!/usr/bin/env node
'use strict';
// Actual isolated workspace producer. No publication or private consumer-manifest rewrite.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { copyCliBuildInputs } = require('./cli-build-inputs.cjs');
const { inspectTarballBuffer, sha512Integrity } = require('./workspace-package-payload.cjs');
const TOOLS = ['scripts/prepare-cli-publication.ts', 'scripts/independent-release-plan.ts', 'scripts/workspace-package-payload.cjs'];
const PATCHES = ['patch-jose.js', 'patch-inrupt-authn-refresh.js', 'patch-inrupt-authn-transport.js', 'patch-inrupt-authn-operation-cleanup.js'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash = file => hash(fs.readFileSync(file));
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
function run(command, args, cwd, env = process.env, observe = () => {}) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  const outcome = directChildOutcome(result); observe(outcome);
  if (result.error || result.status !== 0 || result.signal) {
    const error = new Error(`publication_command_failed:${command} ${args.join(' ')}`);
    error.commandOutcome = outcome; throw error;
  }
  return outcome;
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
function write(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
function produce(root, evidence, updateLock = false) {
  if (fs.existsSync(evidence)) throw new Error('publication_evidence_already_exists');
  fs.mkdirSync(evidence, { recursive: true });
  const started = Date.now(), sourceContext = context(root);
  const parent = path.join(os.tmpdir(), '.test-data/xpod-cli-publication-builds'); fs.mkdirSync(parent, { recursive: true });
  const source = fs.mkdtempSync(path.join(parent, 'case-'));
  let success = false, resultRecord;
  const commandOutcomes = [];
  const free = () => { const stat = fs.statfsSync(root); return stat.bavail * stat.bsize; };
  const phaseLog = path.join(evidence, 'phases.jsonl');
  const event = value => fs.appendFileSync(phaseLog, JSON.stringify({ time: Date.now(), freeBytes: free(), ...value }) + '\n');
  const execute = (command, args, cwd) => {
    const phase = command + ' ' + args.join(' '); event({ event: 'start', phase, cwd });
    try {
      const outcome = run(command, args, cwd, process.env, facts => commandOutcomes.push({ phase, ...facts }));
      event({ event: 'close', phase, ...outcome });
    } catch (error) { event({ event: 'close', phase, ...(error.commandOutcome || {}), failure: String(error) }); throw error; }
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
    if (fs.existsSync(lock)) fs.copyFileSync(lock, path.join(source, 'bun.lock'));
    else if (!updateLock) throw new Error('publication_build_lock_missing');
    execute('bun', ['install', '--ignore-scripts', ...(updateLock ? [] : ['--frozen-lockfile'])], source);
    if (updateLock) {
      fs.copyFileSync(path.join(source, 'bun.lock'), lock);
      write(path.join(evidence, 'lock-generation.json'), { kind: 'cli-publication-lock-generation', context: sourceContext,
        generatedBuildManifest: buildManifest, lockSha256: fileHash(lock), published: false, releaseQualified: false });
      success = true; return;
    }
    for (const absent of ['@solid/community-server', '@undefineds.co/models', 'inngest-cli', 'react']) {
      if (fs.existsSync(path.join(source, 'node_modules', absent))) throw new Error('publication_server_dependency_present');
    }
    for (const patch of PATCHES) execute('bun', ['scripts/' + patch], source);
    execute('bun', ['run', 'build:tools'], cli);
    execute('bun', ['run', 'build'], client);
    execute('bun', ['run', 'build'], cli);
    const materials = path.join(cli, 'dist/producer-materials'), producer = json(path.join(materials, 'index.json'));
    const runtimeClients = producer.runtimeClients.filter(row => row.name === '@undefineds.co/xpod-client');
    if (runtimeClients.length !== 1) throw new Error('publication_runtime_client_ambiguous');
    const relative = runtimeClients[0].publication.archive;
    if (typeof relative !== 'string' || relative.startsWith('/') || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('publication_client_archive_reference_invalid');
    fs.copyFileSync(path.join(materials, relative), path.join(evidence, 'client.tgz'));
    execute('bun', ['pm', 'pack', '--ignore-scripts', '--filename', path.join(evidence, 'cli.tgz')], cli);
    fs.mkdirSync(path.join(evidence, 'source-manifests'));
    fs.copyFileSync(path.join(cli, 'package.json'), path.join(evidence, 'source-manifests/cli.package.json'));
    fs.copyFileSync(path.join(client, 'package.json'), path.join(evidence, 'source-manifests/client.package.json'));
    const archiveRef = name => { const bytes = fs.readFileSync(path.join(evidence, name)); return { path: name, sha256: hash(bytes), integrity: sha512Integrity(bytes) }; };
    const originalRef = name => ({ path: name, sha256: fileHash(path.join(evidence, name)) });
    const input = { schemaVersion: 1, cli: archiveRef('cli.tgz'), client: archiveRef('client.tgz'), sourceManifests: {
      cli: originalRef('source-manifests/cli.package.json'), client: originalRef('source-manifests/client.package.json') } };
    write(path.join(evidence, 'input.json'), input);
    event({ event: 'start', phase: 'prepare-publication' });
    const prepared = spawnSync('bun', ['scripts/prepare-cli-publication.ts', path.join(evidence, 'input.json')], { cwd: source, encoding: 'utf8' });
    const preparedOutcome = directChildOutcome(prepared);
    commandOutcomes.push({ phase: 'prepare-publication', ...preparedOutcome });
    event({ event: 'close', phase: 'prepare-publication', ...preparedOutcome });
    if (prepared.error || prepared.status !== 0) throw new Error('publication_preparation_failed:' + prepared.stderr);
    const preparation = JSON.parse(prepared.stdout);
    if (!preparation.embeddedClientIdentityVerified || preparation.releaseQualified || preparation.published) throw new Error('publication_preparation_flags_invalid');
    write(path.join(evidence, 'preparation.json'), preparation);
    write(path.join(evidence, 'producer-index.json'), producer);
    copied.files.push({ path: 'packages/xpod-cli/publication.bun.lock', bytes: fs.statSync(lock).size, sha256: fileHash(lock) });
    copied.files.sort((a, b) => a.path.localeCompare(b.path));
    for (const file of copied.files) if (fileHash(path.join(root, file.path)) !== file.sha256) throw new Error('publication_source_changed');
    write(path.join(evidence, 'source-inputs.json'), { schemaVersion: 1, context: sourceContext, generatedBuildManifest: buildManifest, files: copied.files });
    const products = Object.fromEntries(['cli', 'client'].map(id => { const ref = input[id], data = fs.readFileSync(path.join(evidence, ref.path));
      const inspected = inspectTarballBuffer(data); return [id, { package: inspected.manifest.name, version: inspected.manifest.version, archive: { ...ref, bytes: data.length } }]; }));
    resultRecord = { schemaVersion: 1, kind: 'cli-publication-preparation-producer', status: 'prepared-not-published',
      context: sourceContext, products, durationMs: Date.now() - started,
      sourceInputs: originalRef('source-inputs.json'), producerIndex: originalRef('producer-index.json'), preparation: originalRef('preparation.json'),
      embeddedClientIdentityVerified: true, privateConsumerArtifactsReused: false,
      legalQualified: false, nativeQualified: false, releaseQualified: false, published: false };
    success = true;
  } catch (error) {
    write(path.join(evidence, 'failure.json'), { kind: 'cli-publication-preparation-failure', context: sourceContext, error: String(error), published: false, releaseQualified: false });
    throw error;
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    event({ event: 'cleanup', sourceAbsent: !fs.existsSync(source) });
    write(path.join(evidence, 'cleanup.json'), { source, sourceAbsent: !fs.existsSync(source), success, ...childEvidence(commandOutcomes) });
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
  produce(root, evidence, args.includes('--update-lock'));
}
module.exports = { produce, context, inventory, directChildOutcome, childEvidence, TOOLS, PATCHES };
