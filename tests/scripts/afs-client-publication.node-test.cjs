const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { emitClientPublication } = require('../../packages/xpod-afs/scripts/client-publication.cjs');
const { normalizeWorkspaceDependencies } = require('../../scripts/workspace-package-pack.cjs');
function fixture(run) {
  const parent = path.resolve(__dirname, '../../.test-data/afs-client-publication');fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'case-')), pkg = path.join(root, 'packages/xpod-afs'), destination = path.join(root, 'stage');
  const write = (name, data) => { const file = path.join(pkg, name);fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data)); };
  try {
    fs.mkdirSync(pkg, { recursive: true });fs.writeFileSync(path.join(root, 'LICENSE'), 'license');
    write('package.json', { name: '@undefineds.co/xpod-afs', version: '1.0.0', private: true, type: 'module', exports: { '.': { import: './dist/index.mjs', types: './dist/types/index.d.ts' }, './package.json': './package.json' }, main: './dist/index.mjs', types: './dist/types/index.d.ts', dependencies: { '@fixture/client': 'workspace:*' }, scripts: { build: 'never run' }, devDependencies: { tool: '1.0.0' } });
    fs.mkdirSync(path.join(root, 'packages/client'), { recursive: true });fs.writeFileSync(path.join(root, 'packages/client/package.json'), JSON.stringify({ name: '@fixture/client', version: '2.0.0' }));
    write('dist/index.mjs', "export * from './runtime.mjs';");write('dist/runtime.mjs', "import library from './library.cjs'; export const run=library.run;");write('dist/library.cjs', 'exports.run=()=>1;');
    write('dist/entry.mjs', "import './command-host.mjs'; import './runtime.mjs';");write('dist/command-host.mjs', "export const run=1;");
    write('dist/types/index.d.ts', 'export declare const run: number;');write('dist/components/context.jsonld', {});write('README.md', 'readme');
    const notice = Buffer.from('notice'), hash = crypto.createHash('sha256').update(notice).digest('hex');
    write('dist/licenses/objects/' + hash + '.txt', notice);write('dist/licenses/index.json', { files: [{ object: 'objects/' + hash + '.txt', sha256: hash }] });
    let checks = 0;const options = { packageRoot: pkg, repoRoot: root, destination, assertCurrent: () => { checks++; } };
    run({ root, pkg, destination, write, options, checks: () => checks });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('stages explicit JS distribution, launcher entry and original source without claiming admission', () => fixture(({ pkg, destination, options, checks }) => {
  const original = fs.readFileSync(path.join(pkg, 'package.json'));
  const result = emitClientPublication(options);
  assert.equal(result.manifest.private, false);assert.equal(result.manifest.dependencies['@fixture/client'], '2.0.0');assert.equal(result.manifest.scripts, undefined);
  assert.deepEqual(fs.readFileSync(path.join(pkg, 'package.json')), original);assert.deepEqual(fs.readFileSync(path.join(destination, 'provenance/source-package.json')), original);
  for (const name of ['dist/entry.mjs','dist/command-host.mjs','dist/library.cjs','dist/runtime.mjs']) assert.ok(result.inventory.some(x => x.path === name));
  for (const key of ['buildQualified','consumerQualified','sourceQualified','releaseQualified']) assert.equal(result[key], false);
  assert.equal(checks(), 3);
}));
for (const missing of ['dist/entry.mjs','dist/command-host.mjs','dist/runtime.mjs']) test('rejects missing launcher closure: ' + missing, () => fixture(({ pkg, options, destination }) => {
  fs.unlinkSync(path.join(pkg, missing));assert.throws(() => emitClientPublication(options));assert.equal(fs.existsSync(destination), false);
}));
test('rejects missing notice object and changed notice hash', () => {
  for (const remove of [true, false]) fixture(({ pkg, options, destination }) => {
    const object = path.join(pkg, 'dist/licenses/objects', fs.readdirSync(path.join(pkg, 'dist/licenses/objects'))[0]);
    if (remove) fs.unlinkSync(object);else fs.writeFileSync(object, 'changed');
    assert.throws(() => emitClientPublication(options), /notice object/);assert.equal(fs.existsSync(destination), false);
  });
});
test('normalizer rejects wrong workspace identity/version and file/link edges', () => fixture(({ root }) => {
  const normal = { dependencies: { '@fixture/client': 'workspace:*' } };
  for (const bad of [{ name: '@fixture/other', version: '2.0.0' }, { name: '@fixture/client', version: 'workspace:*' }]) {
    fs.writeFileSync(path.join(root,'packages/client/package.json'), JSON.stringify(bad));assert.throws(() => normalizeWorkspaceDependencies(root, normal), /mismatch/);
  }
  for (const edge of ['file:../client','link:../client']) assert.throws(() => normalizeWorkspaceDependencies(root, { dependencies: { client: edge } }), /Unsupported dependency/);
  assert.equal(normal.dependencies['@fixture/client'], 'workspace:*');
}));
test('rejects symlinks, traversal, native content and exceeded bounds', () => {
  for (const mutate of [
    ({ pkg }) => { fs.unlinkSync(path.join(pkg,'dist/library.cjs'));fs.symlinkSync('../package.json',path.join(pkg,'dist/library.cjs')); },
    ({ write }) => write('dist/index.mjs', "import '../../escape.mjs';"),
    ({ write }) => write('dist/library.cjs', Buffer.from('7f454c4601020304','hex')),
    ({ options }) => { options.limits = { files: 1 }; },
  ]) fixture(ctx => { mutate(ctx);assert.throws(() => emitClientPublication(ctx.options));assert.equal(fs.existsSync(ctx.destination),false); });
});
test('expired producer scope cleans partial destination and preserves source', () => fixture(({ pkg, options, destination }) => {
  const before=fs.readFileSync(path.join(pkg,'package.json'));let calls=0;options.assertCurrent=()=>{ if (++calls===3) throw new Error('scope expired'); };
  assert.throws(()=>emitClientPublication(options),/scope expired/);assert.equal(fs.existsSync(destination),false);assert.deepEqual(fs.readFileSync(path.join(pkg,'package.json')),before);
}));

test('validates compact component references and type targets', () => {
  for (const mutate of [
    ({ write }) => write('dist/components/context.jsonld', { import: ['afs:dist/types/missing.jsonld'] }),
    ({ pkg, write }) => { const m=JSON.parse(fs.readFileSync(path.join(pkg,'package.json')));m.typesVersions={'*':{'bad':['../outside.d.ts']}};write('package.json',m); },
  ]) fixture(ctx=>{mutate(ctx);assert.throws(()=>emitClientPublication(ctx.options));assert.equal(fs.existsSync(ctx.destination),false);});
});

test('rejects destination through source or external symlink parents without writes', () => {
  for (const insideSource of [true, false]) fixture(({ root, pkg, options }) => {
    const actual = insideSource ? pkg : path.join(root, 'external');
    if (!insideSource) fs.mkdirSync(actual);
    const alias=path.join(root,'stage-alias');fs.symlinkSync(actual, alias, 'dir');
    options.destination=path.join(alias,'injected-stage');
    assert.throws(()=>emitClientPublication(options),/ancestor/);
    assert.equal(fs.existsSync(path.join(actual,'injected-stage')),false);
    assert.equal(fs.lstatSync(alias).isSymbolicLink(),true);
  });
});
test('rejects workspace dot segments and invalid scoped names before filesystem lookup', () => fixture(({ root }) => {
  for (const name of ['@scope/..','@scope/.','@../client','@scope/.hidden','@scope/client/extra','@scope/UPPER']) {
    assert.throws(()=>normalizeWorkspaceDependencies(root,{dependencies:{[name]:'workspace:*'}}),/Invalid workspace identity/);
  }
}));
test('cleanup never removes a replacement stage after ownership changes', () => fixture(({ root, destination, options }) => {
  const owned = path.join(root,'original-stage');let calls=0;
  options.assertCurrent=()=>{if(++calls===3){fs.renameSync(destination,owned);fs.mkdirSync(destination);fs.writeFileSync(path.join(destination,'foreign'),'keep');throw new Error('scope expired');}};
  assert.throws(()=>emitClientPublication(options),/ownership prevents cleanup/);
  assert.equal(fs.readFileSync(path.join(destination,'foreign'),'utf8'),'keep');
  assert.equal(fs.existsSync(path.join(owned,'package.json')),true);
}));

test('JSON-LD compact and relative resource fragments retain their document and original bytes', () => fixture(({ pkg, write, options, destination }) => {
  const context = { '@context': { Journal: { '@id': 'undefinedsAfs:dist/types/Journal.jsonld#Journal' }, path: { '@id': 'undefinedsAfs:dist/types/Journal.jsonld#Journal_rootFilePath' } }, import: ['../types/Journal.jsonld#Journal'] };
  const document = { '@id': '#Journal', '@type': 'Class' };
  write('dist/components/context.jsonld', context);write('dist/types/Journal.jsonld', document);
  const original = fs.readFileSync(path.join(pkg, 'dist/components/context.jsonld'));
  const result = emitClientPublication(options);
  assert.ok(result.inventory.some(row => row.path === 'dist/types/Journal.jsonld'));
  assert.deepEqual(fs.readFileSync(path.join(destination, 'dist/components/context.jsonld')), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destination, 'dist/types/Journal.jsonld'))), document);
  assert.equal(result.inventory.some(row => row.path.includes('#')), false);
}));
test('JSON-LD fragments cannot hide missing, unsafe, linked or unsupported documents', () => {
  for (const value of ['undefinedsAfs:dist/types/missing.jsonld#Missing', 'undefinedsAfs:dist/../../outside.jsonld#Class', '../../../outside.jsonld#Class', 'undefinedsAfs:dist/types/file.bin#Class', 'undefinedsAfs:dist/types/index.d.ts?query#Class']) fixture(({ write, options, destination }) => {
    write('dist/components/context.jsonld', { '@id': value });assert.throws(() => emitClientPublication(options));assert.equal(fs.existsSync(destination), false);
  });
  fixture(({ pkg, write, options, destination }) => {
    write('dist/components/context.jsonld', { '@id': 'undefinedsAfs:dist/types/linked.jsonld#Class' });fs.symlinkSync('index.d.ts', path.join(pkg, 'dist/types/linked.jsonld'));assert.throws(() => emitClientPublication(options), /symlink/);assert.equal(fs.existsSync(destination), false);
  });
});
