const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { collectWorkspaceRuntimeMaterials, chooseGeneratedProfile } = require('../../scripts/workspace-runtime-materials.cjs');
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const parent = path.resolve('.test-data/workspace-runtime-materials');
async function fixture(run) {
  fs.mkdirSync(parent, { recursive: true }); const root = fs.mkdtempSync(path.join(parent, 'case-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    for (const [name, bytes] of Object.entries({ 'package.json':'{}', 'README.md':'original readme', LICENSE:'original license', 'tsconfig.json':'{}', 'src/index.ts':'export const identity = {};' })) fs.writeFileSync(path.join(root, name), bytes);
    await run(root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('ignored fixture never claims its enclosing repository commit and inventory binds all copied source', () => fixture(async root => {
  const authority = await collectWorkspaceRuntimeMaterials({ packageRoot: root });
  assert.equal(authority.sourceCommit, null); assert.equal(authority.tracked, false);
  const dest = path.join(root, 'dist/materials'); const index = JSON.parse(fs.readFileSync(path.join(dest, 'index.json')));
  for (const row of index.files) { const bytes = fs.readFileSync(path.join(dest, row.path)); assert.equal(row.bytes, bytes.length); assert.equal(row.sha256, hash(bytes)); }
  assert.equal(fs.readFileSync(path.join(dest, 'source/LICENSE'), 'utf8'), 'original license');
  await assert.rejects(collectWorkspaceRuntimeMaterials({ packageRoot: root }), /already exists/);
}));
test('source symlink is rejected before material publication', () => fixture(async root => {
  fs.symlinkSync(path.join(root, 'LICENSE'), path.join(root, 'src/alias'));
  await assert.rejects(collectWorkspaceRuntimeMaterials({ packageRoot: root }), /symlink/);
  assert.equal(fs.existsSync(path.join(root, 'dist/materials')), false);
}));
test('dist symlink is rejected without writing through it', () => fixture(async root => {
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(root, 'dist'));
  await assert.rejects(collectWorkspaceRuntimeMaterials({ packageRoot: root }), /Unsafe material parent/);
  assert.deepEqual(fs.readdirSync(outside), []);
}));
test('unknown generated helper bytes never create a made-up profile', () => fixture(async root => {
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ prefixBytes: 3, prefixSha256: hash('old'), bunVersion: '1.4.2' }));
  fs.writeFileSync(path.join(root, 'payload.cjs'), 'new\n// src/index.ts\n');
  assert.throws(() => chooseGeneratedProfile(root, path.join(root, 'payload.cjs')), /no admitted/);
}));
test('strict admitted helper AST rejects changed expression and added control block', () => fixture(async root => {
  const { deriveGeneratedIndex } = require('../../scripts/workspace-runtime-materials.cjs');
  const originals = path.resolve('packages/xpod-cli/licenses/javascript/generated/1.4.2');
  const payload = path.join(root, 'payload.cjs');
  fs.writeFileSync(payload, 'var __create = Object.create;\n// controlled/source.ts\n');
  deriveGeneratedIndex(originals, payload, path.join(root, 'positive'));
  const result = JSON.parse(fs.readFileSync(path.join(root, 'positive/index.json')));
  assert.equal(result.provenance.derivation.algorithmVersion, 'helper-ast-v2');
  for (const [name, prefix] of [['expression', 'var __create = Object.getPrototypeOf;'], ['declaration', 'let __create = Object.create;'], ['regex', 'var __create = /changed/;'], ['template', 'var __create = `changed`;'], ['block', 'function __accessProp(key) { { return this[key]; } }']]) {
    fs.writeFileSync(payload, prefix + '\n// controlled/source.ts\n');
    assert.throws(() => deriveGeneratedIndex(originals, payload, path.join(root, name)), /differs from admitted/);
    assert.equal(fs.existsSync(path.join(root, name)), false);
  }
}));
test('fresh tracked Git source binds real commit and later edit is a dirty snapshot', () => fixture(async root => {
  const helper = path.join(root, 'collector.cjs'); fs.copyFileSync(path.resolve('scripts/workspace-runtime-materials.cjs'), helper);
  const git = args => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git(['init', '-q']); git(['add', '--', 'package.json', 'README.md', 'LICENSE', 'tsconfig.json', 'src', 'collector.cjs']);
  git(['-c', 'user.name=Controlled fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'controlled original material']);
  const local = require(helper); const head = git(['rev-parse', 'HEAD']);
  const first = await local.collectWorkspaceRuntimeMaterials({ packageRoot: root });
  assert.equal(first.sourceCommit, head); assert.equal(first.tracked, true); assert.equal(first.dirty, false);
  fs.rmSync(path.join(root, 'dist'), { recursive: true }); fs.appendFileSync(path.join(root, 'src/index.ts'), '\n// controlled edit\n');
  const edited = await local.collectWorkspaceRuntimeMaterials({ packageRoot: root });
  assert.equal(edited.sourceCommit, head); assert.equal(edited.dirty, true); assert.notEqual(edited.snapshotSHA256, first.snapshotSHA256);
  fs.rmSync(path.join(root, 'dist'), { recursive: true }); fs.unlinkSync(path.join(root, 'src/index.ts'));
  const deleted = await local.collectWorkspaceRuntimeMaterials({ packageRoot: root });
  assert.equal(deleted.dirty, true); assert.equal(deleted.tracked, false); assert.equal(deleted.sourceCommit, null); assert.equal(deleted.missingTrackedSourceCount, 1);
}));
test('production AST comparison preserves regex/template text and nested declaration kind', () => {
  const ts = require('typescript'); const { normalizeGeneratedNode } = require('../../scripts/workspace-runtime-materials.cjs');
  const normalized = text => normalizeGeneratedNode(ts, ts.createSourceFile('controlled.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
  for (const [before, after] of [
    ['const value = /safe/i;', 'const value = /unsafe/i;'],
    ['const value = `safe`;', 'const value = `unsafe`;'],
    ['const value = `safe${key}`;', 'const value = `unsafe${key}`;'],
    ['function helper(){var value=1;return value}', 'function helper(){let value=1;return value}'],
  ]) assert.notDeepEqual(normalized(before), normalized(after));
  assert.deepEqual(normalized('const value = (key);'), normalized('const value = key;'));
});
test('audited transformed toESM helper retains the shared base authority independently of preview selection', () => fixture(async root => {
  const ts = require('typescript');
  const { deriveGeneratedIndex } = require('../../scripts/workspace-runtime-materials.cjs');
  const originals = path.resolve('packages/xpod-cli/licenses/javascript/generated/1.4.2');
  const profile = JSON.parse(fs.readFileSync(path.join(originals, 'core.json')));
  const file = ts.createSourceFile('reviewed.js', fs.readFileSync(path.join(originals, profile.file.object), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = file.statements.find(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(node => node.name.text === '__toESM'));
  assert.ok(declaration);
  const payload = path.join(root, 'payload.cjs');
  fs.writeFileSync(payload, declaration.getText(file) + '\n// controlled/source.js\n');
  deriveGeneratedIndex(originals, payload, path.join(root, 'derived'));
  const result = JSON.parse(fs.readFileSync(path.join(root, 'derived/index.json')));
  assert.equal(result.provenance.derivation.helperAuthorities.find(row => row.name === '__toESM').sourceSHA256, profile.prefixSha256);
  fs.writeFileSync(payload, declaration.getText(file).replace('new WeakMap', 'new Map') + '\n// controlled/source.js\n');
  assert.throws(() => deriveGeneratedIndex(originals, payload, path.join(root, 'changed')), /differs from admitted/);
  assert.equal(fs.existsSync(path.join(root, 'changed')), false);
}));
