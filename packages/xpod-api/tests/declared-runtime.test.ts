import { API_BUILD_INTEGRATION_TIMEOUT_MS } from './repo-root';
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { stagePhysicalService } from '../../../scripts/lib/physical-module-stage';

// The manifest is the same sole declaration read by the real API producer.
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const runtimePackages = Object.keys(manifest.dependencies);

test('capability manifest resolves its installed SDK instead of a different repository root version', () => {
  const base = path.resolve('.test-data/api-capability-owner'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'input-')), output = root + '.product';
  const put = (relative: string, content: string) => { mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); writeFileSync(path.join(root, relative), content); };
  try {
    put('package.json', '{"name":"fixture","version":"1.0.0"}'); put('LICENSE', 'fixture');
    put('src/api/main.ts', "const load=new Function('name','return import(name)');load('runtime-sdk').then(value=>console.log(value.default));");
    put('packages/capability/package.json', '{"name":"capability","version":"1.0.0","dependencies":{"runtime-sdk":"2.0.0"}}');
    for (const [directory, version, value] of [['node_modules/runtime-sdk', '1.0.0', 1], ['packages/capability/node_modules/runtime-sdk', '2.0.0', 42]] as const) {
      put(directory + '/package.json', JSON.stringify({ name: 'runtime-sdk', version, main: 'index.js' })); put(directory + '/index.js', 'module.exports=' + value + ';');
    }
    const facts = stagePhysicalService(root, output, ['src/api/main.ts'], { entry: 'src/api/main.ts', moduleId: 'api', runtimePackages: ['runtime-sdk'], runtimePackageManifest: 'packages/capability/package.json', validateInputs: () => {} });
    assert.deepEqual(facts.packages.map(row => row.version), ['2.0.0']);
    rmSync(root, { recursive: true });
    for (const runtime of ['node', process.execPath]) {
      const result = spawnSync(runtime, [path.join(output, 'entry.mjs')], { cwd: output, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_PATH: '', NODE_OPTIONS: '' } });
      assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), '42');
    }
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(output, { recursive: true, force: true }); }
}, API_BUILD_INTEGRATION_TIMEOUT_MS);

test('API native-import SDK uses declared runtime packages and their transitive closure outside the input tree', () => {
  assert.equal(manifest.dependencies['@mariozechner/pi-coding-agent'], '^0.55.1');
  const root = mkdtempSync(path.join(tmpdir(), 'xpod-api-input-'));
  const output = mkdtempSync(path.join(tmpdir(), 'xpod-api-output-'));
  rmSync(output, { recursive: true });
  const put = (file: string, body: string) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  };
  try {
    put('package.json', JSON.stringify({ name: 'controlled-api', version: '1.0.0' }));
    put('LICENSE', 'controlled fixture license\n');
    put('src/api/main.ts', "const nativeImport = new Function('specifier', 'return import(specifier)'); nativeImport('@mariozechner/pi-coding-agent').then(sdk => process.stdout.write(String(sdk.default)));\n");
    for (const name of runtimePackages) {
      put('node_modules/'+name+'/package.json', JSON.stringify({ name, version: '1.0.0', main: 'index.js', dependencies: name === '@mariozechner/pi-coding-agent' ? { 'sdk-leaf': '1.0.0' } : {} }));
      // Mature dependency libraries can use declared dynamic require paths.
      put('node_modules/'+name+'/index.js', name === '@mariozechner/pi-coding-agent' ? "const name = 'sdk-leaf'; module.exports = require(name);\n" : 'module.exports = {};\n');
    }
    put('node_modules/sdk-leaf/package.json', JSON.stringify({ name: 'sdk-leaf', version: '1.0.0', main: 'index.js' }));
    put('node_modules/sdk-leaf/index.js', 'module.exports = 42;\n');
    const facts = stagePhysicalService(root, output, ['src/api/main.ts'], {
      entry: 'src/api/main.ts', moduleId: 'api', runtimePackages, validateInputs: () => {},
    });
    assert.ok(facts.packages.some(p => p.name === 'sdk-leaf'));
    renameSync(root, root + '.removed');
    for (const runtime of ['node', process.execPath]) {
      const result = spawnSync(runtime, [path.join(output, 'entry.mjs')], {
        cwd: tmpdir(), encoding: 'utf8', env: { PATH: process.env.PATH, NODE_PATH: '' },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '42');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(root + '.removed', { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
}, API_BUILD_INTEGRATION_TIMEOUT_MS);

test('declared dynamic SDK retains its exact identity when another version is more referenced', () => {
  const base = path.resolve('.test-data/api-declared-identity');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'input-'));
  const output = root + '.product';
  const put = (file: string, body: string) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  };
  const sdk = '@mariozechner/pi-coding-agent';
  const pkg = (dir: string, name: string, version: string, body: string, dependencies = {}) => {
    put(dir+'/package.json', JSON.stringify({ name, version, main: 'index.js', dependencies }));
    put(dir+'/index.js', body);
  };
  try {
    put('package.json', JSON.stringify({ name: 'controlled-api', version: '1.0.0' }));
    put('LICENSE', 'controlled fixture license\n');
    put('src/api/main.ts', "const load = new Function('name', 'return import(name)'); Promise.all([load('@mariozechner/pi-coding-agent'), load('consumer-a'), load('consumer-b')]).then(values => process.stdout.write(values.map(v => v.default).join(',')));\n");
    pkg('node_modules/'+sdk, sdk, '1.0.0', "module.exports = 'declared';\n");
    for (const name of ['consumer-a', 'consumer-b']) {
      pkg('node_modules/'+name, name, '1.0.0', "module.exports = require('@mariozechner/pi-coding-agent');\n", { [sdk]: '2.0.0' });
      pkg('node_modules/'+name+'/node_modules/'+sdk, sdk, '2.0.0', "module.exports = 'nested';\n");
    }
    const facts = stagePhysicalService(root, output, ['src/api/main.ts'], {
      entry: 'src/api/main.ts', moduleId: 'api', runtimePackages: [sdk, 'consumer-a', 'consumer-b'], validateInputs: () => {},
    });
    assert.equal(JSON.parse(readFileSync(path.join(output, 'node_modules', sdk, 'package.json'), 'utf8')).version, '1.0.0');
    assert.deepEqual([...new Set(facts.packages.filter(p => p.name === sdk).map(p => p.version))].sort(), ['1.0.0', '2.0.0']);
    renameSync(root, root + '.removed');
    for (const runtime of ['node', process.execPath]) {
      const result = spawnSync(runtime, [path.join(output, 'entry.mjs')], {
        cwd: base, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_PATH: '' },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'declared,nested,nested');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(root + '.removed', { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
}, API_BUILD_INTEGRATION_TIMEOUT_MS);
