const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { inspectArtifact, REQUEST_LIMIT } = require('../../scripts/lib/product-artifact-command.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(operation) {
  const parent = path.resolve('.test-data/projection-request'); fs.mkdirSync(parent, { recursive: true }); const root = fs.mkdtempSync(path.join(parent, 'case-'));
  try { return operation(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function archive(root, count = 1) {
  const file = path.join(root, 'original.zip');
  const result = spawnSync('python3', ['-c', "import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:\n for i in range(int(sys.argv[2])):z.writestr('afs/'+str(i).zfill(4)+'-'+'x'*80+'.txt','payload-'+str(i))", file, String(count)], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  const rows = Array.from({ length: count }, (_, index) => { const member = 'afs/' + String(index).padStart(4, '0') + '-' + 'x'.repeat(80) + '.txt', bytes = Buffer.from('payload-' + index); return { path: member, destination: member, bytes: bytes.length, sha256: hash(bytes) }; });
  const destination = path.join(root, 'projected'); fs.mkdirSync(destination);
  const args = [path.resolve('scripts/lib/inspect-product-artifact.py'), file, hash(fs.readFileSync(file)), String(16 * 1024 ** 2), String(40 * 1024 ** 2), '4096', '--selection-stdin', destination, 'legacy-root-normal-supply'];
  return { args, rows, destination };
}
test('actual projection above 65K selection bytes uses short argv and retains exact request bytes/hash', () => fixture(root => {
  const f = archive(root, 400), input = Buffer.from(JSON.stringify(f.rows)), evidence = path.join(root, 'diagnostics');
  assert.ok(input.length > 65572); assert.ok(f.args.reduce((total, value) => total + value.length, 0) < 2000);
  const result = inspectArtifact(f.args, { evidence, label: 'projection', timeout: 30000, maxBuffer: 8 * 1024 ** 2, input });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).selectedMembersProjected, 400);
  for (const row of f.rows) { const bytes = fs.readFileSync(path.join(f.destination, row.destination)); assert.equal(bytes.length, row.bytes); assert.equal(hash(bytes), row.sha256); }
  const directory = path.join(evidence, fs.readdirSync(evidence)[0]), receipt = JSON.parse(fs.readFileSync(path.join(directory, 'command.original.json')));
  assert.equal(receipt.spawnAttempted, true); assert.equal(receipt.stdin.transport, 'stdin-json'); assert.equal(receipt.stdin.bytes, input.length); assert.equal(receipt.stdin.sourceBytes, input.length); assert.equal(receipt.stdin.sha256, hash(input)); assert.equal(receipt.stdin.sourceSHA256, hash(input)); assert.equal(receipt.stdin.captureTruncated, false);
  assert.deepEqual(fs.readFileSync(path.join(directory, receipt.stdin.path)), input); assert.deepEqual(receipt.args, f.args);
  const requestFile = path.join(root, 'test-input.json'), bunDestination = path.join(root, 'projected-bun'); fs.writeFileSync(requestFile, input); fs.mkdirSync(bunDestination);
  const bunArgs = [...f.args]; bunArgs[7] = bunDestination;
  const code = `const fs=require('node:fs');const helper=require(${JSON.stringify(path.resolve('scripts/lib/product-artifact-command.cjs'))});const r=helper.inspectArtifact(${JSON.stringify(bunArgs)},{timeout:30000,maxBuffer:8388608,input:fs.readFileSync(${JSON.stringify(requestFile)})});if(!process.versions.bun||r.status!==0)throw Error(r.stderr||String(r.error));process.stdout.write(r.stdout);`;
  const bun = spawnSync('bun', ['-e', code], { encoding: 'utf8', timeout: 30000 }); assert.equal(bun.status, 0, bun.stderr); assert.equal(JSON.parse(bun.stdout).selectedMembersProjected, 400);

}));
test('malformed and path-reference stdin requests fail without opening a request file or link', () => fixture(root => {
  const f = archive(root), target = path.join(root, 'private-target'), link = path.join(root, 'request-link'); fs.writeFileSync(target, 'private-body-canary'); fs.symlinkSync(target, link);
  for (const input of [Buffer.from('{'), Buffer.from(JSON.stringify({ file: link })), Buffer.from([255])]) {
    const result = inspectArtifact(f.args, { timeout: 30000, maxBuffer: 1024 ** 2, input }); assert.notEqual(result.status, 0); assert.equal(result.stderr.includes('private-body-canary'), false);
  }
  assert.deepEqual(fs.readdirSync(f.destination), []); assert.equal(fs.readFileSync(target, 'utf8'), 'private-body-canary');
}));
test('parent and Python independently bound stdin, with no invented exit for an unstarted request', () => fixture(root => {
  const f = archive(root), input = Buffer.alloc(REQUEST_LIMIT + 1, 32), evidence = path.join(root, 'diagnostics'); let executed = false;
  const rejected = inspectArtifact(f.args, { evidence, label: 'request', timeout: 30000, maxBuffer: 1024, input }, () => { executed = true; throw Error('must not spawn'); });
  assert.equal(executed, false); assert.equal(rejected.status, null); assert.equal(rejected.signal, null); assert.equal(rejected.error.code, 'ERR_PROJECTION_REQUEST_BOUND');
  const directory = path.join(evidence, fs.readdirSync(evidence)[0]), receipt = JSON.parse(fs.readFileSync(path.join(directory, 'command.original.json')));
  assert.equal(receipt.spawnAttempted, false); assert.equal(receipt.status, null); assert.equal(receipt.signal, null); assert.equal(receipt.stdin.sourceBytes, input.length); assert.equal(receipt.stdin.sourceSHA256, hash(input)); assert.equal(receipt.stdin.captureTruncated, true); assert.ok(receipt.stdin.bytes <= REQUEST_LIMIT);
  const direct = spawnSync('python3', f.args, { input, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 ** 2 }); assert.notEqual(direct.status, 0); assert.match(direct.stderr, /stdin request bound/);
}));
test('request transmission failure and diagnostic failure keep the original primary and secondary', () => fixture(root => {
  const primary = Object.assign(new Error('injected stdin write failure'), { code: 'EPIPE' }), blocked = path.join(root, 'blocked'); fs.writeFileSync(blocked, 'keep');
  assert.throws(() => inspectArtifact(['-c', 'pass'], { evidence: blocked, label: 'request', timeout: 30000, maxBuffer: 1024, input: Buffer.from('[]') }, () => ({ error: primary, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })), error => error instanceof AggregateError && error.errors[0] === primary && error.errors.length === 2 && error.cause === primary);
  assert.equal(fs.readFileSync(blocked, 'utf8'), 'keep');
  const evidence = path.join(root, 'diagnostics');
  const failure = inspectArtifact([], { evidence, label: 'request', timeout: 30000, maxBuffer: 1024, input: Buffer.from('[]') }, () => ({ error: primary })); assert.equal(failure.status, null); assert.equal(failure.signal, null);
  const receipt = JSON.parse(fs.readFileSync(path.join(evidence, fs.readdirSync(evidence)[0], 'command.original.json'))); assert.equal(receipt.spawnAttempted, true); assert.equal(receipt.status, null); assert.equal(receipt.signal, null); assert.equal(receipt.error.code, 'EPIPE');
}));
