import { buildWithBun } from '../scripts/bun-build-api';
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { adaptPackageRoot, packageRootBundlePlugin, adaptPiWorkerDriver, adaptPiWorkerEntry, apiRuntimeArtifacts } from '../scripts/bundle-runtime';

test('worker path adapter preserves explicit overrides and rejects changed default contracts', async () => {
  const source = "import path from 'node:path'; const PACKAGE_ROOT='/installed-api'; export class PiAgentRuntimeDriver { constructor(private options={workerPath:undefined}){} private resolveWorkerPath():string { if(this.options.workerPath){return this.options.workerPath;}return path.join(__dirname,`PiAgentRuntimeWorker${path.extname(__filename)}`); }}";
  const adapted = adaptPiWorkerDriver(source);
  const base = mkdtempSync(path.join(tmpdir(), 'xpod-api-driver-'));
  try {
    // Use the actual normal bundler on the transformed source, then execute outside its input location.
    writeFileSync(path.join(base, 'driver.ts'), adapted.contents);
    const built = await buildWithBun({ entrypoints: [path.join(base, 'driver.ts')], target: 'node', format: 'esm' });
    assert(built.success, String(built.logs));
    writeFileSync(path.join(base, 'driver.mjs'), await built.outputs[0].text());
    rmSync(path.join(base, 'driver.ts'));
    writeFileSync(path.join(base, 'check.mjs'), `import assert from 'node:assert/strict';import {PiAgentRuntimeDriver as Driver} from './driver.mjs';assert.equal(new Driver().resolveWorkerPath(),${JSON.stringify(path.join('/installed-api', apiRuntimeArtifacts.worker.entry))});assert.equal(new Driver({workerPath:'/explicit/worker.cjs'}).resolveWorkerPath(),'/explicit/worker.cjs');`);
    for (const runtime of ['node', process.execPath]) {
      const run = spawnSync(runtime, [path.join(base, 'check.mjs')], { cwd: tmpdir(), encoding: 'utf8', env: { PATH: process.env.PATH, NODE_OPTIONS: '', NODE_PATH: '' } });
      assert.equal(run.status, 0, run.stderr);
    }
    assert.throws(() => adaptPiWorkerDriver(source.replace('path.join(__dirname,', 'path.resolve(__dirname,')));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('worker entry adapter refuses ambiguous guards and altered error handlers', () => {
  const source = 'async function main() {} if(require.main===module){main().catch(error=>{process.exitCode=1;});}';
  assert(adaptPiWorkerEntry(source).contents.includes('realpathSync'));
  assert.throws(() => adaptPiWorkerEntry(source.replace('main().catch', 'other().catch')));
  assert.throws(() => adaptPiWorkerEntry(source + ' if(require.main===module){main().catch(error=>{});}'));
  assert.throws(() => adaptPiWorkerEntry(source.replace('require.main===module', 'true')));
});

test('API root adapter rejects changed or ambiguous canonical initializers', () => {
  for (const source of [
    'export const PACKAGE_ROOT = process.cwd();',
    'export const PACKAGE_ROOT = findPackageRoot(__dirname, platform);',
    'export const PACKAGE_ROOT = findPackageRoot(__dirname); export const PACKAGE_ROOT = findPackageRoot(__dirname);',
    'export const OTHER_ROOT = findPackageRoot(__dirname);',
  ]) assert.throws(() => adaptPackageRoot(source));
});

test('API bundle locates its installed root and retains the injected platform contract', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'xpod-api-bundle-'));
  const input = path.join(base, 'input');
  const product = path.join(base, 'product');
  mkdirSync(path.join(input, 'src/runtime'), { recursive: true });
  mkdirSync(path.join(product, 'dist'), { recursive: true });
  const source = "import path from 'node:path'; import fs from 'node:fs';\nexport function findPackageRoot(dir, platform={dirname:path.dirname,joinPath:path.join,fileExists:fs.existsSync}) {let current=dir;while(current!==platform.dirname(current)){if(platform.fileExists(platform.joinPath(current,'package.json')))return current;current=platform.dirname(current);}return dir;}\nexport const PACKAGE_ROOT = findPackageRoot(__dirname);\n";
  const canonical = path.join(input, 'src/runtime/package-root.ts');
  writeFileSync(canonical, source);
  writeFileSync(path.join(product, 'package.json'), '{"type":"module"}');
  const receipts: unknown[] = [];
  try {
    const result = await buildWithBun({ entrypoints: [canonical], target: 'node', format: 'esm',
      plugins: [packageRootBundlePlugin(input, receipt => receipts.push(receipt))] });
    assert.equal(result.success, true, String(result.logs));
    assert.equal(receipts.length, 1);
    assert.equal(readFileSync(canonical, 'utf8'), source);
    writeFileSync(path.join(product, 'dist/runtime.mjs'), await result.outputs[0].text());
    rmSync(input, { recursive: true });
    writeFileSync(path.join(product, 'check.mjs'), "import {PACKAGE_ROOT,findPackageRoot} from './dist/runtime.mjs';import fs from 'node:fs';import path from 'node:path';if(fs.realpathSync(PACKAGE_ROOT)!==process.argv[2])throw Error('wrong installed root');if(findPackageRoot('/fake/deep',{dirname:path.dirname,joinPath:path.join,fileExists:p=>p==='/fake/package.json'})!=='/fake')throw Error('platform contract changed');");
    for (const runtime of ['node', process.execPath]) {
      const run = spawnSync(runtime, [path.join(product, 'check.mjs'), realpathSync(product)], {
        cwd: tmpdir(), encoding: 'utf8', env: { PATH: process.env.PATH, NODE_PATH: '', NODE_OPTIONS: '' },
      });
      assert.equal(run.status, 0, run.stderr);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('Observable adapter narrows only the canonical superclass import and fails on drift', async () => {
  const { adaptObservableStore, observableStoreBundlePlugin } = await import('../scripts/bundle-runtime');
  const source = "import { PassthroughStore } from '@solid/community-server';\nimport type { ResourceStore } from '@solid/community-server';\nexport class ObservableResourceStore<T extends ResourceStore> extends PassthroughStore<T> {}\n";
  const adapted = adaptObservableStore(source);
  assert.equal(adapted.contents, source.replace("from '@solid/community-server';", 'from "@solid/community-server/dist/storage/PassthroughStore";'));
  for (const changed of [source.replace('{ PassthroughStore }', '{ PassthroughStore, Other }'), source.replace('extends PassthroughStore<T>', 'extends Other<T>'), source + "import { Other } from '@solid/community-server';", source.replace('PassthroughStore }', 'PassthroughStore as Base }')]) assert.throws(() => adaptObservableStore(changed));
  const base = mkdtempSync(path.join(tmpdir(), 'xpod-observable-adapter-'));
  try {
    const canonical = path.join(base, 'src/storage/ObservableResourceStore.ts');
    mkdirSync(path.dirname(canonical), { recursive: true });
    writeFileSync(canonical, source);
    const callbacks: Array<(args: { path: string }) => any> = [];
    const receipts: any[] = [];
    observableStoreBundlePlugin(base, row => receipts.push(row)).setup({onLoad(_options, callback) { callbacks.push(callback); }});
    const unrelated = path.join(base, 'ObservableResourceStore.ts');
    writeFileSync(unrelated, source);
    assert.equal(callbacks[0]({path: unrelated}), undefined);
    assert.equal(callbacks[0]({path: canonical}).contents, adapted.contents);
    assert.equal(receipts[0].sourceSHA256, adapted.sourceSHA256);
    assert.equal(readFileSync(canonical, 'utf8'), source);
  } finally { rmSync(base, {recursive: true, force: true}); }
});
