const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { inspectArtifact, pythonInvocation } = require('../../scripts/lib/product-artifact-command.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(operation) {
  const parent = path.resolve('.test-data/artifact-command'); fs.mkdirSync(parent, { recursive: true }); const root = fs.mkdtempSync(path.join(parent, 'case-'));
  try { return operation(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('one existing Python selector preserves Windows argv without fallback or shell', () => {
  assert.deepEqual(pythonInvocation('win32'), { command: 'python', args: [] }); assert.deepEqual(pythonInvocation('darwin'), { command: 'python3', args: [] });
  const args = ['D:\\a\\xpod\\scripts\\inspect-product-artifact.py', 'D:\\a\\artifact with spaces.zip', 'a'.repeat(64)];
  inspectArtifact(args, { timeout: 30000, maxBuffer: 16 * 1024 ** 2 }, (command, actual, options) => {
    assert.equal(command, pythonInvocation().command); assert.deepEqual(actual, args); assert.deepEqual(options, { timeout: 30000, maxBuffer: 16 * 1024 ** 2 });
    return { status: 0, signal: null, stdout: Buffer.from('{}'), stderr: Buffer.alloc(0) };
  });
});
test('actual Python failure and signal retain bounded original binary pipes and outcome', () => fixture(root => {
  const evidence = path.join(root, 'diagnostics');
  const result = inspectArtifact(['-c', "import sys;sys.stdout.buffer.write(bytes([0,255]));sys.stderr.buffer.write(b'actual failure');sys.exit(7)"], { evidence, label: 'inspection', timeout: 30000, maxBuffer: 1024 });
  assert.equal(result.status, 7);
  const directories = fs.readdirSync(evidence); assert.equal(directories.length, 1);
  const directory = path.join(evidence, directories[0]), receipt = JSON.parse(fs.readFileSync(path.join(directory, 'command.original.json')));
  assert.equal(receipt.status, 7); assert.equal(receipt.signal, null); assert.equal(receipt.error, null);
  for (const channel of ['stdout', 'stderr']) {
    const row = receipt[channel], bytes = fs.readFileSync(path.join(directory, row.path)); assert.equal(row.bytes, bytes.length); assert.equal(row.sha256, hash(bytes)); assert.equal(row.captureTruncated, false);
  }
  assert.deepEqual(fs.readFileSync(path.join(directory, receipt.stdout.path)), Buffer.from([0, 255]));
  if (process.platform !== 'win32') {
    const killed = inspectArtifact(['-c', 'import os,signal;os.kill(os.getpid(),signal.SIGTERM)'], { evidence, label: 'signal', timeout: 30000, maxBuffer: 1024 });
    assert.equal(killed.signal, 'SIGTERM'); assert.equal(killed.status, null);
  }
}));
test('actual missing interpreter startup is retained and no alternate executable is attempted', () => fixture(root => {
  const evidence = path.join(root, 'diagnostics');
  const code = `const helper=require(${JSON.stringify(path.resolve('scripts/lib/product-artifact-command.cjs'))});const result=helper.inspectArtifact(['-c','pass'],{evidence:${JSON.stringify(evidence)},label:'startup',timeout:30000,maxBuffer:1024});if(result.error?.code!=='ENOENT')process.exit(2);`;
  const child = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, PATH: path.join(root, 'no-interpreters') }, encoding: 'utf8' }); assert.equal(child.status, 0, child.stderr);
  const receipt = JSON.parse(fs.readFileSync(path.join(evidence, fs.readdirSync(evidence)[0], 'command.original.json'))); assert.equal(receipt.error.code, 'ENOENT'); assert.equal(receipt.status, null); assert.equal(receipt.stdout.bytes, 0);
}));
test('diagnostic retention failure preserves the actual child primary and the write secondary', () => fixture(root => {
  const evidence = path.join(root, 'blocked'); fs.writeFileSync(evidence, 'original blocker');
  assert.throws(() => inspectArtifact(['-c', 'import sys;sys.exit(7)'], { evidence, label: 'inspection', timeout: 30000, maxBuffer: 1024 }), error => error instanceof AggregateError && error.errors[0].outcome.status === 7 && error.errors.length === 2 && error.cause === error.errors[0]);
  assert.equal(fs.readFileSync(evidence, 'utf8'), 'original blocker');
}));
test('real ZIP permits documented Windows per-view ctime difference and rejects within-view changes', () => fixture(root => {
  const archive = path.join(root, 'original.zip'), parser = path.resolve('scripts/lib/inspect-product-artifact.py');
  const made = spawnSync('python3', ['-c', "import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:z.writestr('afs/original','unchanged original')", archive], { encoding: 'utf8' }); assert.equal(made.status, 0, made.stderr);
  const expected = hash(fs.readFileSync(archive));
  const harness = `import importlib.util,sys,types,os\nspec=importlib.util.spec_from_file_location('parser',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\narchive=sys.argv[2];kind=sys.argv[4];named_calls=0;fd_calls=0\noriginal_named=os.lstat;original_fd=os.fstat\ndef fields(s):return {k:getattr(s,k) for k in ['st_mode','st_nlink','st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns']}\ndef named(p,*a,**kw):\n global named_calls\n s=original_named(p,*a,**kw)\n if str(p)!=archive:return s\n named_calls+=1;v=fields(s);v['st_ctime_ns']+=100\n if named_calls==2 and kind=='named-ctime':v['st_ctime_ns']+=1\n if named_calls==2 and kind=='named-inode':v['st_ino']+=1\n if named_calls==2 and kind=='named-mtime':v['st_mtime_ns']+=1\n return types.SimpleNamespace(**v)\ndef opened(fd):\n global fd_calls\n fd_calls+=1;v=fields(original_fd(fd))\n if fd_calls==2 and kind=='fd-ctime':v['st_ctime_ns']+=1\n if fd_calls==2 and kind=='fd-inode':v['st_ino']+=1\n return types.SimpleNamespace(**v)\nos.lstat=named;os.fstat=opened\nm.inspect(archive,sys.argv[3],1048576,1048576,20)\n`;
  for (const kind of ['stable', 'named-ctime', 'fd-ctime', 'named-inode', 'fd-inode', 'named-mtime']) {
    const result = spawnSync('python3', ['-c', harness, parser, archive, expected, kind], { encoding: 'utf8' });
    if (kind === 'stable') assert.equal(result.status, 0, result.stderr); else assert.notEqual(result.status, 0, kind);
  }
}));
test('actual oversized pipe capture stays bounded and actual Bun uses the same diagnostic runner', () => fixture(root => {
  const evidence = path.join(root, 'overflow');
  const overflow = inspectArtifact(['-c', "import sys;sys.stdout.write('x'*4096)"], { evidence, label: 'overflow', timeout: 30000, maxBuffer: 32 });
  assert.ok(overflow.error);
  const directory = path.join(evidence, fs.readdirSync(evidence)[0]);
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'command.original.json')));
  assert.equal(receipt.stdout.bytes <= 32, true); assert.equal(fs.statSync(path.join(directory, receipt.stdout.path)).size <= 32, true); assert.ok(receipt.error);
  const bunEvidence = path.join(root, 'bun');
  const code = `const helper=require(${JSON.stringify(path.resolve('scripts/lib/product-artifact-command.cjs'))});const result=helper.inspectArtifact(['-c','import sys;sys.exit(7)'],{evidence:${JSON.stringify(bunEvidence)},label:'bun',timeout:30000,maxBuffer:1024});if(!process.versions.bun||result.status!==7)process.exit(2);`;
  const child = spawnSync('bun', ['-e', code], { encoding: 'utf8' }); assert.equal(child.status, 0, child.stderr);
  const bunReceipt = JSON.parse(fs.readFileSync(path.join(bunEvidence, fs.readdirSync(bunEvidence)[0], 'command.original.json'))); assert.equal(bunReceipt.status, 7);
}));
