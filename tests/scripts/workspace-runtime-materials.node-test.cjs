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

// Collector location regression only: this fixture's Bun/build-tools are tiny
// protocol stubs, never a real compiler, build, legal or source qualification.
function noGitBundleFixture(root, installed, explicit) {
  const workspace = path.join(root, 'workspace'), pkg = path.join(workspace, 'packages/fixture');
  const cli = installed ? path.join(workspace, 'node_modules/@undefineds.co/xpod-cli') : path.join(workspace, 'packages/xpod-cli');
  for (const directory of [pkg, cli, path.join(workspace, 'scripts'), path.join(workspace, 'bin'), path.join(workspace, 'node_modules')]) fs.mkdirSync(directory, {recursive:true});
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({name:'@undefineds.co/xpod',workspaces:['packages/*']}));
  for (const [name,bytes] of Object.entries({'package.json':'{}','README.md':'fixture',LICENSE:'fixture','tsconfig.json':'{}','src/index.ts':'export {}'})) {
    const file=path.join(pkg,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
  }
  const tools=path.join(cli,'dist/build-tools/index.cjs');fs.mkdirSync(path.dirname(tools),{recursive:true});
  fs.writeFileSync(path.join(cli,'package.json'),JSON.stringify({name:'@undefineds.co/xpod-cli',exports:{'./build-tools':'./dist/build-tools/index.cjs'}}));
  const captured=path.join(workspace,'notices-call.json');
  // Stub only the build-tool calls used here; these cases verify physical tool
  // roots and no-Git provenance rather than metafile canonicalisation.
  fs.writeFileSync(tools,`exports.canonicalBuildMetafile=raw=>Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8')),null,2)+'\\n');
exports.collectJavascriptNotices=o=>{require('node:fs').writeFileSync(${JSON.stringify(captured)},JSON.stringify(o));require('node:fs').mkdirSync(o.destination,{recursive:true});};`);
  if (!installed) {const link=path.join(workspace,'node_modules/@undefineds.co/xpod-cli');fs.mkdirSync(path.dirname(link),{recursive:true});fs.symlinkSync(cli,link,'dir');}
  const generated=explicit?path.join(workspace,'explicit-originals'):path.join(cli,'licenses/javascript/generated/1.4.2');fs.mkdirSync(generated,{recursive:true});
  fs.writeFileSync(path.join(generated,'index.json'),JSON.stringify({bunVersion:'1.4.2',prefixBytes:4,prefixSha256:hash('head')}));
  fs.mkdirSync(path.join(pkg,'dist'),{recursive:true});fs.writeFileSync(path.join(pkg,'dist/payload.cjs'),'head\n// fixture.ts\n');
  // The collector canonicalises this minimal, valid metafile before collection.
  fs.writeFileSync(path.join(pkg,'dist/meta.json'),JSON.stringify({inputs:{'src/index.ts':{bytes:1,imports:[]}},outputs:{'dist/payload.cjs':{bytes:1,imports:[],inputs:{'src/index.ts':{bytesInOutput:1},exports:[]}}}}));
  const helper=path.join(workspace,'scripts/workspace-runtime-materials.cjs');fs.copyFileSync(path.resolve(process.env.XPOD_COLLECTOR_TEST_IMPLEMENTATION??'scripts/workspace-runtime-materials.cjs'),helper);
  const bun=path.join(workspace,'bin/bun');fs.writeFileSync(bun,`#!/bin/sh\ncase "$1" in --version) printf '1.4.2\\n';; --revision) printf 'fixture-revision\\n';; -e) printf '%s' '${bun}';; *) exit 99;; esac\n`,{mode:0o700});
  const child=path.join(workspace,'run.cjs');fs.writeFileSync(child,`require(${JSON.stringify(helper)}).collectWorkspaceRuntimeMaterials({packageRoot:process.cwd(),bundles:[{name:'fixture',payload:'dist/payload.cjs',metafile:'dist/meta.json'}],${explicit?'generated:'+JSON.stringify(generated):''}}).then(x=>process.stdout.write(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exitCode=1;});`);
  const env={...process.env,PATH:path.dirname(bun)+path.delimiter+process.env.PATH,GIT_CEILING_DIRECTORIES:path.dirname(workspace)};
  const absent=spawnSync('git',['rev-parse','--show-toplevel'],{cwd:pkg,env,encoding:'utf8'});assert.notEqual(absent.status,0,'fixture must really have no enclosing Git authority');
  const result=spawnSync(process.execPath,[child],{cwd:pkg,env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  const authority=JSON.parse(result.stdout);assert.equal(authority.sourceCommit,null);assert.equal(authority.tracked,false);assert.equal(authority.dirty,null);
  const notices=JSON.parse(fs.readFileSync(captured,'utf8'));assert.equal(notices.generated,generated);assert.equal(notices.repoRoot,workspace);
}
test('no-Git workspace resolves originals and notice dependency root from physical CLI build tools, not package cwd',()=>fixture(async root=>noGitBundleFixture(root,false,false)));
test('published CLI tool package and explicit generated override remain usable without Git authority',()=>fixture(async root=>{noGitBundleFixture(root,true,true);}));
