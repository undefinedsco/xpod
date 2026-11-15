import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// This regression uses an explicitly supplied, already verified offline layout.
// It neither installs dependencies nor substitutes the caller's node_modules.
const reference = process.env.XPOD_AFS_DETERMINISM_REFERENCE;
const artifactTest = test as typeof test & { skipIf(condition: boolean): typeof test };
artifactTest.skipIf(!reference || process.platform !== 'darwin')('real AFS builds retain identical runtime bytes across workspaces and execute after relocation', () => {
  const repo = path.resolve(import.meta.dir, '../../..');
  const parent = path.join(repo, '.test-data/afs-build-determinism');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'case-'));
  const tools = path.resolve(reference!, '../tools');
  const env = { PATH: `${tools}:${reference}/node_modules/.bin:/usr/bin:/bin`, HOME: root,
    CI: '1', LANG: 'C', BUN_CONFIG_NO_CLEAR_TERMINAL: '1', BUN_INSTALL_CACHE_DIR: path.join(root, 'empty-cache') };
  const run = (executable: string, args: string[], cwd: string) => {
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny network*)', executable, ...args],
      { cwd, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
    expect({ status: result.status, signal: result.signal, error: result.error?.message,
      diagnostic: result.status === 0 ? '' : result.stderr.slice(-6000) })
      .toEqual({ status: 0, signal: null, error: undefined, diagnostic: '' });
    return result.stdout;
  };
  const runtimeInventory = (directory: string): Record<string, string> => {
    const entries: Array<[string, string]> = [];
    const walk = (folder: string): void => {
      for (const item of readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, item.name);
        if (item.isDirectory()) walk(file);
        else if (/\.[cm]js$/.test(item.name)) entries.push([path.relative(directory, file), createHash('sha256').update(readFileSync(file)).digest('hex')]);
      }
    };
    walk(directory); return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  };
  try {
    const trees = ['first', 'another-workspace'].map(name => path.join(root, name));
    for (const tree of trees) {
      mkdirSync(tree);
      for (const name of ['package.json', 'bun.lock', 'LICENSE', '.componentsjs-generator-config.json']) cpSync(path.join(reference!, name), path.join(tree, name));
      for (const name of ['config', 'types']) cpSync(path.join(reference!, name), path.join(tree, name), { recursive: true });
      cpSync(path.join(reference!, 'packages/xpod-cli'), path.join(tree, 'packages/xpod-cli'), {
        recursive: true, filter: file => !['node_modules', '.test-data'].includes(path.basename(file)),
      });
      cpSync(path.join(repo, 'packages/xpod-afs'), path.join(tree, 'packages/xpod-afs'), {
        recursive: true, filter: file => !['node_modules', '.test-data', 'dist'].includes(path.basename(file)),
      });
      mkdirSync(path.join(tree, 'scripts'));
      cpSync(path.join(repo, 'scripts/build-afs-from-producer.ts'), path.join(tree, 'scripts/build-afs-from-producer.ts'));
      symlinkSync(path.join(reference!, 'node_modules'), path.join(tree, 'node_modules'), 'dir');
      run('bun', ['scripts/build-afs-from-producer.ts', '--mode', 'client', '--cli-package', 'packages/xpod-cli'], tree);
    }
    const first = path.join(trees[0], 'packages/xpod-afs/dist');
    const inventory = runtimeInventory(first);
    expect(Object.keys(inventory).length).toBeGreaterThan(1);
    expect(runtimeInventory(path.join(trees[1], 'packages/xpod-afs/dist'))).toEqual(inventory);
    expect(readFileSync(path.join(first, 'command-host.mjs'), 'utf8')).not.toContain('producer-cli-');
    expect(readFileSync(path.join(first, 'library.cjs'), 'utf8')).not.toContain(trees[0]);

    const original = path.join(root, 'installation');
    mkdirSync(original);
    cpSync(first, path.join(original, 'dist'), { recursive: true });
    cpSync(path.join(repo, 'LICENSE'), path.join(original, 'LICENSE'));
    writeFileSync(path.join(original, 'package.json'), JSON.stringify({
      name: `@undefineds.co/xpod-afs-${process.platform}-${process.arch}`, type: 'module',
      xpodModule: { schemaVersion: 1, id: 'afs', cliApiVersion: 1, platform: process.platform, arch: process.arch },
    }));
    const materials = path.join(reference!, 'packages/xpod-cli/dist/producer-materials');
    const index = JSON.parse(readFileSync(path.join(materials, 'index.json'), 'utf8'));
    const client = path.join(original, 'node_modules/@undefineds.co/xpod-client');
    mkdirSync(client, { recursive: true });
    run('/usr/bin/tar', ['-xzf', path.join(materials, index.runtimeClients[0].publication.archive), '--strip-components', '1', '-C', client], root);
    cpSync(realpathSync(path.join(reference!, 'node_modules/drizzle-orm')), path.join(original, 'node_modules/drizzle-orm'), { recursive: true });
    const relocated = path.join(root, 'moved-package');
    renameSync(original, relocated);
    for (const tree of trees) rmSync(tree, { recursive: true, force: true });
    const nativeRg = spawnSync('/usr/bin/which', ['rg'], { encoding: 'utf8' }).stdout.trim();
    expect(path.isAbsolute(nativeRg)).toBe(true);
    const consumer = path.join(root, 'consumer.cjs');
    writeFileSync(consumer, `
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = ${JSON.stringify(relocated)};
const lib = require(path.join(root, 'dist/library.cjs'));
process.argv = [process.execPath, '/unrelated/consumer.cjs'];
assert.equal(lib.runtime.moduleRoot(), fs.realpathSync(root));
assert.ok(fs.readFileSync(path.join(lib.runtime.moduleRoot(), 'LICENSE'), 'utf8').includes('MIT'));
assert.equal(lib.runtime.moduleLauncher()[1], path.join(root, 'dist/entry.mjs'));
const sqlite = lib.sqlite_SqliteRuntime.getSqliteRuntime().openDatabase(':memory:');
assert.equal(sqlite.prepare('SELECT 42 AS value').get().value, 42); sqlite.close();
const install = require(path.join(root, 'dist/agent-fs/install.cjs'));
const wrapper = install.installRgWrapper({dir:path.join(root,'wrapper'),roots:[],nativeRg:${JSON.stringify(nativeRg)}});
assert.equal(wrapper.launcher[1], path.join(root, 'dist/entry.mjs'));
const worker = spawnSync(wrapper.wrapperPath, ['--version'], {encoding:'utf8', timeout:10000});
assert.equal(worker.error, undefined); assert.equal(worker.signal, null); assert.equal(worker.status,0,worker.stderr);
assert.match(worker.stdout, /ripgrep/);
process.stdout.write('relocated library, asset, sqlite and command worker passed\\n');
`);
    expect(run('bun', [consumer], root)).toContain('command worker passed');
    const node = process.env.XPOD_AFS_DETERMINISM_NODE;
    if (node) expect(run(node, [consumer], root)).toContain('command worker passed');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 150_000);
