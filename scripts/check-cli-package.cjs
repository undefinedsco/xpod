#!/usr/bin/env node
'use strict';
// Build from a minimal source/dependency tree, then install the tarball as a clean consumer.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const original = path.join(root, 'packages/xpod-cli');
const evidenceIndex = process.argv.indexOf('--evidence');
const evidenceArgument = evidenceIndex < 0 ? '.test-data/cli-package' : process.argv[evidenceIndex + 1];
if (!evidenceArgument || evidenceArgument.startsWith('--')) throw new Error('cli_evidence_path_missing');
const evidence = path.resolve(root, evidenceArgument);
const evidenceRelative = path.relative(path.join(root, '.test-data'), evidence);
if (!evidenceRelative || evidenceRelative.startsWith('..') || path.isAbsolute(evidenceRelative)) throw new Error('cli_evidence_path_invalid');
// A tree nested under the repository can still resolve undeclared optional
// imports from repository ancestors. Build outside that ancestor chain.
const buildParent = path.join(os.tmpdir(), '.test-data/xpod-cli-builds');
fs.mkdirSync(buildParent, { recursive: true });
const source = fs.mkdtempSync(path.join(buildParent, 'case-'));
const packageRoot = path.join(source, 'packages/xpod-cli');
const consumerParent = path.join(os.tmpdir(), '.test-data/xpod-cli-consumers');
fs.mkdirSync(consumerParent, { recursive: true });
const consumer = fs.mkdtempSync(path.join(consumerParent, 'case-'));
process.on('exit', (actualExit) => {
  fs.rmSync(consumer, { recursive: true, force: true });
  fs.rmSync(source, { recursive: true, force: true });
  fs.writeFileSync(path.join(evidence, 'consumer-cleanup.json'), JSON.stringify({ actualExit, path: consumer,
    absent: !fs.existsSync(consumer), source, sourceAbsent: !fs.existsSync(source) }));
});
const runtimeClientRoot = path.join(source, 'packages/xpod-client');
const runtimeClientTar = path.join(evidence, 'xpod-client.tgz');
const run = (command, args, cwd, env = process.env) => {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.status !== 0 || result.signal) throw new Error(`cli_package_command_failed:${command}`);
};
const started = Date.now();
fs.mkdirSync(evidence, { recursive: true });
fs.rmSync(source, { recursive: true, force: true });
fs.mkdirSync(packageRoot, { recursive: true });
require('./cli-build-inputs.cjs').copyCliBuildInputs(root, source);
const information = JSON.parse(fs.readFileSync(path.join(original, 'package.json')));
// Build dependencies are declared once, in the CLI package; never install the root server graph.
fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'xpod-cli-build', private: true, devDependencies: information.devDependencies }));
const buildLock = path.join(original, 'build.bun.lock');
if (fs.existsSync(buildLock)) fs.copyFileSync(buildLock, path.join(source, 'bun.lock'));
else if (!process.argv.includes('--update-lock')) throw new Error('cli_build_lock_missing');
run('bun', ['install', '--ignore-scripts', ...(process.argv.includes('--update-lock') ? [] : ['--frozen-lockfile'])], source);
if (process.argv.includes('--update-lock')) fs.copyFileSync(path.join(source, 'bun.lock'), buildLock);
// Reuse the canonical runtime compatibility patches, not copied implementations in product source.
fs.mkdirSync(path.join(source, 'scripts'));
for (const name of ['patch-jose.js', 'patch-inrupt-authn-refresh.js', 'patch-inrupt-authn-transport.js', 'patch-inrupt-authn-operation-cleanup.js']) {
  fs.copyFileSync(path.join(root, 'scripts', name), path.join(source, 'scripts', name));
  run('bun', ['scripts/' + name], source);
}
for (const absent of ['@solid/community-server', '@undefineds.co/models', 'inngest-cli', 'react']) {
  if (fs.existsSync(path.join(source, 'node_modules', absent))) throw new Error('cli_server_dependency_present');
}
// The standalone public tooling producer is also used by the full CLI build.
run('bun', ['run', 'build:tools'], packageRoot);
const buildToolsPayload = path.join(packageRoot, 'dist/build-tools.mjs');
run('bun', ['scripts/build.ts', '--build-tools', buildToolsPayload], runtimeClientRoot);
run('bun', ['run', 'typecheck'], runtimeClientRoot);
run('bun', ['run', 'test'], runtimeClientRoot);
const runtimeClientManifestPath = path.join(runtimeClientRoot, 'package.json');
const runtimeClientManifest = JSON.parse(fs.readFileSync(runtimeClientManifestPath));
runtimeClientManifest.devDependencies['@undefineds.co/xpod-cli'] = information.version;
fs.writeFileSync(runtimeClientManifestPath, JSON.stringify(runtimeClientManifest, null, 2));
run('bun', ['pm', 'pack', '--filename', runtimeClientTar, '--ignore-scripts'], runtimeClientRoot);
// The CLI producer and consumer resolve an actual packed runtime client, not workspace sources.
run('bun', ['add', '--ignore-scripts', runtimeClientTar], source);
run('bun', ['run', 'typecheck'], packageRoot);
run('bun', ['run', 'test'], packageRoot);
run('bun', ['run', 'build'], packageRoot);
fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'xpod-cli-consumer', private: true }));
run('bun', ['add', '--ignore-scripts', runtimeClientTar], consumer);
// Only the private test manifest binds the unpublished client to its actual local tarball.
const cliManifest = path.join(packageRoot, 'package.json');
const packedCliManifest = JSON.parse(fs.readFileSync(cliManifest));
if (packedCliManifest.dependencies?.['@undefineds.co/xpod-client'] !== 'workspace:*') throw new Error('cli_runtime_client_dependency_missing');
packedCliManifest.dependencies['@undefineds.co/xpod-client'] = 'file:' + runtimeClientTar;
fs.writeFileSync(cliManifest, JSON.stringify(packedCliManifest, null, 2));
run('bun', ['pm', 'pack', '--filename', path.join(evidence, 'xpod-cli.tgz'), '--ignore-scripts'], packageRoot);
run('bun', ['add', '--ignore-scripts', path.join(evidence, 'xpod-cli.tgz')], consumer);
const installed = path.join(consumer, 'node_modules/@undefineds.co/xpod-cli');
const actual = JSON.parse(fs.readFileSync(path.join(installed, 'package.json')));
if (actual.name !== information.name || actual.version !== information.version || JSON.stringify(actual.dependencies) !== JSON.stringify({ '@undefineds.co/xpod-client': 'file:' + runtimeClientTar }) || actual.optionalDependencies) throw new Error('cli_public_package_contract_invalid');
for (const name of ['node_modules', 'src', 'helper', 'runtime', 'dist/build-inputs.json']) {
  if (fs.existsSync(path.join(installed, name))) throw new Error('cli_unexpected_installed_payload');
}
const privateHome = path.join(evidence, 'home'); fs.mkdirSync(privateHome, { recursive: true });
const environment = { ...process.env, HOME: privateHome, NODE_ENV: undefined, NODE_OPTIONS: undefined, BUN_OPTIONS: undefined };
// Prove default runtime behavior with no SDK and no repository ancestor resolution.
for (const runtime of ['bun', 'node']) {
  const safe = spawnSync(runtime, ['--input-type=module', '-e', "import * as client from '@undefineds.co/xpod-client'; import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); try { require.resolve('@inrupt/solid-client-authn-node'); throw Error('unexpected SDK'); } catch (error) { if(error.code !== 'MODULE_NOT_FOUND') throw error; } if(typeof client.authFetch !== 'function') throw Error('safe client unavailable');"], { cwd: consumer, env: environment, encoding: 'utf8' });
  if (safe.status !== 0 || safe.signal) throw new Error('cli_default_sdk_absence_failed:' + safe.stderr);
  for (const args of [['--version'], ['--help'], ['module', 'list']]) run(runtime, [path.join(installed, 'dist/xpod.mjs'), ...args], consumer, environment);
}
// Explicit peer injection uses the real registry SDK, never workspace patches.
run('bun', ['add', '--ignore-scripts', '@inrupt/solid-client-authn-node@3.1.1'], consumer);
for (const runtime of ['bun', 'node']) {
  const sdk = spawnSync(runtime, ['--input-type=module', '-e', "import {createRequire} from 'node:module'; import {loadSolidAuthnSdk,authFetch} from '@undefineds.co/xpod-client'; import {Session} from '@undefineds.co/xpod-client/session'; const require=createRequire(import.meta.url),sdk=require('@inrupt/solid-client-authn-node'),sessionCjs=require('@undefineds.co/xpod-client/session'),clientCjs=require('@undefineds.co/xpod-client'); const first=loadSolidAuthnSdk(),second=loadSolidAuthnSdk(); if(first!==second || await first!==sdk || Session!==sdk.Session || sessionCjs.Session!==Session || clientCjs.authFetch!==authFetch) throw Error('SDK class/cache/fetch identity'); console.log(JSON.stringify({Session:typeof sdk.Session,getSessionFromStorage:typeof sdk.getSessionFromStorage,refreshSession:typeof sdk.refreshSession})); if(typeof sdk.getSessionFromStorage !== 'function' || typeof sdk.refreshSession !== 'function') throw Error('official SDK refresh contract missing');"], { cwd: consumer, env: environment, encoding: 'utf8' });
  if (sdk.stdout) console.log(sdk.stdout.trim());
  if (sdk.status !== 0 || sdk.signal) throw new Error('cli_official_sdk_peer_contract_failed:' + sdk.stderr);
}
for (const runtime of ['bun', 'node']) {
  const bridge = spawnSync(runtime, ['--input-type=module', '-e', "import * as esm from '@undefineds.co/xpod-cli/client'; import { createRequire } from 'node:module'; const cjs = createRequire(import.meta.url)('@undefineds.co/xpod-cli/client'); const canonical=createRequire(import.meta.url)('@undefineds.co/xpod-client'); if (esm.CliCommandError !== cjs.CliCommandError || esm.authFetch !== canonical.authFetch || esm.CliCommandError !== canonical.CliCommandError || typeof esm.authFetch !== 'function') throw new Error('client bridge invalid');"], { cwd: consumer, env: environment, encoding: 'utf8' });
  if (bridge.status !== 0 || bridge.signal) throw new Error('cli_consumer_client_bridge_failed:' + bridge.stderr);
  const producer = spawnSync(runtime, ['--input-type=module', '-e', `
    import { collectJavascriptNotices, verifyProducerSourceArchive } from '@undefineds.co/xpod-cli/build-tools';
    import { createRequire } from 'node:module';
    import { readFileSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    import path from 'node:path';
    const require = createRequire(import.meta.url);
    if (typeof collectJavascriptNotices !== 'function' || typeof require('@undefineds.co/xpod-cli/build-tools').collectJavascriptNotices !== 'function') throw Error('build-tools unavailable');
    const indexFile = require.resolve('@undefineds.co/xpod-cli/producer-materials');
    const index = JSON.parse(readFileSync(indexFile));
    if (index.schemaVersion !== 1 || index.producer.name !== '@undefineds.co/xpod-cli' || index.files.some(file => file.path === 'index.json')) throw Error('producer index invalid');
    for (const file of index.files) {
      const bytes = readFileSync(path.join(path.dirname(indexFile), file.path));
      if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw Error('producer material changed');
    }
    await verifyProducerSourceArchive({ archive: path.join(path.dirname(indexFile), index.clientSource), inventory: path.join(path.dirname(indexFile), index.sourceInventory) });
    for (const [filename, digest] of [['client.cjs', index.clientPayloads.cjsSHA256], ['client.mjs', index.clientPayloads.esmSHA256]]) {
      if (createHash('sha256').update(readFileSync(path.join(path.dirname(indexFile), '..', filename))).digest('hex') !== digest) throw Error('producer client binding changed');
    }
  `], { cwd: consumer, env: environment, encoding: 'utf8' });
  if (producer.status !== 0 || producer.signal) throw new Error('cli_consumer_producer_contract_failed:' + producer.stderr);
  for (const args of [['--version'], ['--help'], ['start', '--help'], ['auth', '--help'], ['module', 'list']]) {
    const result = spawnSync(runtime, [path.join(installed, 'dist/xpod.mjs'), ...args], { cwd: consumer, env: environment, encoding: 'utf8' });
    if (result.status !== 0 || result.signal) throw new Error('cli_consumer_failed');
    if (args[0] === '--version' && result.stdout.trim() !== information.version) throw new Error('cli_consumer_version_invalid');
    if (args[0] === '--help' && !result.stdout.includes('module <operation>')) throw new Error('cli_consumer_help_invalid');
    if (args[0] === 'auth' && !result.stdout.includes('auth status')) throw new Error('cli_consumer_auth_help_invalid');
    if (args[0] === 'module') {
      const output = JSON.parse(result.stdout);
      if (!output.ok || output.data.length !== 3 || output.data.some(row => row.installed !== null)) throw new Error('cli_consumer_module_list_invalid');
    }
    console.log(`CLI consumer ${runtime}: ${args.join(' ')} passed`);
  }
}
run(path.join(consumer, 'node_modules/.bin/xpod'), ['--version'], consumer, environment);
if (fs.existsSync(path.join(privateHome, '.xpod/modules'))) throw new Error('cli_core_downloaded_optional_module');
const result = { status: 'passed', kind: 'isolated-cli-build-and-tarball-consumer', version: actual.version,
  durationMs: Date.now() - started, optionalRuntimeDownloaded: false, productionDependencies: 1, runtimeClientTarball: true,
  runtimes: ['bun', 'node'], moduleDownloadTests: 'registry-fixture', realMount: 'not-run', published: false };
fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
