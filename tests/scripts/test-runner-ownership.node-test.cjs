const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { testFileNames, isTestFile, ownership, vitestExcludedPaths, collectModuleTests } = require('../../scripts/test-runner-ownership.cjs');
test('every newly excluded physical module test has exactly one real runtime owner', () => {
  const root = path.resolve(__dirname, '../..'); const selected = collectModuleTests(root);
  const actual = [...selected.bun, ...selected.node]; assert.equal(new Set(actual).size, actual.length);
  const declared = [];
  for (const group of ownership.filter(g => g.gate === 'modules')) {
    const base = group.file ? [group.file] : fs.readdirSync(path.join(root, group.directory)).filter(isTestFile).map(f => group.directory + '/' + f);
    declared.push(...base.map(f => path.join(root, f)));
    assert.ok(vitestExcludedPaths.includes(group.file ?? group.directory + '/**'));
  }
  assert.deepEqual(actual.sort(), declared.sort());
  assert.ok(selected.node.length > 0); assert.ok(selected.bun.length > 0);
  for (const group of ownership.filter(g => g.gate === 'existing-package')) assert.equal(actual.some(f => f.includes(group.directory)), false);
  assert.throws(() => collectModuleTests(root, 'unknown'), /Unknown module test group/);
});
test('a new file with an ambiguous or absent runner fails selection rather than silently disappearing', () => {
  const base = path.resolve('.test-data/test-runner-ownership'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'case-'));
  try {
    const dir = path.join(root, ownership.find(g => g.name === 'api').directory); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'positive.test.ts'), "import {test} from 'node:test';");
    assert.equal(collectModuleTests(root, 'api').node.length, 1);
    const fresh = path.join(dir, 'new.test.ts'); fs.writeFileSync(fresh, 'export const noRunner=1;');
    assert.throws(() => collectModuleTests(root, 'api'), /missing test runner/);
    fs.writeFileSync(fresh, "import {test} from 'node:test'; import {expect} from 'bun:test';");
    assert.throws(() => collectModuleTests(root, 'api'), /Ambiguous/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('all Vitest test/spec suffixes are owned, including new spec.ts and test.js files', () => {
  const base = path.resolve('.test-data/test-runner-ownership'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'suffix-'));
  try {
    const dir = path.join(root, ownership.find(g => g.name === 'api').directory); fs.mkdirSync(dir, { recursive: true });
    for (const kind of testFileNames.kinds) for (const extension of testFileNames.extensions) {
      const name = `fresh.${kind}.${extension}`;
      fs.writeFileSync(path.join(dir, name), "import { test } from 'node:test';");
    }
    const result = collectModuleTests(root, 'api');
    assert.equal(result.node.length, testFileNames.kinds.length * testFileNames.extensions.length);
    assert.equal(new Set(result.node).size, result.node.length);
    assert.ok(result.node.some(p => p.endsWith('.spec.ts')));
    assert.ok(result.node.some(p => p.endsWith('.test.js')));
    for (const name of ['lost.spec.ts', 'lost.test.js']) {
      fs.writeFileSync(path.join(dir, name), 'export const missingRunner = 1;');
      assert.throws(() => collectModuleTests(root, 'api'), /missing test runner/);
      fs.unlinkSync(path.join(dir, name));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
