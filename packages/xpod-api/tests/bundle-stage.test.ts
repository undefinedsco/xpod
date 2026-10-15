import { buildWithBun } from '../scripts/bun-build-api';
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stagePhysicalService, resolvePhysicalRuntimeImport } from '../../../scripts/lib/physical-module-stage';

test('Bun builtin shadows cannot replace installed ws or owner-specific Undici package identities', () => {
  const base = path.resolve('.test-data/api-builtin-package-roots'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'input-')), output = root + '.product';
  const put = (relative: string, content: string) => { mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); writeFileSync(path.join(root, relative), content); };
  const pkg = (directory: string, name: string, version: string, dependencies = {}) => { put(directory + '/package.json', JSON.stringify({ name, version, main: 'index.js', dependencies })); put(directory + '/index.js', 'module.exports={};'); };
  try {
    put('package.json', '{"name":"fixture","version":"1.0.0"}'); put('LICENSE', 'fixture'); put('src/api/main.ts', '// canonical fixture');
    pkg('node_modules/owner', 'owner', '1.0.0', { undici: '^5.29.0' });
    pkg('node_modules/undici', 'undici', '7.29.0'); pkg('node_modules/owner/node_modules/undici', 'undici', '5.29.0');
    pkg('node_modules/ws', 'ws', '7.0.0'); pkg('packages/capability/node_modules/ws', 'ws', '8.21.1');
    put('packages/capability/package.json', '{"name":"capability","version":"1.0.0","dependencies":{"ws":"8.21.1"}}');
    const imported = resolvePhysicalRuntimeImport(root, 'node_modules/owner/index.js', 'undici');
    assert.equal(JSON.parse(readFileSync(path.join(imported.root, 'package.json'), 'utf8')).version, '5.29.0');
    put('build/runtime.mjs', 'console.log(1);'); put('build/entry.mjs', "await import('./dist/runtime.mjs');");
    const files = [['build/runtime.mjs', 'dist/runtime.mjs'], ['build/entry.mjs', 'entry.mjs']].map(([source, destination]) => ({ source, destination, sha256: createHash('sha256').update(readFileSync(path.join(root, source))).digest('hex') }));
    const facts = stagePhysicalService(root, output, ['src/api/main.ts', 'node_modules/owner/index.js'], { entry: 'src/api/main.ts', moduleId: 'api', runtimePackages: ['ws'], runtimePackageManifest: 'packages/capability/package.json', runtimePackageImports: [imported.binding], bundle: { files, verify: () => {} }, validateInputs: () => {} });
    assert.deepEqual(facts.packages.map(row => [row.name, row.version]).sort(), [['undici', '5.29.0'], ['ws', '8.21.1']]);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(output, { recursive: true, force: true }); }
});

