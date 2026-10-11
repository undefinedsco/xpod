#!/usr/bin/env node
'use strict';
// Isolated AFS library producer. Platform capability packaging remains the existing build-package.ts contract.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const original = path.join(root, 'packages/xpod-afs');
const evidence = path.join(root, '.test-data/afs-module-split-20261011', `isolated-${Date.now()}`);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-afs-build-'));
const source = path.join(scratch, 'source');
const afs = path.join(source, 'packages/xpod-afs');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const cliArg = process.argv.indexOf('--cli-package');
if (cliArg >= 0 && (!process.argv[cliArg + 1] || process.argv[cliArg + 1].startsWith('--'))) throw new Error('cli_package_argument_missing');
const cliOriginal = cliArg < 0 ? path.join(root, 'packages/xpod-cli') : fs.realpathSync(process.argv[cliArg + 1]);
const stages = [];
let copiedInputs = [];
function recordInputs(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? recordInputs(file) : [{ path: path.relative(source, file), bytes: fs.statSync(file).size, sha256: sha(fs.readFileSync(file)) }];
  }).sort((a, b) => a.path.localeCompare(b.path));
}
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
async function run(label, command, args, cwd) {
  const stdout = path.join(evidence, label + '.stdout.raw.log');
  const stderr = path.join(evidence, label + '.stderr.raw.log');
  const out = fs.openSync(stdout, 'wx', 0o600), err = fs.openSync(stderr, 'wx', 0o600);
  const child = spawn(command, args, { cwd, detached: true, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', BUN_OPTIONS: '' }, stdio: ['ignore', out, err] });
  let spawnError; child.on('error', error => { spawnError = error.code; });
  const timer = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }, 240000);
  const result = await new Promise(resolve => child.once('close', (exit, signal) => resolve({ exit, signal })));
  clearTimeout(timer); fs.closeSync(out); fs.closeSync(err);
  let absent = !child.pid;
  if (child.pid) { try { process.kill(-child.pid, 0); } catch (error) { absent = error.code === 'ESRCH'; } }
  if (!absent) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  const receipt = { label, command, args, pid: child.pid ?? null, ...result, spawnError: spawnError ?? null,
    actualClose: true, rawClosed: true, groupAbsent: absent, stdout, stderr, stdoutSHA256: sha(fs.readFileSync(stdout)), stderrSHA256: sha(fs.readFileSync(stderr)) };
  stages.push(receipt); fs.writeFileSync(path.join(evidence, label + '.receipt.json'), JSON.stringify(receipt, null, 2));
  if (result.exit !== 0 || result.signal || spawnError || !absent) throw new Error('afs_stage_failed:' + label);
}
(async () => {
  try {
    fs.mkdirSync(afs, { recursive: true });
    for (const name of ['src', 'scripts/build-client.ts', 'scripts/build-package.ts', 'scripts/producer-materials.ts', 'scripts/check-producer-materials.ts', 'tsconfig.producer.json', 'tsconfig.json', 'tsconfig.client.json', 'tsconfig.build.json', 'package.json']) {
      const dest = path.join(afs, name); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.cpSync(path.join(original, name), dest, { recursive: true });
    }
    for (const name of ['types/bun', 'config/components-ignore.json', '.componentsjs-generator-config.json']) {
      const dest = path.join(source, name); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.cpSync(path.join(root, name), dest, { recursive: true });
    }
    const cli = path.join(source, 'packages/xpod-cli'); fs.mkdirSync(cli, { recursive: true });
    const cliManifest = JSON.parse(fs.readFileSync(path.join(cliOriginal, 'package.json')));
    const clientManifest = Object.fromEntries(['name', 'version', 'type', 'engines', 'exports', 'typesVersions'].map(key => [key, cliManifest[key]]));
    fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify(clientManifest));
    if (!cliManifest.exports?.['./build-tools'] || !cliManifest.exports?.['./producer-materials']) throw new Error('cli_public_build_tools_missing');
    for (const name of ['client.cjs', 'client.mjs', 'client-types', 'build-tools.cjs', 'build-tools.mjs', 'build-tools-types', 'producer-materials']) fs.cpSync(path.join(cliOriginal, 'dist', name), path.join(cli, 'dist', name), { recursive: true });
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'xpod-afs-isolated-build', private: true, workspaces: ['packages/xpod-cli', 'packages/xpod-afs'] }, null, 2));
    const lock = path.join(original, 'build.bun.lock');
    if (fs.existsSync(lock)) fs.copyFileSync(lock, path.join(source, 'bun.lock'));
    else if (!process.argv.includes('--update-lock')) throw new Error('afs_build_lock_missing');
    copiedInputs = recordInputs(source);
    fs.writeFileSync(path.join(evidence, 'inputs.safe.json'), JSON.stringify(copiedInputs, null, 2));
    await run('install', 'bun', ['install', '--ignore-scripts', ...(process.argv.includes('--update-lock') ? [] : ['--frozen-lockfile'])], source);
    if (process.argv.includes('--update-lock')) fs.copyFileSync(path.join(source, 'bun.lock'), lock);
    for (const name of ['@solid/community-server', '@undefineds.co/models', 'react', 'inngest']) {
      let found = false;
      try { createRequire(path.join(afs, 'package.json')).resolve(name); found = true; } catch (error) { if (!['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code)) throw error; }
      if (found || fs.existsSync(path.join(source, 'node_modules', name)) || fs.existsSync(path.join(afs, 'node_modules', name))) throw new Error('afs_service_dependency_present');
    }
    await run('types', 'bun', ['x', 'tsc', '--noEmit', '-p', 'tsconfig.client.json'], afs);
    await run('build', 'bun', ['scripts/build-client.ts'], afs);
    fs.writeFileSync(path.join(afs, 'materials-check.ts'), "import {createRequire} from 'node:module'; import {resolveProducerMaterials} from './scripts/producer-materials'; const result=await resolveProducerMaterials(createRequire(import.meta.url).resolve('@undefineds.co/xpod-cli/producer-materials')); console.log(JSON.stringify(result.binding));\n");
    await run('materials', 'bun', ['materials-check.ts'], afs);
    await run('material-negatives', 'bun', ['scripts/check-producer-materials.ts'], afs);
    const inputs = Object.keys(JSON.parse(fs.readFileSync(path.join(afs, 'dist/library-inputs.json'))).inputs);
    if (inputs.some(input => /(?:@solid\/community-server|src\/(?:api|storage)|inngest|react)/.test(input))) throw new Error('afs_service_bundle_input');
    const toolFixture = path.join(source, 'tool-fixture'); fs.mkdirSync(toolFixture);
    fs.writeFileSync(path.join(toolFixture, 'entry.ts'), 'export const fixtureValue = 42;\n');
    await run('tool-fixture-build', 'bun', ['build', '--target=node', '--format=esm', '--metafile=' + path.join(toolFixture, 'inputs.json'), '--outfile', path.join(toolFixture, 'output.mjs'), path.join(toolFixture, 'entry.ts')], source);
    const toolOptions = { metafile: path.join(toolFixture, 'inputs.json'), stageRoot: source, repoRoot: source, target: process.platform + '-' + process.arch, cli: path.join(toolFixture, 'output.mjs'), bunVersion: process.versions.bun ?? 'fixture-external-runtime', destination: '' };
    const toolScript = `import { collectJavascriptNotices } from '@undefineds.co/xpod-cli/build-tools'; import { createRequire } from 'node:module'; import fs from 'node:fs'; const options=${JSON.stringify(toolOptions)}; const require=createRequire(import.meta.url); const common=require('@undefineds.co/xpod-cli/build-tools').collectJavascriptNotices; if(typeof collectJavascriptNotices!=='function'||typeof common!=='function')throw Error('public tools unavailable'); for(const [name,fn] of [['esm',collectJavascriptNotices],['cjs',common]]){const dest=options.repoRoot+'/tool-fixture/notices-'+name;fn({...options,destination:dest});if(!fs.readdirSync(dest).length)throw Error('notice output absent');} console.log('actual public notice fixture passed');`;
    fs.writeFileSync(path.join(afs, 'tool-consumer.mjs'), toolScript);
    for (const runtime of ['node', 'bun']) await run('tools-' + runtime, runtime, ['tool-consumer.mjs'], afs);
    if (process.argv.includes('--check-pack-types')) await run('pack-types', 'bun', ['x', 'tsc', '--noEmit', '-p', 'tsconfig.producer.json'], afs);
    const consumer = path.join(scratch, 'consumer'); fs.mkdirSync(consumer);
    fs.writeFileSync(path.join(consumer, 'package.json'), '{"type":"module"}');
    const installed = path.join(consumer, 'node_modules/@undefineds.co/xpod-afs'); fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.mkdirSync(installed); fs.cpSync(path.join(afs, 'dist'), path.join(installed, 'dist'), { recursive: true }); fs.copyFileSync(path.join(afs, 'package.json'), path.join(installed, 'package.json'));
    const installedCli = path.join(consumer, 'node_modules/@undefineds.co/xpod-cli'); fs.cpSync(cli, installedCli, { recursive: true });
    const drizzle = path.dirname(createRequire(path.join(afs, 'package.json')).resolve('drizzle-orm'));
    fs.cpSync(drizzle, path.join(consumer, 'node_modules/drizzle-orm'), { recursive: true, dereference: true });
    const script = "import { LocalSolidFS } from '@undefineds.co/xpod-afs/workcopy'; import { getSqliteRuntime } from '@undefineds.co/xpod-afs/sqlite/SqliteRuntime'; import { createRequire } from 'node:module'; const require=createRequire(import.meta.url); const c=require('@undefineds.co/xpod-afs/workcopy'); if(c.LocalSolidFS!==LocalSolidFS) throw Error('class identity'); const a=require('@undefineds.co/xpod-afs/sqlite/SqliteRuntime'); if(a.getSqliteRuntime!==getSqliteRuntime || a.getSqliteRuntime()!==getSqliteRuntime()) throw Error('sqlite singleton'); const db=getSqliteRuntime().openDatabase(':memory:'); try { db.exec('CREATE TABLE probe(value INTEGER); INSERT INTO probe VALUES (42)'); if(db.prepare('SELECT value FROM probe').get().value!==42) throw Error('sqlite execution'); } finally { db.close(); } if(typeof LocalSolidFS!=='function')throw Error('library missing'); console.log('public ESM/CJS library passed');";
    fs.writeFileSync(path.join(consumer, 'consumer.mjs'), script);
    for (const runtime of ['node', 'bun']) await run('consumer-' + runtime, runtime, ['consumer.mjs'], consumer);
    fs.writeFileSync(path.join(evidence, 'assessment.safe.json'), JSON.stringify({ passed: true, stages, inputs, copiedInputs, cliPackageInput: cliOriginal, publicToolsSHA256: { esm: sha(fs.readFileSync(path.join(cli, 'dist/build-tools.mjs'))), cjs: sha(fs.readFileSync(path.join(cli, 'dist/build-tools.cjs'))) }, frozenLockSHA256: sha(fs.readFileSync(path.join(source, 'bun.lock'))), clientPayloadSHA256: sha(fs.readFileSync(path.join(cli, 'dist/client.cjs'))), serviceDependenciesInstalled: false, platformCapabilityPack: 'not-run; needs genuine native evidence/pins and public build-tools entry', realHelper: 'not-run', mount: 'not-run', published: false }, null, 2));
  } finally {
    if (stages.every(stage => stage.groupAbsent)) fs.rmSync(scratch, { recursive: true, force: true });
    fs.writeFileSync(path.join(evidence, 'closure.safe.json'), JSON.stringify({ scratchRemoved: !fs.existsSync(scratch), stages, copiedInputs }, null, 2));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
