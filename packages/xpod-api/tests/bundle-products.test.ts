import { API_BUILD_INTEGRATION_TIMEOUT_MS } from './repo-root';
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { apiRuntimeArtifacts, esmRuntimeEntry, packageRootAdapterVersion, workerAdapterVersion } from '../scripts/bundle-runtime';
import { bundleFile, verifyApiBundleProducts, type ApiBundleReceipt } from '../scripts/bundle-products';
import { nodeBuiltinAuthority } from '../scripts/node-builtins';

test('real Bun metafiles normalize root, package and outside build cwd to the same source authority', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'xpod-api-cwd-'));
  const repo = path.join(root, 'repo'), packageCwd = path.join(repo, 'packages/xpod-api'), outside = path.join(root, 'outside');
  for (const dir of [path.join(repo, 'src/api'), packageCwd, outside]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(repo, 'src/api/dep.ts'), 'export const value=1;');
  writeFileSync(path.join(repo, 'src/api/main.ts'), "export {value} from './dep';");
  const helper = fileURLToPath(new URL('../scripts/bundle-products.ts', import.meta.url));
  const script = path.join(root, 'probe.ts');
  writeFileSync(script, `import {normalizeApiMetafile} from ${JSON.stringify(helper)};const result=await Bun.build({entrypoints:[${JSON.stringify(path.join(repo, 'src/api/main.ts'))}],target:'node',format:'esm',metafile:true});if(!result.success)throw new AggregateError(result.logs);const meta=normalizeApiMetafile(${JSON.stringify(repo)},process.cwd(),result.metafile);console.log(JSON.stringify({inputs:Object.keys(meta.inputs).sort(),outputs:Object.values(meta.outputs).map(node=>({entry:node.entryPoint,inputs:Object.keys(node.inputs??{}).sort()}))}));`);
  try {
    const results = [repo, packageCwd, outside].map(cwd => {
      const result = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8', timeout: 15_000 });
      assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
    });
    assert.deepEqual(results[0].inputs, ['src/api/dep.ts', 'src/api/main.ts']);
    assert.deepEqual(results[0], results[1]); assert.deepEqual(results[1], results[2]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, API_BUILD_INTEGRATION_TIMEOUT_MS);

test('bundle receipts bind both entries, all metadata inputs, adapter identity and explicit externals', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'xpod-api-products-'));
  const out = path.join(root, 'build');
  mkdirSync(out);
  const put = (relative: string, contents: string) => { mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); writeFileSync(path.join(root, relative), contents); };
  const sources = ['src/api/main.ts', 'src/runtime/package-root.ts', 'src/api/runs/PiAgentRuntimeDriver.ts', apiRuntimeArtifacts.worker.source];
  writeFileSync(path.join(root, 'package.json'), '{"engines":{"node":">=22 <27"}}');
  put('packages/xpod-api/package.json', '{"dependencies":{}}');
  for (const source of sources) put(source, '// fixture authority ' + source);
  const receipt: ApiBundleReceipt = { schemaVersion: 1, products: [], nodeBuiltins: nodeBuiltinAuthority(['node:fs'], '>=22 <27'), runtimePackageManifest: bundleFile(root, 'packages/xpod-api/package.json') };
  for (const role of Object.keys(apiRuntimeArtifacts) as Array<keyof typeof apiRuntimeArtifacts>) {
    const artifact = apiRuntimeArtifacts[role];
    const implementation = path.basename(artifact.implementation), entry = path.basename(artifact.entry), metadata = role + '.inputs.json', rawMetadata = role + '.raw.inputs.json';
    writeFileSync(path.join(out, implementation), '/* controlled emitted fixture */');
    writeFileSync(path.join(out, entry), esmRuntimeEntry(artifact.implementation, artifact.entry));
    writeFileSync(path.join(out, metadata), JSON.stringify({ inputs: Object.fromEntries(sources.map(source => [source, {}])), outputs: { [implementation]: { imports: [{ path: 'node:fs', external: true }] } } }));
    writeFileSync(path.join(out, rawMetadata), readFileSync(path.join(out, metadata)));
    receipt.products.push({ role, implementation: bundleFile(out, implementation), entry: bundleFile(out, entry), metadata: bundleFile(out, metadata), rawMetadata: bundleFile(out, rawMetadata), buildCwdRelativeToRepo: '.', metadataNormalizationVersion: 'api-metafile-repo-v1', inputs: sources.map(source => bundleFile(root, source)), externals: ['node:fs'], runtimeImports: [], dynamicLoads: [],
      adapters: sources.filter(source => source !== 'src/api/main.ts').map(source => ({ source, sourceSHA256: bundleFile(root, source).sha256, adapterVersion: source === 'src/runtime/package-root.ts' ? packageRootAdapterVersion : workerAdapterVersion })) });
  }
  try {
    verifyApiBundleProducts(root, out, receipt, []);
    const changed = structuredClone(receipt);
    changed.products[1].adapters[0].adapterVersion = 'unknown-variant';
    assert.throws(() => verifyApiBundleProducts(root, out, changed, []), /adapter/);
    const missing = structuredClone(receipt);
    missing.products[0].inputs.pop();
    assert.throws(() => verifyApiBundleProducts(root, out, missing, []), /inventory/);
    const metadata = receipt.products[0].metadata.path;
    const originalMetadata = readFileSync(path.join(out, metadata));
    writeFileSync(path.join(out, metadata), JSON.stringify({ inputs: Object.fromEntries(sources.map(source => [source, {}])), outputs: { runtime: { imports: [{ path: 'unknown-external/subpath', external: true }] } } }));
    const unknown = structuredClone(receipt);
    unknown.products[0].metadata = bundleFile(out, metadata);
    writeFileSync(path.join(out, unknown.products[0].rawMetadata.path), readFileSync(path.join(out, metadata)));
    unknown.products[0].rawMetadata = bundleFile(out, unknown.products[0].rawMetadata.path);
    unknown.products[0].externals = ['unknown-external/subpath'];
    unknown.nodeBuiltins = nodeBuiltinAuthority(['node:fs', 'unknown-external/subpath'], '>=22 <27');
    assert.throws(() => verifyApiBundleProducts(root, out, unknown, []), /Undeclared/);
    writeFileSync(path.join(out, metadata), originalMetadata);
    writeFileSync(path.join(out, receipt.products[0].rawMetadata.path), originalMetadata);
    writeFileSync(path.join(out, receipt.products[1].implementation.path), 'changed emitted bytes');
    assert.throws(() => verifyApiBundleProducts(root, out, receipt, []), /drift/);
    writeFileSync(path.join(out, receipt.products[1].implementation.path), '/* controlled emitted fixture */');
    const dynamic = structuredClone(receipt);
    writeFileSync(path.join(out, dynamic.products[0].implementation.path), 'const name = process.argv[2]; await import(name);');
    dynamic.products[0].implementation = bundleFile(out, dynamic.products[0].implementation.path);
    assert.throws(() => verifyApiBundleProducts(root, out, dynamic, []), /Unqualified API dynamic/);
    writeFileSync(path.join(out, dynamic.products[0].implementation.path), '/* controlled emitted fixture */');
    put('src/runtime/package-root.ts', 'changed original input');
    assert.throws(() => verifyApiBundleProducts(root, out, receipt, []), /drift/);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, API_BUILD_INTEGRATION_TIMEOUT_MS);
