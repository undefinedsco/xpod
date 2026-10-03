const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('authentication probe exercises patched JOSE CommonJS in Node and Bun', () => {
  const root = path.resolve(__dirname, '../..');
  const source = readFileSync(path.join(__dirname, 'packaged-auth-probe.cjs'), 'utf8');
  const start = source.indexOf('  if (process.versions.bun) {');
  const end = source.indexOf("  const { Session }", start);
  assert.ok(start >= 0 && end > start);
  const program = `const assert=require('node:assert/strict');const {createRequire}=require('node:module');const rawLoad=createRequire(${JSON.stringify(path.join(root, 'package.json'))});let generated=0;const wrap=(original)=>Object.assign((name)=>name==='jose'?new Proxy(original(name),{get(target,key){const value=target[key];return key==='generateKeyPair'?async(...args)=>{generated++;return value(...args)}:value}}):original(name),{resolve:original.resolve});const load=wrap(rawLoad);const openidLoad=wrap(createRequire(rawLoad.resolve('openid-client')));(async()=>{${source.slice(start, end)}assert.equal(generated,2,'both caller-scoped JOSE implementations must execute key generation and token verification');})().catch(e=>{console.error(e);process.exitCode=1});`;
  for (const runtime of ['node', 'bun']) {
    const result = spawnSync(runtime, ['-e', program], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, `${runtime}: ${result.stderr}`);
    assert.equal(result.signal, null);
  }
});
