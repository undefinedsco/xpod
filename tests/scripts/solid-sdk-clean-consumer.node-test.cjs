const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { packWorkspacePackages } = require('../../scripts/workspace-package-pack.cjs');
const root = path.resolve(__dirname, '../..');

test('SDK tarball loads independently in unpatched Bun and Node ESM/CommonJS consumers', () => {
  const parent = path.join(root, '.test-data/solid-sdk-clean-consumer');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'case-'));
  try {
    const tarball = packWorkspacePackages(root, ['solid-sdk'], path.join(directory, 'packed'))['@undefineds.co/solid-sdk'];
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { '@undefineds.co/solid-sdk': tarball, react: '19.2.0' } }));
    execFileSync('bun', ['install', '--ignore-scripts'], { cwd: directory, stdio: 'pipe' });
    const jose = JSON.parse(fs.readFileSync(path.join(directory, 'node_modules/jose/package.json'), 'utf8'));
    assert.equal(typeof jose.exports['.'].bun, 'string', 'Consumer must not apply the root JOSE patch');
    fs.writeFileSync(path.join(directory, 'imports.mjs'), `import assert from 'node:assert/strict';
import * as sdk from '@undefineds.co/solid-sdk';
import * as session from '@undefineds.co/solid-sdk/session';
assert.equal(typeof sdk.createSolidSessionRuntime, 'function');
assert.equal(sdk.createSolidSessionRuntime, session.createSolidSessionRuntime);
`);
    fs.writeFileSync(path.join(directory, 'requires.cjs'), "const assert=require('node:assert/strict');const sdk=require('@undefineds.co/solid-sdk');assert.equal(typeof sdk.createSolidSessionRuntime,'function');");
    const results = [];
    for (const runtime of ['bun', 'node']) {
      for (const entry of ['imports.mjs', 'requires.cjs']) {
        const result = spawnSync(runtime, [entry], { cwd: directory, encoding: 'utf8' });
        results.push({ runtime, entry, status: result.status, signal: result.signal, error: result.error, stderr: result.stderr });
      }
    }
    assert.ok(results.every(result => result.status === 0 && !result.signal && !result.error), JSON.stringify(results));
    const notice = execFileSync('tar', ['-xOf', tarball, 'package/THIRD-PARTY-NOTICES.txt'], { encoding: 'utf8' });
    for (const name of ['@inrupt/solid-client-authn-browser', '@inrupt/solid-client-authn-core', '@inrupt/oidc-client-ext', '@inrupt/oidc-client', 'jose', 'uuid']) assert.ok(notice.includes(name), name);
    const browser = execFileSync('tar', ['-xOf', tarball, 'package/dist/session.js'], { encoding: 'utf8' });
    assert.doesNotMatch(browser, /(?:from\s+|require\(\s*)['"](?:node:|crypto['"]|fs['"]|stream['"])/);
    assert.doesNotMatch(browser, /require\(['"](?:jose|@inrupt\/)/);
    const cjs = execFileSync('tar', ['-xOf', tarball, 'package/dist/index.cjs'], { encoding: 'utf8' });
    assert.match(cjs, /require\(['"]react['"]\)/);
    assert.match(cjs, /require\(['"]zustand(?:\/[^'"]+)?['"]\)/);
    assert.doesNotMatch(cjs, /require\(['"](?:jose|@inrupt\/)/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
