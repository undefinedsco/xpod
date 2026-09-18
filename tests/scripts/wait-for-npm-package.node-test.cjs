const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { waitForPackage } = require('../../scripts/wait-for-npm-package.cjs');
const bytes = Buffer.from('exact published tarball bytes');
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
async function fixture(t, statuses) {
  let hits = 0;
  const server = http.createServer((req, res) => { res.statusCode = statuses[Math.min(hits++, statuses.length - 1)]; res.end(bytes); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { metadata: { version: '1.2.3', dist: { tarball: `http://127.0.0.1:${server.address().port}/original.tgz`, integrity } }, hits: () => hits };
}
const options = { attempts: 2, intervalMs: 0, log: () => {} };
test('metadata already visible does not pass until original tarball changes 404 to 200', async t => {
  const f = await fixture(t, [404, 200]);
  await waitForPackage('pkg@1.2.3', { ...options, readMetadata: () => f.metadata });
  assert.equal(f.hits(), 2);
});
test('visible metadata with permanently missing tarball fails after bounded attempts', async t => {
  const f = await fixture(t, [404]);
  await assert.rejects(waitForPackage('pkg@1.2.3', { ...options, readMetadata: () => f.metadata }), /HTTP 404/);
  assert.equal(f.hits(), 2);
});
test('SRI mismatch never passes', async t => {
  const f = await fixture(t, [200]); f.metadata.dist.integrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
  await assert.rejects(waitForPackage('pkg@1.2.3', { ...options, readMetadata: () => f.metadata }), /integrity mismatch/);
  assert.equal(f.hits(), 2);
});
test('missing integrity fails closed without a download', async t => {
  const f = await fixture(t, [200]); delete f.metadata.dist.integrity;
  await assert.rejects(waitForPackage('pkg@1.2.3', { ...options, readMetadata: () => f.metadata }), /integrity/);
  assert.equal(f.hits(), 0);
});
test('retries metadata visibility and preserves v-prefixed version compatibility', async t => {
  const f = await fixture(t, [200]); let calls = 0;
  await waitForPackage('pkg@v1.2.3', { ...options, readMetadata: (spec) => {
    assert.equal(spec, 'pkg@1.2.3'); if (++calls === 1) throw new Error('metadata HTTP 404'); return f.metadata;
  } });
  assert.equal(calls, 2); assert.equal(f.hits(), 1);
});
test('rejects invalid wait limits without fetching metadata', async () => {
  for (const attempts of [0, -1, NaN, 1.5]) {
    await assert.rejects(waitForPackage('pkg@1.2.3', { attempts }), /wait limits/);
  }
});
test('download is bounded even when response body stalls', async t => {
  const server = http.createServer((req, res) => { res.writeHead(200); res.write('partial'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  await assert.rejects(waitForPackage('pkg@1.2.3', { ...options, attempts: 1, timeoutMs: 50, readMetadata: () => ({ dist: {
    tarball: `http://127.0.0.1:${server.address().port}/stalled.tgz`, integrity,
  } }) }), /aborted|timeout/i);
});
test('a matching weaker hash cannot bypass stronger SRI mismatch', async t => {
  const f = await fixture(t, [200]);
  f.metadata.dist.integrity = `sha512-${Buffer.alloc(64).toString('base64')} sha1-${createHash('sha1').update(bytes).digest('base64')}`;
  await assert.rejects(waitForPackage('pkg@1.2.3', { ...options, attempts: 1, readMetadata: () => f.metadata }), /integrity mismatch/);
});
test('release gates both consumer jobs on root and all native tarball readiness', () => {
  const { readFileSync } = require('node:fs');
  const workflow = readFileSync(require('node:path').resolve(__dirname, '../../.github/workflows/release.yml'), 'utf8');
  const gate = workflow.slice(workflow.indexOf('- name: Wait for verified root'), workflow.indexOf('  verify_npm_consumer_node:'));
  assert.match(gate, /wait-for-npm-package.cjs "@undefineds.co\/xpod@\$RELEASE_VERSION"/);
  assert.match(gate, /PLATFORM_TARGETS/);
  assert.match(gate, /wait-for-npm-package.cjs "\$package@\$RELEASE_VERSION"/);
  assert.equal((workflow.match(/needs: \[promotion_guard, publish_npm_staging\]/g) || []).length, 2);
});
test('CLI rejects metadata-only visibility through its actual npm subprocess', { skip: process.platform === 'win32' }, async t => {
  const fs = require('node:fs'); const path = require('node:path'); const { spawn } = require('node:child_process');
  const f = await fixture(t, [404]);
  const directory = path.resolve(__dirname, '../../.test-data/npm-wait-cli');
  fs.mkdirSync(directory, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(directory, 'fixture-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  fs.writeFileSync(path.join(scratch, 'npm'), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(f.metadata))});\n`, { mode: 0o700 });
  const script = process.env.XPOD_WAIT_TEST_SCRIPT || path.resolve(__dirname, '../../scripts/wait-for-npm-package.cjs');
  const child = spawn(process.execPath, [script, 'pkg@1.2.3', '2', '0'], {
    env: { ...process.env, PATH: `${scratch}${path.delimiter}${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 1, output); assert.match(output, /HTTP 404/); assert.equal(f.hits(), 2);
});
test('follows the original tarball redirect and verifies the final response bytes', async t => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url === '/original.tgz') { res.writeHead(302, { Location: '/storage.tgz' }); res.end(); }
    else { res.end(bytes); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await waitForPackage('pkg@1.2.3', { ...options, attempts: 1, readMetadata: () => ({ dist: {
    tarball: `http://127.0.0.1:${server.address().port}/original.tgz`, integrity,
  } }) });
  assert.deepEqual(seen, ['/original.tgz', '/storage.tgz']);
});
