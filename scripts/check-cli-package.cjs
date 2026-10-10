#!/usr/bin/env node
'use strict';
// Build from a minimal source/dependency tree, then install the tarball as a clean consumer.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const original = path.join(root, 'packages/xpod-cli');
const evidence = path.join(root, '.test-data/cli-package');
const source = path.join(evidence, 'source');
const packageRoot = path.join(source, 'packages/xpod-cli');
const consumer = path.join(evidence, 'consumer');
const run = (command, args, cwd, env = process.env) => {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.status !== 0 || result.signal) throw new Error(`cli_package_command_failed:${command}`);
};
const started = Date.now();
fs.mkdirSync(evidence, { recursive: true });
fs.rmSync(source, { recursive: true, force: true }); fs.rmSync(consumer, { recursive: true, force: true });
fs.mkdirSync(packageRoot, { recursive: true });
for (const entry of ['src', 'scripts', 'tests', 'licenses', 'tsconfig.json', 'tsconfig.core.json', 'tsconfig.client.json', 'package.json', 'README.md', 'LICENSE']) {
  fs.cpSync(path.join(original, entry), path.join(packageRoot, entry), { recursive: true });
}
fs.cpSync(path.join(root, 'types/bun'), path.join(source, 'types/bun'), { recursive: true });
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(source, 'LICENSE'));
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
run('bun', ['run', 'typecheck'], packageRoot);
run('bun', ['test', 'tests/module-store.test.ts', 'tests/launcher.test.ts', 'tests/javascript-notices.test.ts'], packageRoot);
run('bun', ['run', 'build'], packageRoot);
run('bun', ['pm', 'pack', '--filename', path.join(evidence, 'xpod-cli.tgz'), '--ignore-scripts'], packageRoot);
fs.mkdirSync(consumer); fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'xpod-cli-consumer', private: true }));
run('bun', ['add', '--ignore-scripts', path.join(evidence, 'xpod-cli.tgz')], consumer);
const installed = path.join(consumer, 'node_modules/@undefineds.co/xpod-cli');
const actual = JSON.parse(fs.readFileSync(path.join(installed, 'package.json')));
if (actual.name !== information.name || actual.version !== information.version || actual.dependencies || actual.optionalDependencies) throw new Error('cli_public_package_contract_invalid');
for (const name of ['node_modules', 'src', 'helper', 'runtime', 'dist/build-inputs.json']) {
  if (fs.existsSync(path.join(installed, name))) throw new Error('cli_unexpected_installed_payload');
}
const privateHome = path.join(evidence, 'home'); fs.mkdirSync(privateHome, { recursive: true });
const environment = { ...process.env, HOME: privateHome, NODE_ENV: undefined, NODE_OPTIONS: undefined, BUN_OPTIONS: undefined };
for (const runtime of ['bun', 'node']) {
  const bridge = spawnSync(runtime, ['--input-type=module', '-e', "import * as esm from '@undefineds.co/xpod-cli/client'; import { createRequire } from 'node:module'; const cjs = createRequire(import.meta.url)('@undefineds.co/xpod-cli/client'); if (esm.CliCommandError !== cjs.CliCommandError || typeof esm.authFetch !== 'function') throw new Error('client bridge invalid');"], { cwd: consumer, env: environment, encoding: 'utf8' });
  if (bridge.status !== 0 || bridge.signal) throw new Error('cli_consumer_client_bridge_failed:' + bridge.stderr);
  for (const args of [['--version'], ['--help'], ['auth', '--help'], ['module', 'list']]) {
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
  durationMs: Date.now() - started, optionalRuntimeDownloaded: false, productionDependencies: 0,
  runtimes: ['bun', 'node'], moduleDownloadTests: 'registry-fixture', realMount: 'not-run', published: false };
fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
