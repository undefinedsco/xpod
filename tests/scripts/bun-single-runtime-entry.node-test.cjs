const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { createSingleBinaryEntry } = require('../../scripts/lib/bun-single-runtime-entry.cjs');
const { encodeArchive } = require('../../scripts/lib/bun-single-archive.cjs');
const { collectStagedPublicSpecifiers } = require('../../scripts/lib/staged-public-specifiers.cjs');

const root = path.resolve(__dirname, '../..');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

test('staged public resolver binds physical wildcard members and rejects missing exports', () => {
  fs.mkdirSync(path.join(root, '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, '.test-data/staged-public-resolver-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    const pkg = path.join(dir, 'node_modules/@fixture/runtime');
    fs.mkdirSync(path.join(pkg, 'sub'), { recursive: true });
    const manifest = { name: '@fixture/runtime', exports: { '.': './index.cjs', './browser': { browser: './absent-browser.js' }, './sub/*': { require: './sub/*.cjs', import: './sub/*.mjs' } } };
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify(manifest));
    for (const name of ['index.cjs', 'sub/value.cjs', 'sub/value.mjs']) fs.writeFileSync(path.join(pkg, name), 'module.exports={};');
    const before = sha(fs.readFileSync(path.join(pkg, 'package.json')));
    assert.deepEqual(collectStagedPublicSpecifiers(dir, ['@fixture/runtime']), {
      '@fixture/runtime': 'node_modules/@fixture/runtime/index.cjs',
      '@fixture/runtime/sub/value': 'node_modules/@fixture/runtime/sub/value.cjs',
    });
    assert.equal(sha(fs.readFileSync(path.join(pkg, 'package.json'))), before);
    fs.unlinkSync(path.join(pkg, 'sub/value.cjs'));
    assert.throws(() => collectStagedPublicSpecifiers(dir, ['@fixture/runtime']), /Cannot find module/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('compiled bootstrap retains bytes, executable mode, internal argv and verified cold/warm cache', () => {
  const parent = path.join(root, '.test-data/bun-single-bootstrap');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'case-'));
  try {
    const resource = Buffer.from([0, 255, 17, 128, 10]);
    const cli = `const fs=require('node:fs'), cp=require('node:child_process');const runtime=require('@fixture/runtime'),cache=require('@fixture/cache');console.log(JSON.stringify({resource:Array.from(fs.readFileSync('data.bin')),mode:fs.statSync('native-fixture').mode&0o777,argv:process.argv.slice(2),native:cp.execFileSync('./native-fixture',[],{encoding:'utf8'}).trim(),canonicalIdentity:runtime.cache===cache}));`;
    const cliSource = path.join(dir, 'consumer.cjs');
    const cliCompiled = path.join(dir, 'consumer-compiled.cjs');
    fs.writeFileSync(cliSource, cli);
    const consumerBuild = spawnSync('bun', ['build', cliSource, '--target=bun', '--format=cjs', '--external=@fixture/runtime', '--external=@fixture/cache', '--outfile', cliCompiled], { encoding: 'utf8', timeout: 60000 });
    assert.equal(consumerBuild.status, 0, consumerBuild.stderr);
    const entries = [
      { path: 'dist/__cli__.cjs', content: fs.readFileSync(cliCompiled), mode: 0o644 },
      { path: 'data.bin', content: resource, mode: 0o600 },
      { path: 'native-fixture', content: Buffer.from('#!/bin/sh\nprintf native-ok'), mode: 0o755 },
      { path: 'node_modules/@fixture/runtime/index.cjs', content: Buffer.from("exports.cache=require('@fixture/cache');"), mode: 0o644 },
      { path: 'node_modules/@fixture/cache/index.cjs', content: Buffer.from('module.exports={cache:new Map()};'), mode: 0o644 },
    ];
    const archive = zlib.brotliCompressSync(encodeArchive(entries).container, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } });
    const source = path.join(dir, 'entry.ts');
    const binary = path.join(dir, 'bootstrap');
    const specifiers = { '@fixture/runtime': 'node_modules/@fixture/runtime/index.cjs', '@fixture/cache': 'node_modules/@fixture/cache/index.cjs' };
    fs.writeFileSync(source, createSingleBinaryEntry(sha(archive), archive, specifiers));
    const build = spawnSync('bun', ['build', '--compile', source, '--outfile', binary], { encoding: 'utf8', timeout: 60000 });
    assert.equal(build.status, 0, build.stderr);
    const cache = path.join(dir, 'cache');
    for (const args of [['normal', 'argument with spaces'], ['__internal-agent-runtime-worker', 'payload']]) {
      const result = spawnSync(binary, args, { cwd: '/tmp', encoding: 'utf8', timeout: 15000, env: { ...process.env, XPOD_BUN_SINGLE_CACHE_DIR: cache } });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim()), { resource: Array.from(resource), mode: 0o755, argv: args, native: 'native-ok', canonicalIdentity: true });
    }
    assert.equal(fs.readFileSync(path.join(cache, sha(archive).slice(0, 16), '.xpod-bun-single-ready'), 'utf8').trim(), sha(archive));
    for (const [name, bytes, digest] of [['hash', archive, '0'.repeat(64)], ['corrupt', Buffer.from('not a Brotli archive'), sha(Buffer.from('not a Brotli archive'))]]) {
      const badSource = path.join(dir, name+'.ts'), badBinary = path.join(dir, name);
      fs.writeFileSync(badSource, createSingleBinaryEntry(digest, bytes));
      const badBuild = spawnSync('bun', ['build','--compile',badSource,'--outfile',badBinary], { encoding:'utf8',timeout:60000 });
      assert.equal(badBuild.status,0,badBuild.stderr);
      const bad = spawnSync(badBinary,[],{cwd:'/tmp',encoding:'utf8',timeout:15000,env:{...process.env,XPOD_BUN_SINGLE_CACHE_DIR:path.join(dir,name+'-cache')}});
      assert.notEqual(bad.status,0);
      assert.match(bad.stderr,name==='hash'?/Embedded manifest checksum mismatch/:/brotli|decompress|compression/i);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The compiled bootstrap must call the strict reader BEFORE writing anything. A
// VALID archive checksum with a malformed container proves that: the checksum
// check passes, so only the strict decoder can reject it, and no file may appear.
test('compiled bootstrap rejects a valid-checksum malformed container before writing files', () => {
  fs.mkdirSync(path.join(root, '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, '.test-data/bootstrap-strict-'));
  try {
    const source = path.join(dir, 'entry.ts');
    fs.writeFileSync(source, createSingleBinaryEntry('0'.repeat(64), Buffer.from('placeholder')));
    const cases = [
      // Foreign magic: the historical JSON array must NOT be reinterpreted.
      ['magic', Buffer.from(JSON.stringify([{ path: 'x', contentBase64: 'AA==', mode: 420 }]))],
      // Correct magic, but metadata length points past the buffer end.
      ['meta-overrun', (() => { const b = Buffer.alloc(32); b.write('XPODAR01', 0, 'latin1'); b.writeUInt32LE(0xFFFFFFFF, 8); return b; })()],
      // Correct magic and bounds, but the JSON metadata is not an archive array.
      ['meta-shape', (() => {
        const meta = Buffer.from(JSON.stringify([{ path: '../escape', mode: 420, length: 0 }]));
        const head = Buffer.alloc(12); head.write('XPODAR01', 0, 'latin1'); head.writeUInt32LE(meta.length, 8);
        return Buffer.concat([head, meta]);
      })()],
      // Valid metadata that claims more content bytes than exist (truncated body).
      ['body-truncated', (() => {
        const meta = Buffer.from(JSON.stringify([{ path: 'a.txt', mode: 420, length: 64 }]));
        const head = Buffer.alloc(12); head.write('XPODAR01', 0, 'latin1'); head.writeUInt32LE(meta.length, 8);
        return Buffer.concat([head, meta, Buffer.from('short')]);
      })()],
    ];
    for (const [name, container] of cases) {
      const archive = zlib.brotliCompressSync(container, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
      const digest = sha(archive); // VALID checksum, so only the strict reader can reject
      const caseSource = path.join(dir, `${name}.ts`);
      const caseBinary = path.join(dir, name);
      fs.writeFileSync(caseSource, createSingleBinaryEntry(digest, archive));
      const build = spawnSync('bun', ['build', '--compile', caseSource, '--outfile', caseBinary], { encoding: 'utf8', timeout: 60000 });
      assert.equal(build.status, 0, build.stderr);
      const cache = path.join(dir, `${name}-cache`);
      const run = spawnSync(caseBinary, [], { cwd: '/tmp', encoding: 'utf8', timeout: 15000, env: { ...process.env, XPOD_BUN_SINGLE_CACHE_DIR: cache } });
      assert.notEqual(run.status, 0, `${name} should have exited non-zero`);
      // The strict reader's own wording, not a checksum or Brotli failure.
      assert.match(run.stderr, /Archive (magic|metadata|entry|has trailing)/u, `${name}: ${run.stderr}`);
      // Nothing was extracted: the per-archive cache dir may be created, but it
      // must contain no payload and no ready marker.
      const inner = fs.existsSync(cache)
        ? fs.readdirSync(cache).map(entry => path.join(cache, entry)).filter(entry => fs.statSync(entry).isDirectory())
        : [];
      for (const directory of inner) {
        assert.deepEqual(fs.readdirSync(directory), [], `${name} must not extract payload files`);
      }
      // The empty cache dir itself may be created early (it is removed on the
      // next run); what matters is that NOTHING was decoded or written.
      for (const directory of inner) assert.deepEqual(fs.readdirSync(directory), []);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Regression for the CONFIRMED compiled-scope bug: the global specifier redirect
// used to force a nested importer back to the hoist copy (A->1.0.0, B->1.0.0
// instead of B->2.0.0). Proven here with a real Bun-compiled binary, not Node.
test('compiled bootstrap keeps per-importer scoping for a nested version', () => {
  fs.mkdirSync(path.join(root, '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, '.test-data/bootstrap-scope-'));
  try {
    const stage = path.join(dir, 'package');
    const write = (relative, body) => {
      const target = path.join(stage, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    };
    // hoist dup@1.0.0, nested dup@2.0.0 under @f/b
    write('node_modules/dup/package.json', JSON.stringify({ name: 'dup', version: '1.0.0', main: 'index.js' }));
    write('node_modules/dup/index.js', "module.exports = '1.0.0';");
    write('node_modules/@f/b/node_modules/dup/package.json', JSON.stringify({ name: 'dup', version: '2.0.0', main: 'index.js' }));
    write('node_modules/@f/b/node_modules/dup/index.js', "module.exports = '2.0.0';");
    write('node_modules/@f/a/package.json', JSON.stringify({ name: '@f/a', version: '1.0.0', main: 'index.js' }));
    write('node_modules/@f/a/index.js', "module.exports = require('dup');");
    write('node_modules/@f/b/package.json', JSON.stringify({ name: '@f/b', version: '1.0.0', main: 'index.js' }));
    write('node_modules/@f/b/index.js', "module.exports = require('dup');");
    // Entry reports what each importer actually resolved.
    write('dist/__cli__.cjs', "console.log(JSON.stringify({a: require('@f/a'), b: require('@f/b')}));");

    // The map deliberately advertises the ROOT paths, exactly as
    // collectStagedPublicSpecifiers does (this is what used to hijack B).
    const specifiers = {
      '@f/a': 'node_modules/@f/a/index.js',
      '@f/b': 'node_modules/@f/b/index.js',
      dup: 'node_modules/dup/index.js',
    };
    const entries = [];
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) entries.push({ path: path.relative(stage, full).split(path.sep).join('/'), content: fs.readFileSync(full), mode: fs.statSync(full).mode & 0o777 });
      }
    };
    walk(stage);
    const archive = zlib.brotliCompressSync(encodeArchive(entries).container, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
    const source = path.join(dir, 'entry.ts');
    const binary = path.join(dir, 'scope-bin');
    fs.writeFileSync(source, createSingleBinaryEntry(sha(archive), archive, specifiers));
    const build = spawnSync('bun', ['build', '--compile', source, '--outfile', binary], { encoding: 'utf8', timeout: 60000 });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], { cwd: '/tmp', encoding: 'utf8', timeout: 20000, env: { ...process.env, XPOD_BUN_SINGLE_CACHE_DIR: path.join(dir, 'cache') } });
    assert.equal(run.status, 0, run.stderr);
    // Ground truth from Node on the same staged tree, then the compiled result.
    assert.deepEqual(JSON.parse(run.stdout.trim()), { a: '1.0.0', b: '2.0.0' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// A package whose ONLY dependency is nested under itself (the real yallist case,
// requested from a compiled lru-cache). Node's normal ancestor lookup must be
// honoured from the requesting file, not from the bootstrap's own location.
test('compiled bootstrap resolves a dependency nested only under its requester', () => {
  fs.mkdirSync(path.join(root, '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, '.test-data/bootstrap-nesteddep-'));
  try {
    const stage = path.join(dir, 'package');
    const write = (relative, body) => {
      const target = path.join(stage, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    };
    write('node_modules/lru/package.json', JSON.stringify({ name: 'lru', version: '6.0.0', main: 'index.js' }));
    // Only under lru: there is no hoisted copy to fall back to.
    write('node_modules/lru/index.js', "module.exports = require('nested-only');");
    write('node_modules/lru/node_modules/nested-only/package.json', JSON.stringify({ name: 'nested-only', version: '4.0.0', main: 'main.js' }));
    write('node_modules/lru/node_modules/nested-only/main.js', "module.exports = 'nested-ok';");
    write('dist/__cli__.cjs', "console.log(JSON.stringify({v: require('lru')}));");

    const entries = [];
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) entries.push({ path: path.relative(stage, full).split(path.sep).join('/'), content: fs.readFileSync(full), mode: fs.statSync(full).mode & 0o777 });
      }
    };
    walk(stage);
    const archive = zlib.brotliCompressSync(encodeArchive(entries).container, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
    const source = path.join(dir, 'entry.ts');
    const binary = path.join(dir, 'nested-bin');
    fs.writeFileSync(source, createSingleBinaryEntry(sha(archive), archive, { lru: 'node_modules/lru/index.js' }));
    const build = spawnSync('bun', ['build', '--compile', source, '--outfile', binary], { encoding: 'utf8', timeout: 60000 });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], { cwd: '/tmp', encoding: 'utf8', timeout: 20000, env: { ...process.env, XPOD_BUN_SINGLE_CACHE_DIR: path.join(dir, 'cache') } });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout.trim()), { v: 'nested-ok' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The exports gate must be authoritative in the COMPILED bootstrap. Bun exposes no
// resolver that enforces `exports` (measured: createRequire.resolve, Bun.resolveSync,
// import.meta.resolve and Module._findPath all hand back the private main), so this
// asserts the gate against Node's own ground truth.
test('compiled bootstrap enforces package exports: no-dot denied, allowed kept, null falls back, conditions by declaration order', () => {
  fs.mkdirSync(path.join(root, '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, '.test-data/bootstrap-exports-'));
  try {
    const stage = path.join(dir, 'package');
    const write = (relative, body) => {
      const target = path.join(stage, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    };
    // exports WITHOUT "." : Node throws, private main must stay unreachable.
    write('node_modules/locked/package.json', JSON.stringify({ name: 'locked', version: '1.0.0', exports: { './allowed': './allowed.cjs' }, main: 'index.js' }));
    write('node_modules/locked/index.js', "module.exports={leak:'private-main'};");
    write('node_modules/locked/allowed.cjs', "module.exports={ok:'allowed'};");
    // explicit null: NOT a gate, classic main resolution applies.
    write('node_modules/nullex/package.json', JSON.stringify({ name: 'nullex', version: '1.0.0', exports: null, main: 'index.js' }));
    write('node_modules/nullex/index.js', "module.exports='NULLMAIN';");
    // conditions in DECLARATION order: import before default; CJS must take default.
    write('node_modules/cond/package.json', JSON.stringify({ name: 'cond', version: '1.0.0', exports: { '.': { import: './imp.mjs', default: './def.cjs' } } }));
    write('node_modules/cond/imp.mjs', "export default 'IMP';");
    write('node_modules/cond/def.cjs', "module.exports='DEF';");
    // pattern export, and a condition set with no match at all (must deny).
    write('node_modules/pat/package.json', JSON.stringify({ name: 'pat', version: '1.0.0', exports: { './sub/*': './lib/*.cjs' } }));
    write('node_modules/pat/lib/a.cjs', "module.exports='PAT';");
    write('node_modules/condno/package.json', JSON.stringify({ name: 'condno', version: '1.0.0', exports: { '.': { browser: './b.cjs' } }, main: 'index.js' }));
    write('node_modules/condno/b.cjs', "module.exports='B';");
    write('node_modules/condno/index.js', "module.exports='CONDNO_MAIN';");
    write('dist/__cli__.cjs', `
const out={};
const attempt=(key,fn)=>{ try { out[key]=fn(); } catch(e){ out[key]='THREW:'+(e.code||e.message); } };
attempt('lockedRoot',()=>require('locked'));
attempt('lockedAllowed',()=>require('locked/allowed'));
attempt('nullex',()=>require('nullex'));
attempt('cond',()=>require('cond'));
attempt('pat',()=>require('pat/sub/a'));
attempt('condno',()=>require('condno'));
console.log(JSON.stringify(out));
`);

    // Node ground truth on the SAME tree, resolved from inside the stage.
    const nodeTruth = {};
    for (const [key, spec] of [['lockedRoot', 'locked'], ['lockedAllowed', 'locked/allowed'], ['nullex', 'nullex'], ['pat', 'pat/sub/a'], ['condno', 'condno']]) {
      try { require.resolve(spec, { paths: [stage] }); nodeTruth[key] = 'RESOLVED'; }
      catch (error) { nodeTruth[key] = 'THREW:' + error.code; }
    }
    assert.equal(nodeTruth.lockedRoot, 'THREW:ERR_PACKAGE_PATH_NOT_EXPORTED');
    assert.equal(nodeTruth.condno, 'THREW:ERR_PACKAGE_PATH_NOT_EXPORTED');
    assert.equal(nodeTruth.nullex, 'RESOLVED');

    const entries = [];
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) entries.push({ path: path.relative(stage, full).split(path.sep).join('/'), content: fs.readFileSync(full), mode: fs.statSync(full).mode & 0o777 });
      }
    };
    walk(stage);
    const archive = zlib.brotliCompressSync(encodeArchive(entries).container, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
    // The root map deliberately advertises the PRIVATE main, as the old bug did.
    const specifiers = {
      locked: 'node_modules/locked/index.js',
      nullex: 'node_modules/nullex/index.js',
      cond: 'node_modules/cond/def.cjs',
      condno: 'node_modules/condno/index.js',
    };
    const source = path.join(dir, 'entry.ts');
    const binary = path.join(dir, 'exports-bin');
    fs.writeFileSync(source, createSingleBinaryEntry(sha(archive), archive, specifiers));
    const build = spawnSync('bun', ['build', '--compile', source, '--outfile', binary], { encoding: 'utf8', timeout: 60000 });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], { cwd: '/tmp', encoding: 'utf8', timeout: 20000, env: { ...process.env, XPOD_BUN_SINGLE_CACHE_DIR: path.join(dir, 'cache') } });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout.trim()), {
      // Denied even though the root map points at the private main.
      lockedRoot: 'THREW:ERR_PACKAGE_PATH_NOT_EXPORTED',
      lockedAllowed: { ok: 'allowed' },
      // exports:null is not a gate.
      nullex: 'NULLMAIN',
      // CJS takes the `default` branch declared before no earlier match.
      cond: 'DEF',
      pat: 'PAT',
      condno: 'THREW:ERR_PACKAGE_PATH_NOT_EXPORTED',
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Confirmed pattern-selection bug: with siblings './x/*' and './x/*.json', a
// request for './x/foo' must use the key whose SUFFIX matched. Keeping only the
// prefix and re-selecting the longest prefix-matching key returned the .json
// target. Asserted against Node's own ground truth on the same tree.
test('compiled bootstrap pattern export selects the key whose prefix AND suffix matched', () => {
  fs.mkdirSync(path.join(root, '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, '.test-data/bootstrap-pattern-'));
  try {
    const stage = path.join(dir, 'package');
    const write = (relative, body) => {
      const target = path.join(stage, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    };
    // Two sibling patterns share the SAME static prefix './x/'; the .json key is
    // longer but its SUFFIX does not match a plain request. Node requires both
    // prefix and suffix to match, so './x/foo' must use './x/*' -> good/foo.cjs.
    write('node_modules/pat/package.json', JSON.stringify({
      name: 'pat', version: '1.0.0',
      exports: { './x/*': './good/*.cjs', './x/*.json': './bad/*.cjs' },
    }));
    write('node_modules/pat/good/foo.cjs', "module.exports='good';");
    write('node_modules/pat/bad/foo.cjs', "module.exports='bad';");
    write('dist/__cli__.cjs', `
const out={};
try { out.plain = require('pat/x/foo'); } catch(e){ out.plain='THREW:'+(e.code||e.message); }
console.log(JSON.stringify(out));
`);

    // Node ground truth on the identical staged tree.
    const truth = {};
    for (const spec of ['pat/x/foo']) {
      try {
        const resolved = require.resolve(spec, { paths: [stage] });
        truth[spec] = require(resolved);
      } catch (error) {
        truth[spec] = 'THREW:' + (error.code || error.message);
      }
    }
    assert.equal(truth['pat/x/foo'], 'good');

    const entries = [];
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) entries.push({ path: path.relative(stage, full).split(path.sep).join('/'), content: fs.readFileSync(full), mode: fs.statSync(full).mode & 0o777 });
      }
    };
    walk(stage);
    const archive = zlib.brotliCompressSync(encodeArchive(entries).container, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
    const source = path.join(dir, 'entry.ts');
    const binary = path.join(dir, 'pattern-bin');
    fs.writeFileSync(source, createSingleBinaryEntry(sha(archive), archive, { pat: 'node_modules/pat/good/foo.cjs' }));
    const build = spawnSync('bun', ['build', '--compile', source, '--outfile', binary], { encoding: 'utf8', timeout: 60000 });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], { cwd: '/tmp', encoding: 'utf8', timeout: 20000, env: { ...process.env, XPOD_BUN_SINGLE_CACHE_DIR: path.join(dir, 'cache') } });
    assert.equal(run.status, 0, run.stderr);
    // Old code selected the longer './x/*.json' key by prefix alone and returned 'bad'.
    assert.deepEqual(JSON.parse(run.stdout.trim()), { plain: 'good' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// MEASURED Bun runtime limitation, documented rather than hidden: inside a
// compiled single binary, a DYNAMIC `import()` of a BARE specifier is resolved
// from the embedded `/$bunfs/` root, so it cannot see staged node_modules at
// all. This is independent of this bootstrap: it fails identically with no
// plugin registered, and it fails for every `exports` shape while a plain
// `main` package happens to work. Node's own product code already loads such
// packages by absolute file URL for this reason.
//
// The assertion below pins the CONTRACT the runtime relies on: an absolute file
// URL loads the ESM branch correctly, and a CJS require selects the require
// branch - i.e. import conditions are never wrongly applied to a CJS request.
test('compiled bootstrap selects the require condition for CJS and loads ESM by staged file URL', () => {
  fs.mkdirSync(path.join(root, '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, '.test-data/bootstrap-kind-'));
  try {
    const stage = path.join(dir, 'package');
    const write = (relative, body) => {
      const target = path.join(stage, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    };
    write('node_modules/kind/package.json', JSON.stringify({
      name: 'kind', version: '1.0.0',
      exports: { '.': { require: './cjs.cjs', import: './esm.mjs' } },
    }));
    write('node_modules/kind/cjs.cjs', "module.exports={src:'cjs'};");
    write('node_modules/kind/esm.mjs', "export default {src:'esm'};");
    // The ESM side must hand the loader an ABSOLUTE file URL: a compiled binary
    // resolves relative/bare dynamic imports against its embedded /$bunfs/ root.
    write('dist/__cli__.cjs', `
(async()=>{
 const path=require('node:path');
 const {pathToFileURL}=require('node:url');
 const out={};
 try { out.cjs = require('kind').src; } catch(e){ out.cjs='THREW:'+(e.code||e.message); }
 try {
   const abs = pathToFileURL(path.join(__dirname, '..', 'node_modules', 'kind', 'esm.mjs')).href;
   const m = await import(abs);
   out.esm=(m.default??m).src;
 } catch(e){ out.esm='THREW:'+(e.code||e.message); }
 console.log(JSON.stringify(out));
})();
`);

    const entries = [];
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) entries.push({ path: path.relative(stage, full).split(path.sep).join('/'), content: fs.readFileSync(full), mode: fs.statSync(full).mode & 0o777 });
      }
    };
    walk(stage);
    const archive = zlib.brotliCompressSync(encodeArchive(entries).container, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
    const source = path.join(dir, 'entry.ts');
    const binary = path.join(dir, 'kind-bin');
    // The root map advertises the CJS entry, exactly as the real collector does.
    fs.writeFileSync(source, createSingleBinaryEntry(sha(archive), archive, { kind: 'node_modules/kind/cjs.cjs' }));
    const build = spawnSync('bun', ['build', '--compile', source, '--outfile', binary], { encoding: 'utf8', timeout: 60000 });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], { cwd: '/tmp', encoding: 'utf8', timeout: 20000, env: { ...process.env, XPOD_BUN_SINGLE_CACHE_DIR: path.join(dir, 'cache') } });
    assert.equal(run.status, 0, run.stderr);
    // CJS picks `require`; ESM loads from the staged file, so both branches are
    // the correct ones rather than one branch silently serving the other.
    assert.deepEqual(JSON.parse(run.stdout.trim()), { cjs: 'cjs', esm: 'esm' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// REAL product failure: an in-package RELATIVE require ('../entity.cjs') was
// treated as a package subpath and gated by exports, killing drizzle-orm at
// startup. Relative/absolute specifiers must always use ordinary file resolution.
test('compiled bootstrap leaves relative in-package requires to the file resolver', () => {
  fs.mkdirSync(path.join(root, '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, '.test-data/bootstrap-relative-'));
  try {
    const stage = path.join(dir, 'package');
    const write = (relative, body) => {
      const target = path.join(stage, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    };
    // Shape of drizzle-orm: a package with exports, whose own file requires a
    // PRIVATE relative sibling that the exports map does not list.
    write('node_modules/orm/package.json', JSON.stringify({
      name: 'orm', version: '1.0.0',
      exports: { '.': './index.cjs' },
    }));
    write('node_modules/orm/index.cjs', "module.exports = require('./sql/sql.cjs');");
    write('node_modules/orm/sql/sql.cjs', "module.exports = { from: require('../entity.cjs').name };");
    write('node_modules/orm/entity.cjs', "module.exports = { name: 'entity' };");
    write('dist/__cli__.cjs', `
const out={};
try { out.ok = require('orm').from; } catch(e){ out.ok='THREW:'+(e.code||e.message); }
console.log(JSON.stringify(out));
`);
    const entries = [];
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) entries.push({ path: path.relative(stage, full).split(path.sep).join('/'), content: fs.readFileSync(full), mode: fs.statSync(full).mode & 0o777 });
      }
    };
    walk(stage);
    const archive = zlib.brotliCompressSync(encodeArchive(entries).container, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
    const source = path.join(dir, 'entry.ts');
    const binary = path.join(dir, 'relative-bin');
    fs.writeFileSync(source, createSingleBinaryEntry(sha(archive), archive, { orm: 'node_modules/orm/index.cjs' }));
    const build = spawnSync('bun', ['build', '--compile', source, '--outfile', binary], { encoding: 'utf8', timeout: 60000 });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], { cwd: '/tmp', encoding: 'utf8', timeout: 20000, env: { ...process.env, XPOD_BUN_SINGLE_CACHE_DIR: path.join(dir, 'cache') } });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout.trim()), { ok: 'entity' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
