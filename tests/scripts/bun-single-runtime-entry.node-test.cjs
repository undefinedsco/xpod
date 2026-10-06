const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { createSingleBinaryEntry } = require('../../scripts/lib/bun-single-runtime-entry.cjs');

const root = path.resolve(__dirname, '../..');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

test('compiled bootstrap retains bytes, executable mode, internal argv and verified cold/warm cache', () => {
  const parent = path.join(root, '.test-data/bun-single-bootstrap');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'case-'));
  try {
    const resource = Buffer.from([0, 255, 17, 128, 10]);
    const cli = `const fs=require('node:fs'), cp=require('node:child_process');console.log(JSON.stringify({resource:Array.from(fs.readFileSync('data.bin')),mode:fs.statSync('native-fixture').mode&0o777,argv:process.argv.slice(2),native:cp.execFileSync('./native-fixture',[],{encoding:'utf8'}).trim()}));`;
    const manifest = [
      { path: 'dist/__cli__.cjs', contentBase64: Buffer.from(cli).toString('base64'), mode: 0o644 },
      { path: 'data.bin', contentBase64: resource.toString('base64'), mode: 0o600 },
      { path: 'native-fixture', contentBase64: Buffer.from('#!/bin/sh\nprintf native-ok').toString('base64'), mode: 0o755 },
    ];
    const archive = zlib.brotliCompressSync(Buffer.from(JSON.stringify(manifest)), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } });
    const source = path.join(dir, 'entry.ts');
    const binary = path.join(dir, 'bootstrap');
    fs.writeFileSync(source, createSingleBinaryEntry(sha(archive), archive));
    const build = spawnSync('bun', ['build', '--compile', source, '--outfile', binary], { encoding: 'utf8', timeout: 60000 });
    assert.equal(build.status, 0, build.stderr);
    const cache = path.join(dir, 'cache');
    for (const args of [['normal', 'argument with spaces'], ['__internal-agent-runtime-worker', 'payload']]) {
      const result = spawnSync(binary, args, { cwd: '/tmp', encoding: 'utf8', timeout: 15000, env: { ...process.env, XPOD_BUN_SINGLE_CACHE_DIR: cache } });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim()), { resource: Array.from(resource), mode: 0o755, argv: args, native: 'native-ok' });
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