test('bundle stage preserves declared SDK identity without reseeding bundled metadata packages', async () => {
  const base = path.resolve('.test-data/api-bundle-stage'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'input-')), output = root + '.product';
  const put = (relative: string, content: string) => { mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); writeFileSync(path.join(root, relative), content); };
  const hash = (file: string) => createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex');
  try {
    put('package.json', '{"name":"controlled-api","version":"1.0.0"}'); put('LICENSE', 'fixture');
    put('src/api/main.ts', "import value from 'bundled-only';import other from 'other-owner';const load=new Function('name','return import(name)');console.log(value+other+(await load('runtime-sdk')).default+(await load('runtime-external')).default);");
    put('node_modules/bundled-only/package.json', '{"name":"bundled-only","version":"1.0.0","main":"index.js","dependencies":{"runtime-external":"^2.0.0"}}'); put('node_modules/bundled-only/index.js', 'module.exports=1;');
    put('node_modules/other-owner/package.json', '{"name":"other-owner","version":"1.0.0","main":"index.js","dependencies":{"runtime-external":"^1.0.0"}}'); put('node_modules/other-owner/index.js', 'module.exports=0;');
    put('node_modules/runtime-sdk/package.json', '{"name":"runtime-sdk","version":"1.0.0","main":"index.js","dependencies":{"runtime-external":"^1.0.0"}}'); put('node_modules/runtime-sdk/index.js', "module.exports=-59+require('runtime-external');");
    put('node_modules/runtime-external/package.json', '{"name":"runtime-external","version":"1.0.0","main":"index.js"}'); put('node_modules/runtime-external/index.js', 'module.exports=100;');
    put('node_modules/bundled-only/node_modules/runtime-external/package.json', '{"name":"runtime-external","version":"2.0.0","main":"index.js"}'); put('node_modules/bundled-only/node_modules/runtime-external/index.js', 'module.exports=1;');
    const config = { entrypoints: [path.join(root, 'src/api/main.ts')], target: 'node' as const, format: 'esm' as const, metafile: true };
    const built = await buildWithBun(config);
    assert(built.success, String(built.logs)); put('build/runtime.mjs', await built.outputs[0].text());
    put('build/entry.mjs', "import {createRequire} from 'node:module';globalThis.require=createRequire(import.meta.url);await import('./dist/runtime.mjs');");
    const files = [{ source: 'build/runtime.mjs', destination: 'dist/runtime.mjs', sha256: hash('build/runtime.mjs') }, { source: 'build/entry.mjs', destination: 'entry.mjs', sha256: hash('build/entry.mjs') }];
    const inputs = Object.keys((built as typeof built & { metafile: { inputs: Record<string, unknown> } }).metafile.inputs).map(file => path.relative(root, path.resolve(file)).replaceAll('\\', '/'));
    const external = { from: 'node_modules/bundled-only/index.js', specifier: 'runtime-external', ownerManifest: 'node_modules/bundled-only/package.json', ownerManifestSHA256: hash('node_modules/bundled-only/package.json'), resolvedManifestSHA256: hash('node_modules/bundled-only/node_modules/runtime-external/package.json') };
    const options = { entry: 'src/api/main.ts', moduleId: 'api', runtimePackages: ['runtime-sdk'], runtimePackageImports: [external, external], validateInputs: () => {}, bundle: { files, verify: () => {} } };
    assert.throws(() => stagePhysicalService(root, output, inputs, { ...options, bundle: { files, verify: () => { throw new Error('sourcekit/notice missing'); } } }), /sourcekit/);
    assert(!existsSync(output));
    assert.throws(() => stagePhysicalService(root, output, inputs, { ...options, runtimePackages: ['runtime-sdk', 'runtime-external'] }), /conflicting/);
    assert(!existsSync(output));
    const conflicting = { ...external, from: 'node_modules/other-owner/index.js', ownerManifest: 'node_modules/other-owner/package.json', ownerManifestSHA256: hash('node_modules/other-owner/package.json'), resolvedManifestSHA256: hash('node_modules/runtime-external/package.json') };
    assert.throws(() => stagePhysicalService(root, output, inputs, { ...options, runtimePackageImports: [external, conflicting] }), /conflicting/);
    assert(!existsSync(output));
    assert.throws(() => stagePhysicalService(root, output, inputs, { ...options, bundle: { ...options.bundle, files: [{ ...files[0], sha256: '0'.repeat(64) }, files[1]] } }), /binding/);
    assert(!existsSync(output));
    const facts = stagePhysicalService(root, output, inputs, options);
    assert.deepEqual(facts.packages.map(row => [row.name, row.version]).sort(), [['runtime-external', '1.0.0'], ['runtime-external', '2.0.0'], ['runtime-sdk', '1.0.0']]);
    assert.equal(JSON.parse(readFileSync(path.join(output, 'node_modules/runtime-external/package.json'), 'utf8')).version, '2.0.0');
    assert.equal(JSON.parse(readFileSync(path.join(output, 'node_modules/runtime-sdk/node_modules/runtime-external/package.json'), 'utf8')).version, '1.0.0');
    assert(!existsSync(path.join(output, 'node_modules/bundled-only')));
    assert(!existsSync(path.join(output, 'src/api/main.js')));
    assert(existsSync(path.join(output, 'source/src/api/main.ts')));
    rmSync(root, { recursive: true });
    for (const runtime of ['node', process.execPath]) {
      const run = spawnSync(runtime, [path.join(output, 'entry.mjs')], { cwd: output, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_PATH: '', NODE_OPTIONS: '' } });
      assert.equal(run.status, 0, run.stderr); assert.equal(run.stdout.trim(), '43');
    }
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(output, { recursive: true, force: true }); }
});
