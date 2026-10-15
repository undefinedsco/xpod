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
const fixtureHome = path.join(scratch, 'home'); fs.mkdirSync(fixtureHome, { mode: 0o700 });
const afs = path.join(source, 'packages/xpod-afs');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const cliArg = process.argv.indexOf('--cli-package');
if (cliArg >= 0 && (!process.argv[cliArg + 1] || process.argv[cliArg + 1].startsWith('--'))) throw new Error('cli_package_argument_missing');
const cliOriginal = cliArg < 0 ? path.join(root, 'packages/xpod-cli') : fs.realpathSync(process.argv[cliArg + 1]);
const clientArg = process.argv.indexOf('--client-package');
if (clientArg >= 0 && (!process.argv[clientArg + 1] || process.argv[clientArg + 1].startsWith('--'))) throw new Error('client_package_argument_missing');
const clientOriginal = clientArg < 0 ? path.join(root, 'packages/xpod-client') : fs.realpathSync(process.argv[clientArg + 1]);
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
  const child = spawn(command, args, { cwd, detached: true, env: { ...process.env, HOME: fixtureHome, SOLID_HOME: path.join(fixtureHome, '.solid'), NODE_PATH: '', NODE_OPTIONS: '', BUN_OPTIONS: '' }, stdio: ['ignore', out, err] });
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
    for (const name of ['src', 'licenses/javascript', 'scripts/build-client.ts', 'scripts/build-package.ts', 'scripts/javascript-materials.ts', 'scripts/producer-materials.ts', 'scripts/check-producer-materials.ts', 'tsconfig.producer.json', 'tsconfig.json', 'tsconfig.client.json', 'tsconfig.build.json', 'package.json']) {
      const dest = path.join(afs, name); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.cpSync(path.join(original, name), dest, { recursive: true });
    }
    for (const name of ['LICENSE', 'types/bun', 'config/components-ignore.json', '.componentsjs-generator-config.json']) {
      const dest = path.join(source, name); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.cpSync(path.join(root, name), dest, { recursive: true });
    }
    const cli = path.join(source, 'packages/xpod-cli'); fs.mkdirSync(cli, { recursive: true });
    const cliManifest = JSON.parse(fs.readFileSync(path.join(cliOriginal, 'package.json')));
    const clientManifest = Object.fromEntries(['name', 'version', 'type', 'engines', 'exports', 'typesVersions'].map(key => [key, cliManifest[key]]));
    fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify(clientManifest));
    if (!cliManifest.exports?.['./build-tools'] || !cliManifest.exports?.['./producer-materials']) throw new Error('cli_public_build_tools_missing');
    for (const name of ['client.cjs', 'client.mjs', 'client-types', 'output.mjs', 'build-tools.cjs', 'build-tools.mjs', 'build-tools-types', 'producer-materials']) fs.cpSync(path.join(cliOriginal, 'dist', name), path.join(cli, 'dist', name), { recursive: true });
    const client = path.join(source, 'packages/xpod-client'); fs.mkdirSync(client, { recursive: true });
    for (const name of ['package.json', 'LICENSE', 'README.md', 'dist']) fs.cpSync(path.join(clientOriginal, name), path.join(client, name), { recursive: true });
    for (const name of ['refresh', 'transport', 'operation-cleanup']) {
      const filename = `scripts/patch-inrupt-authn-${name}.js`; fs.mkdirSync(path.join(source, 'scripts'), { recursive: true }); fs.copyFileSync(path.join(root, filename), path.join(source, filename));
    }
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'xpod-afs-isolated-build', private: true, workspaces: ['packages/xpod-cli', 'packages/xpod-client', 'packages/xpod-afs'] }, null, 2));
    const lock = path.join(original, 'build.bun.lock');
    if (fs.existsSync(lock)) fs.copyFileSync(lock, path.join(source, 'bun.lock'));
    else if (!process.argv.includes('--update-lock')) throw new Error('afs_build_lock_missing');
    copiedInputs = recordInputs(source);
    fs.writeFileSync(path.join(evidence, 'inputs.safe.json'), JSON.stringify(copiedInputs, null, 2));
    await run('install', 'bun', ['install', '--ignore-scripts', ...(process.argv.includes('--update-lock') ? [] : ['--frozen-lockfile'])], source);
    await run('sdk-patches', 'node', ['-e', "for (const name of ['refresh','transport','operation-cleanup']) require('./scripts/patch-inrupt-authn-' + name + '.js').patchInstalledPackage(process.cwd())"], source);
    if (process.argv.includes('--update-lock')) fs.copyFileSync(path.join(source, 'bun.lock'), lock);
    for (const name of ['@solid/community-server', 'react', 'inngest']) {
      let found = false;
      try { createRequire(path.join(afs, 'package.json')).resolve(name); found = true; } catch (error) { if (!['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code)) throw error; }
      if (found || fs.existsSync(path.join(source, 'node_modules', name)) || fs.existsSync(path.join(afs, 'node_modules', name))) throw new Error('afs_service_dependency_present');
    }
    await run('types', 'bun', ['x', 'tsc', '--noEmit', '-p', 'tsconfig.client.json'], afs);
    await run('build', 'bun', ['scripts/build-client.ts'], afs);
    fs.writeFileSync(path.join(afs, 'materials-check.ts'), "import {createRequire} from 'node:module'; import path from 'node:path'; import {resolveProducerMaterials} from './scripts/producer-materials'; const require=createRequire(import.meta.url); const result=await resolveProducerMaterials(require.resolve('@undefineds.co/xpod-cli/producer-materials'),path.resolve(path.dirname(require.resolve('@undefineds.co/xpod-client')),'..')); console.log(JSON.stringify(result.binding));\n");
    await run('materials', 'bun', ['materials-check.ts'], afs);
    await run('material-negatives', 'bun', ['scripts/check-producer-materials.ts'], afs);
    const libraryMetadata = JSON.parse(fs.readFileSync(path.join(afs, 'dist/library-inputs.json')));
    const inputs = Object.keys(libraryMetadata.inputs);
    const modelInputs = inputs.filter(input => /@undefineds[/.]co\/models\//.test(input));
    if (modelInputs.length !== 2 || modelInputs.some(input => !/\/dist\/(?:file-reader-notes|namespaces)\.js$/.test(input))) throw new Error('afs_models_pure_entry_closure');
    if (inputs.some(input => /(?:@solid\/community-server|src\/(?:api|storage)|inngest|react|xpod-cli(?:\/|$))/.test(input))) throw new Error('afs_service_or_cli_library_input');
    if (Object.values(libraryMetadata.inputs).some(input => input.imports.some(imported => imported.path === '@undefineds.co/xpod-cli' || imported.path.startsWith('@undefineds.co/xpod-cli/')))) throw new Error('afs_runtime_cli_dependency');
    const commandsInputs = Object.keys(JSON.parse(fs.readFileSync(path.join(afs, 'dist/commands-inputs.json'))).inputs);
    if (!commandsInputs.some(input => input.endsWith('/xpod-cli/dist/output.mjs')) || !commandsInputs.some(input => input.includes('solid-client-authn-node'))) throw new Error('afs_command_host_closure_missing');
    for (const runtime of ['node', 'bun']) await run('command-help-' + runtime, runtime, ['dist/entry.mjs', '--help'], afs);
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
    const installedClient = path.join(consumer, 'node_modules/@undefineds.co/xpod-client'); fs.cpSync(client, installedClient, { recursive: true });
    const drizzle = path.dirname(createRequire(path.join(afs, 'package.json')).resolve('drizzle-orm'));
    fs.cpSync(drizzle, path.join(consumer, 'node_modules/drizzle-orm'), { recursive: true, dereference: true });
    const models = path.dirname(path.dirname(createRequire(path.join(afs, 'package.json')).resolve('@undefineds.co/models/file-reader-notes')));
    fs.cpSync(models, path.join(consumer, 'node_modules/@undefineds.co/models'), { recursive: true, dereference: true });
    const { libraryConsumerProbe: script } = require('./lib/afs-library-consumer.cjs');
    fs.writeFileSync(path.join(consumer, 'helpers.ts'), "import { buildFileMetadataNote, type FileMetadataNoteInput } from '@undefineds.co/xpod-afs/workcopy/SolidFsMetaNotes'; import { buildWorkspaceSummaryPrompt, type WorkspaceSummaryPromptInput } from '@undefineds.co/xpod-afs/workcopy/WorkspacePrompt'; const note: FileMetadataNoteInput={subject:'#file',about:'./file',title:'File',description:'File',materializationClass:'byline-local'}; const summary: WorkspaceSummaryPromptInput={root:'/demo',authority:'local-filesystem',files:1,bylineLocalFiles:1,remotePlaceholders:0,hydratedRemoteObjects:0,tools:['stat']}; const outputs: string[]=[buildFileMetadataNote(note),buildWorkspaceSummaryPrompt(summary)]; void outputs;");
    const tsc = createRequire(path.join(afs, 'package.json')).resolve('typescript/bin/tsc');
    for (const [mode, module, resolution] of [['node16', 'Node16', 'Node16'], ['classic-node', 'ES2022', 'node']]) await run('helpers-types-' + mode, 'node', [tsc, '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2021', '--module', module, '--moduleResolution', resolution, 'helpers.ts'], consumer);
    fs.writeFileSync(path.join(consumer, 'consumer.mjs'), script);
    for (const runtime of ['node', 'bun']) await run('consumer-' + runtime, runtime, ['consumer.mjs'], consumer);
    fs.writeFileSync(path.join(consumer, 'client-identity.mjs'), "import * as client from '@undefineds.co/xpod-client'; import {createRequire} from 'node:module'; const canonical=createRequire(import.meta.url)('@undefineds.co/xpod-client'); for(const name of ['authFetch','requireAuthContext','loadCredentials','registerSolidAuthnSdkLoader','loadSolidAuthnSdk']) if(typeof client[name]!=='function'||client[name]!==canonical[name])throw Error('client identity:'+name); const sdk={Session:class Session{}}; let calls=0; client.registerSolidAuthnSdkLoader(async()=>{calls++;return sdk}); if(await client.loadSolidAuthnSdk()!==sdk||await canonical.loadSolidAuthnSdk()!==sdk||calls!==1)throw Error('SDK loader singleton'); console.log('canonical client and SDK loader identity passed');");
    for (const runtime of ['node', 'bun']) await run('client-identity-' + runtime, runtime, ['client-identity.mjs'], consumer);
    fs.writeFileSync(path.join(consumer, 'command-identity.mjs'), "import {agentFsCommand} from '@undefineds.co/xpod-afs/commands'; import {createRequire} from 'node:module'; import {registerSolidAuthnSdkLoader,loadSolidAuthnSdk} from '@undefineds.co/xpod-client'; const commands=createRequire(import.meta.url)('@undefineds.co/xpod-afs/commands'); if(commands.agentFsCommand!==agentFsCommand)throw Error('command namespace identity'); let calls=0; const sdk={Session:class Session{}}; registerSolidAuthnSdkLoader(async()=>{calls++;return sdk}); if(await loadSolidAuthnSdk()!==sdk||calls!==1)throw Error('public commands replaced host SDK'); console.log('public command ESM/CJS identity and no registration side effect passed');");
    for (const runtime of ['node', 'bun']) await run('command-identity-' + runtime, runtime, ['command-identity.mjs'], consumer);
    fs.writeFileSync(path.join(evidence, 'assessment.safe.json'), JSON.stringify({ passed: true, stages, inputs, copiedInputs, cliPackageInput: cliOriginal, publicToolsSHA256: { esm: sha(fs.readFileSync(path.join(cli, 'dist/build-tools.mjs'))), cjs: sha(fs.readFileSync(path.join(cli, 'dist/build-tools.cjs'))) }, frozenLockSHA256: sha(fs.readFileSync(path.join(source, 'bun.lock'))), clientPayloadSHA256: sha(fs.readFileSync(path.join(cli, 'dist/client.cjs'))), forbiddenServicePackagesAbsent: ['@solid/community-server', 'react', 'inngest'], models: { version: JSON.parse(fs.readFileSync(path.join(models, 'package.json'))).version, bundledInputs: modelInputs, runtimeDependencyGraphInstalled: true, consumerPurpose: 'Public declarations plus bundled pure constants; models transitive dependencies remain installed in the producer.' }, installLifecycle: 'ignore-scripts; three explicit SDK patches only', platformCapabilityPack: 'not-run; needs genuine native evidence/pins and public build-tools entry', realHelper: 'not-run', mount: 'not-run', published: false }, null, 2));
  } finally {
    if (stages.every(stage => stage.groupAbsent)) fs.rmSync(scratch, { recursive: true, force: true });
    fs.writeFileSync(path.join(evidence, 'closure.safe.json'), JSON.stringify({ scratchRemoved: !fs.existsSync(scratch), stages, copiedInputs }, null, 2));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
