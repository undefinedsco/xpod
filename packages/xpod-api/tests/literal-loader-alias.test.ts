import { API_BUILD_INTEGRATION_TIMEOUT_MS } from './repo-root';
import { buildWithBun } from '../scripts/bun-build-api';
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { apiRuntimeArtifacts, esmRuntimeEntry, packageRootAdapterVersion, workerAdapterVersion } from '../scripts/bundle-runtime';
import { apiRuntimeImportDeclarations, runtimeImportBindings, apiBundleExternals, bundleFile, normalizeApiMetafile, unqualifiedApiDynamicLoads, verifyApiBundleProducts, type ApiBundleReceipt, type ApiMetafile } from '../scripts/bundle-products';
import { nodeBuiltinAuthority } from '../scripts/node-builtins';
import { stagePhysicalService } from '../../../scripts/lib/physical-module-stage';

test('actual Bun createRequire alias literals require declarations and enter the runtime closure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-api-loader-alias-')), output = root + '.product', out = path.join(root, 'build');
  const put = (relative: string, contents: string) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), contents); };
  put('package.json', '{"name":"fixture","version":"1.0.0","engines":{"node":">=22 <27"}}'); put('LICENSE', 'fixture');
  put('packages/xpod-api/package.json', '{"dependencies":{}}');
  put('src/runtime/package-root.ts', 'export {};'); put('src/api/runs/PiAgentRuntimeDriver.ts', 'export {};');
  put('src/api/runs/PiAgentRuntimeWorker.ts', "import '../../runtime/package-root';import './PiAgentRuntimeDriver';");
  fs.mkdirSync(out);
  async function produce(name: string, dynamic = false, style = 'alias'): Promise<ApiBundleReceipt> {
    const prefix = style === 'destructure' ? "import * as Module from 'node:module';const {createRequire:makeLoader}=Module;const loader=makeLoader(import.meta.url);"
      : style === 'chain' ? "import {createRequire} from 'node:module';" : "import {createRequire as makeLoader} from 'node:module';const loader=makeLoader(import.meta.url);";
    const call = style === 'chain' ? 'createRequire(import.meta.url)' : 'loader';
    put('src/api/main.ts', "import '../runtime/package-root';import './runs/PiAgentRuntimeDriver';import './runs/PiAgentRuntimeWorker';" + (style === 'static' ? 'import value from ' + JSON.stringify(name) + ';console.log(value);' : prefix + 'const value=' + call + '(' + (dynamic ? 'process.argv[2]' : JSON.stringify(name)) + ');console.log(value);'));
    const products: ApiBundleReceipt['products'] = [];
    for (const role of Object.keys(apiRuntimeArtifacts) as Array<keyof typeof apiRuntimeArtifacts>) {
      const artifact = apiRuntimeArtifacts[role], config = { entrypoints: [path.join(root, artifact.source)], target: 'node' as const, format: 'esm' as const, metafile: true, external: apiRuntimeImportDeclarations.filter(item => item.externalize).map(item => item.specifier) };
      const built = await buildWithBun(config); assert(built.success, String(built.logs));
      const raw = (built as typeof built & { metafile: ApiMetafile }).metafile, metadata = normalizeApiMetafile(root, process.cwd(), raw), emitted = await built.outputs[0].text();
      const implementation = path.basename(artifact.implementation), entry = path.basename(artifact.entry), meta = role + '.inputs.json', rawMeta = role + '.raw.inputs.json';
      for (const [file, contents] of [[implementation, emitted], [entry, esmRuntimeEntry(artifact.implementation, artifact.entry)], [meta, JSON.stringify(metadata)], [rawMeta, JSON.stringify(raw)]]) fs.writeFileSync(path.join(out, file), contents);
      const inputs = Object.keys(metadata.inputs).map(file => bundleFile(root, file));
      products.push({ role, implementation: bundleFile(out, implementation), entry: bundleFile(out, entry), metadata: bundleFile(out, meta), rawMetadata: bundleFile(out, rawMeta), buildCwdRelativeToRepo: path.relative(root, process.cwd()), metadataNormalizationVersion: 'api-metafile-repo-v1', inputs,
        externals: apiBundleExternals(metadata, emitted), runtimeImports: [], dynamicLoads: unqualifiedApiDynamicLoads(emitted),
        adapters: inputs.filter(row => row.path !== 'src/api/main.ts').map(row => ({ source: row.path, sourceSHA256: row.sha256, adapterVersion: row.path === 'src/runtime/package-root.ts' ? packageRootAdapterVersion : workerAdapterVersion })) });
    }
    return { schemaVersion: 1, products, runtimePackageManifest: bundleFile(root, 'packages/xpod-api/package.json'), nodeBuiltins: nodeBuiltinAuthority(products.flatMap(product => product.externals), '>=22 <27') };
  }
  try {
    for (const style of ['alias', 'destructure', 'chain']) {
      const unknown = await produce('not-declared-at-all', false, style);
      assert(unknown.products[0].externals.includes('not-declared-at-all'));
      assert.throws(() => verifyApiBundleProducts(root, out, unknown, []), /Undeclared API bundle external/);
    }
    put('packages/xpod-api/package.json', '{"dependencies":{"alias-dependency":"1.0.0"}}');
    put('node_modules/alias-dependency/package.json', '{"name":"alias-dependency","version":"1.0.0","main":"index.js"}'); put('node_modules/alias-dependency/index.js', 'module.exports=42;');
    const known = await produce('alias-dependency'); verifyApiBundleProducts(root, out, known, ['alias-dependency']);
    const main = known.products[0];
    const facts = stagePhysicalService(root, output, main.inputs.map(row => row.path), { entry: apiRuntimeArtifacts.main.source, moduleId: 'api', runtimePackages: ['alias-dependency'], runtimePackageManifest: known.runtimePackageManifest.path, validateInputs: () => {},
      bundle: { files: [{ source: 'build/' + main.implementation.path, destination: apiRuntimeArtifacts.main.implementation, sha256: main.implementation.sha256 }, { source: 'build/' + main.entry.path, destination: apiRuntimeArtifacts.main.entry, sha256: main.entry.sha256 }], verify: () => verifyApiBundleProducts(root, out, known, ['alias-dependency']) } });
    assert.deepEqual(facts.packages.map(item => item.name), ['alias-dependency']);
    const scopedOutput = output + '.scoped';
    put('package.json', '{"name":"fixture","version":"1.0.0","engines":{"node":">=22 <27"},"dependencies":{"@ai-sdk/provider-utils":"4.0.0"}}');
    put('node_modules/@ai-sdk/provider-utils/package.json', '{"name":"@ai-sdk/provider-utils","version":"4.0.0","exports":{"./helper":"./helper.js"}}');
    put('node_modules/@ai-sdk/provider-utils/helper.js', 'module.exports=43;');
    const scoped = await produce('@ai-sdk/provider-utils/helper', false, 'static');
    for (const product of scoped.products) product.runtimeImports = runtimeImportBindings(root, JSON.parse(fs.readFileSync(path.join(out, product.metadata.path), 'utf8')), product.externals);
    assert(scoped.products[0].externals.includes('@ai-sdk/provider-utils/helper'));
    assert.equal(scoped.products[0].runtimeImports[0].specifier, '@ai-sdk/provider-utils');
    verifyApiBundleProducts(root, out, scoped, ['alias-dependency']);
    const scopedMain = scoped.products[0];
    try {
      stagePhysicalService(root, scopedOutput, scopedMain.inputs.map(row => row.path), { entry: apiRuntimeArtifacts.main.source, moduleId: 'api', runtimePackageImports: scopedMain.runtimeImports, validateInputs: () => {},
        bundle: { files: [{ source: 'build/' + scopedMain.implementation.path, destination: apiRuntimeArtifacts.main.implementation, sha256: scopedMain.implementation.sha256 }, { source: 'build/' + scopedMain.entry.path, destination: apiRuntimeArtifacts.main.entry, sha256: scopedMain.entry.sha256 }], verify: () => verifyApiBundleProducts(root, out, scoped, ['alias-dependency']) } });
      fs.renameSync(root, root + '.hidden');
      try {
        for (const runtime of ['node', process.execPath]) {
          const result = spawnSync(runtime, [path.join(scopedOutput, 'entry.mjs')], {cwd: scopedOutput, encoding: 'utf8', env: {PATH: process.env.PATH, NODE_PATH: '', NODE_OPTIONS: ''}});
          assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), '43');
        }
      } finally { fs.renameSync(root + '.hidden', root); }
      for (const name of ['@ai-sdk/provider-utils-extra/helper', '@unknown/sdk/helper']) {
        const unknown = await produce(name);
        for (const product of unknown.products) product.runtimeImports = runtimeImportBindings(root, JSON.parse(fs.readFileSync(path.join(out, product.metadata.path), 'utf8')), product.externals);
        assert.equal(unknown.products[0].runtimeImports.length, 0);
        assert.throws(() => verifyApiBundleProducts(root, out, unknown, ['alias-dependency']), /Undeclared API bundle external/);
      }
    } finally { fs.rmSync(scopedOutput, {recursive: true, force: true}); }
    const dynamic = await produce('alias-dependency', true);
    assert.throws(() => verifyApiBundleProducts(root, out, dynamic, ['alias-dependency']), /Unqualified API dynamic/);
    fs.rmSync(root, { recursive: true });
    for (const runtime of ['node', process.execPath]) {
      const result = spawnSync(runtime, [path.join(output, 'entry.mjs')], { cwd: output, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_OPTIONS: '', NODE_PATH: '' } });
      assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), '42');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(output, { recursive: true, force: true }); }
}, API_BUILD_INTEGRATION_TIMEOUT_MS);
