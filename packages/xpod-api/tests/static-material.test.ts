import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildStaticProducts, verifyStaticProducts, materializeApiStaticProducts } from '../scripts/static-material';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function createStaticFixture(name: string) {
  const parent = path.resolve('.test-data', name); fs.mkdirSync(parent, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'owned-')));
  const put = (file: string, body: string) => { const absolute = path.join(root, file); fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, body); };
  const git = (args: string[]) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  put('package.json', '{}'); put('bun.lock', 'fixture'); put('.gitignore', 'packages/xpod-api/dist/\nstage/\n');
  put('packages/xpod-api/package.json', '{"name":"fixture-api"}');
  put('ui/package.json', JSON.stringify({ scripts: { 'build:dashboard': 'bun build-fixture.ts dashboard', 'build:settings': 'bun build-fixture.ts settings' } }));
  put('ui/build-fixture.ts', "import fs from 'node:fs';import path from 'node:path';const index=process.argv.indexOf('--outDir');if(index<0)throw new Error('Explicit output missing');const out=process.argv[index+1];fs.mkdirSync(path.dirname(out),{recursive:true});fs.appendFileSync(path.join(path.dirname(out),'calls.log'),'called');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'index.html'),'built '+process.argv[2]);");
  for (const target of ['dashboard', 'settings']) put('static/' + target + '/index.html', 'TRACKED SENTINEL ' + target);
  git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  return { root, put, git };
}

test('normal static builds use ignored module output from both cwd values and preserve tracked UI assets', () => {
  const { root, put, git } = createStaticFixture('api-static-tests'), previous = process.cwd();
  try {
    const tracked = ['static/dashboard/index.html', 'static/settings/index.html'];
    const before = tracked.map(file => sha(fs.readFileSync(path.join(root, file))));
    const out = path.join(root, 'packages/xpod-api/dist');
    for (const cwd of [root, path.join(root, 'ui')]) {
      process.chdir(cwd); buildStaticProducts(root, out);
      const receipt = verifyStaticProducts(root, out); assert.equal(receipt.schemaVersion, 2);
      assert(receipt.assets.every((row: any) => row.sourcePath.startsWith('packages/xpod-api/dist/static/') && row.path.startsWith('static/')));
      assert.deepEqual(tracked.map(file => sha(fs.readFileSync(path.join(root, file)))), before);
      assert.equal(git(['status', '--porcelain']), '');
    }
    assert.throws(() => buildStaticProducts(root, path.join(root, 'tracked-output')), /ignored and untracked/);
    assert.throws(() => buildStaticProducts(root, path.dirname(root)), /escaped producer root/);
    const stage = path.join(root, 'stage'); fs.mkdirSync(stage); materializeApiStaticProducts(root, out, stage);
    assert.equal(fs.readFileSync(path.join(stage, 'static/dashboard/index.html'), 'utf8'), 'built dashboard');
    const receiptPath = path.join(out, 'static-products.json'), bytes = fs.readFileSync(receiptPath);
    for (const alter of [
      (row: any) => { row.schemaVersion = 1; },
      (row: any) => { row.roots[0].sourceRoot = '../escaped'; },
      (row: any) => { row.roots[0].destinationRoot = 'static/foreign'; },
      (row: any) => { row.assets[0].sourcePath = '../escaped'; },
      (row: any) => { row.assets[1].sourcePath = row.assets[0].sourcePath; },
      (row: any) => { row.assets[1].path = row.assets[0].path; },
    ]) {
      const changed = JSON.parse(bytes.toString()); alter(changed); fs.writeFileSync(receiptPath, JSON.stringify(changed));
      assert.throws(() => verifyStaticProducts(root, out), /mismatch|drift/); fs.writeFileSync(receiptPath, bytes);
    }
    put('ui/new.ts', 'export {};'); assert.throws(() => verifyStaticProducts(root, out), /drift/); fs.rmSync(path.join(root, 'ui/new.ts'));
    const asset = path.join(out, 'static/settings/index.html'); fs.appendFileSync(asset, 'drift'); assert.throws(() => verifyStaticProducts(root, out), /drift/); fs.writeFileSync(asset, 'built settings');
    fs.renameSync(asset, asset + '.original'); fs.symlinkSync(asset + '.original', asset); assert.throws(() => verifyStaticProducts(root, out), /symlink/); fs.unlinkSync(asset); fs.renameSync(asset + '.original', asset);
    const productRoot = path.join(out, 'static/dashboard'); fs.renameSync(productRoot, productRoot + '.original'); fs.symlinkSync(productRoot + '.original', productRoot);
    assert.throws(() => verifyStaticProducts(root, out), /symlink/); fs.unlinkSync(productRoot); fs.renameSync(productRoot + '.original', productRoot);
    fs.rmSync(path.join(stage, 'static/dashboard/index.html')); fs.symlinkSync(path.join(root, 'static/dashboard/index.html'), path.join(stage, 'static/dashboard/index.html'));
    assert.throws(() => materializeApiStaticProducts(root, out, stage), /not regular/);
    const changed = JSON.parse(bytes.toString()); changed.sourceCommit = '0'.repeat(40); fs.writeFileSync(receiptPath, JSON.stringify(changed)); assert.throws(() => verifyStaticProducts(root, out), /Git source mismatch/);
  } finally { process.chdir(previous); fs.rmSync(root, { recursive: true, force: true }); }
});

test('every target output is preflighted before any UI starts or tracked sentinel can change', () => {
  for (const attack of ['first-root-link', 'second-root-link', 'second-file-link', 'second-dangling-link', 'second-nested-link', 'second-nonregular']) {
    const { root, git } = createStaticFixture('api-static-preflight');
    try {
      const tracked = ['static/dashboard/index.html', 'static/settings/index.html']; const before = tracked.map(file => sha(fs.readFileSync(path.join(root, file))));
      const out = path.join(root, 'packages/xpod-api/dist'), products = path.join(out, 'static'); fs.mkdirSync(products, { recursive: true });
      if (attack.endsWith('root-link')) {
        const target = attack.startsWith('first') ? 'dashboard' : 'settings'; fs.symlinkSync(path.join(root, 'static', target), path.join(products, target));
      } else {
        const target = path.join(products, 'settings'); fs.mkdirSync(target);
        if (attack === 'second-nonregular') assert.equal(spawnSync('mkfifo', [path.join(target, 'fifo')]).status, 0);
        else if (attack === 'second-nested-link') { fs.mkdirSync(path.join(target, 'assets')); fs.symlinkSync(path.join(root, 'static/settings/index.html'), path.join(target, 'assets/linked.js')); }
        else fs.symlinkSync(path.join(root, attack === 'second-file-link' ? 'static/settings/index.html' : 'missing'), path.join(target, 'index.html'));
      }
      assert.throws(() => buildStaticProducts(root, out), /symlink|not regular/);
      assert.equal(fs.existsSync(path.join(products, 'calls.log')), false, attack + ': no UI process may execute');
      assert.deepEqual(tracked.map(file => sha(fs.readFileSync(path.join(root, file)))), before, attack);
      assert.equal(git(['status', '--porcelain']), '', attack);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
