import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stagePhysicalService } from '../../scripts/lib/physical-module-stage';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'xpod-module-input-'));
  const output = mkdtempSync(path.join(tmpdir(), 'xpod-module-output-'));
  rmSync(output, { recursive: true });
  const put = (file: string, body: string) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  };
  put('package.json', JSON.stringify({ name: 'controlled-input', version: '1.0.0' }));
  put('LICENSE', 'controlled fixture license\n');
  return { root, output, put, cleanup: () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(root + '.removed', { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  } };
}

for (const extension of ['js', 'cjs', 'mjs']) test('JavaScript '+extension+' dependencies survive removal of original input tree on Node and Bun', () => {
  const f = fixture();
  try {
    f.put('src/api/main.ts', "import value from './bridge."+extension+"'; process.stdout.write(String(value));\n");
    f.put('src/api/bridge.'+extension, extension === 'mjs' ? "import value from 'actual-runtime'; export default value;\n" : "module.exports = require('actual-runtime');\n");
    f.put('node_modules/actual-runtime/package.json', JSON.stringify({ name: 'actual-runtime', version: '1.0.0', main: 'index.js' }));
    f.put('node_modules/actual-runtime/index.js', 'module.exports = 42;\n');
    const facts = stagePhysicalService(f.root, f.output, ['src/api/main.ts'], {
      entry: 'src/api/main.ts', moduleId: 'api', validateInputs: () => {},
    });
    assert.equal(facts.packages.some(p => p.name === 'actual-runtime'), true);
    renameSync(f.root, f.root + '.removed');
    for (const runtime of ['node', process.execPath]) {
      const result = spawnSync(runtime, [path.join(f.output, 'entry.mjs')], {
        cwd: tmpdir(), encoding: 'utf8', env: { PATH: process.env.PATH, NODE_PATH: '' },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '42');
    }
    const compiler = JSON.parse(readFileSync(path.join(f.output, 'provenance/compiler.json'), 'utf8'));
    assert.ok(compiler.compiledSources.some((s: { source: string }) => s.source === 'src/api/bridge.'+extension));
  } finally { f.cleanup(); }
});

test('nonliteral require cannot silently escape the physical dependency closure', () => {
  const f = fixture();
  try {
    f.put('src/api/main.ts', "const name = process.env.RUNTIME_PACKAGE; require(name);\n");
    assert.throws(() => stagePhysicalService(f.root, f.output, ['src/api/main.ts'], {
      entry: 'src/api/main.ts', moduleId: 'api', validateInputs: () => {},
    }), /Unqualified dynamic dependency/);
  } finally { f.cleanup(); }
});
