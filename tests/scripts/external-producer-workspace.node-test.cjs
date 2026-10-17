const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { withExternalProducerWorkspace } = require('../../scripts/lib/external-producer-workspace.cjs');
async function fixture(operation) {
  const parent = path.resolve('.test-data/external-layout'); fs.mkdirSync(parent, { recursive: true }); const root = fs.mkdtempSync(path.join(parent, 'case-'));
  try { await operation(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('actual tiny upstream without config inherits a nested host setup but isolated normal test does not', () => fixture(async root => {
  const host = path.join(root, 'host'); fs.mkdirSync(host);
  fs.writeFileSync(path.join(host, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  fs.writeFileSync(path.join(host, 'vitest.config.ts'), "export default {test:{setupFiles:['./missing-host-setup.ts'],include:['source.test.ts'],pool:'forks',maxWorkers:1,minWorkers:1}};");
  const populate = directory => {
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'tiny-upstream', version: '1.0.0', type: 'module', scripts: { test: 'vitest --run --maxWorkers=1 --minWorkers=1' } }));
    fs.writeFileSync(path.join(directory, 'source.test.ts'), "import {test,expect} from 'vitest';test('tiny upstream',()=>expect(2+2).toBe(4));");
    fs.symlinkSync(path.resolve('node_modules'), path.join(directory, 'node_modules'), 'dir');
  };
  const nested = path.join(host, 'nested'); fs.mkdirSync(nested); populate(nested);
  const inherited = spawnSync('bun', ['run', 'test'], { cwd: nested, encoding: 'utf8', timeout: 15000 });
  assert.notEqual(inherited.status, 0); assert.match(inherited.stdout + inherited.stderr, /missing-host-setup/);
  let isolated;
  const result = await withExternalProducerWorkspace(host, async directory => {
    isolated = directory; populate(directory);
    const original = spawnSync('bun', ['run', 'test'], { cwd: directory, encoding: 'utf8', timeout: 15000 });
    assert.equal(original.status, 0, original.stdout + original.stderr); assert.match(original.stdout, /1 passed/);
    return 'original upstream test passed';
  });
  assert.equal(result.value, 'original upstream test passed'); assert.equal(result.cleanup.removed, true); assert.equal(fs.existsSync(isolated), false);
}));
test('an OS temporary parent inside the host is refused rather than overriding upstream config', () => fixture(async host => {
  const temporary = path.join(host, 'tmp'); fs.mkdirSync(temporary); const original = os.tmpdir; let called = false;
  try { os.tmpdir = () => temporary; await assert.rejects(withExternalProducerWorkspace(host, async () => { called = true; }), /inside the host/); }
  finally { os.tmpdir = original; }
  assert.equal(called, false); assert.deepEqual(fs.readdirSync(temporary), []);
}));
test('upstream failure is preserved and isolated cleanup refuses a replaced source root', () => fixture(async host => {
  const primary = new Error('actual upstream failure'); let ordinary;
  await assert.rejects(withExternalProducerWorkspace(host, async directory => { ordinary = directory; fs.writeFileSync(path.join(directory, 'source'), 'original'); throw primary; }), error => error === primary);
  assert.equal(fs.existsSync(ordinary), false);
  let replaced;
  try {
    await assert.rejects(withExternalProducerWorkspace(host, async directory => {
      replaced = directory; fs.writeFileSync(path.join(directory, 'source'), 'original'); fs.renameSync(directory, directory + '.original'); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'replacement'), 'keep'); throw primary;
    }), error => error instanceof AggregateError && error.errors[0] === primary && error.cause === primary && error.errors[1].message.includes('ownership changed'));
    assert.equal(fs.readFileSync(path.join(replaced, 'replacement'), 'utf8'), 'keep'); assert.equal(fs.readFileSync(path.join(replaced + '.original', 'source'), 'utf8'), 'original');
  } finally {
    if (replaced) { fs.rmSync(replaced, { recursive: true, force: true }); fs.rmSync(replaced + '.original', { recursive: true, force: true }); }
  }
}));
