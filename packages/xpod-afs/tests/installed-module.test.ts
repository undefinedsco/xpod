import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ModuleStore } from '../../xpod-cli/src/module-store';

const owned: string[] = [];
afterEach(async () => { await Promise.all(owned.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const archive = process.env.XPOD_AFS_TEST_ARCHIVE;
const artifactTest = test as typeof test & { skipIf(condition: boolean): typeof test };
artifactTest.skipIf(!archive)('real AFS payload installs through ModuleStore and runs without workspace dependencies under Node22 and Bun', async () => {
  // Outside every workspace ancestor: NODE_PATH alone does not isolate Node.
  const root = await mkdtemp(path.join(tmpdir(), 'xpod-afs-installed-')); owned.push(root);
  const bytes = await readFile(archive!); const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  let downloads = 0;
  const version = '0.1.0-preview.1';
  const name = `@undefineds.co/xpod-afs-${process.platform}-${process.arch}`;
  const request = (async (url: string | URL | Request) => {
    if (String(url).endsWith('.tgz')) { downloads++; return new Response(bytes); }
    return Response.json({ name, version, dist: { integrity, tarball: 'https://registry.npmjs.org/actual-afs.tgz' } });
  }) as typeof fetch;
  const store = new ModuleStore({ root: path.join(root, 'modules'), fetch: request });
  expect(await store.current('afs')).toBeUndefined(); expect(downloads).toBe(0);
  const installed = await store.install('afs', version); expect(installed.integrity).toBe(integrity);
  const payload = path.join(store.root, 'afs', `${process.platform}-${process.arch}`, version, 'package');
  await mkdir(path.join(root, 'home')); await writeFile(path.join(root, 'runtime-test.cjs'), `
    const assert = require('node:assert/strict');
    const fs = require('node:fs'); const path = require('node:path');
    const lib = require(${JSON.stringify(path.join(payload, 'dist/library.cjs'))});
    const api = require(${JSON.stringify(path.join(payload, 'dist/workcopy/index.cjs'))});
    const sqlite = require(${JSON.stringify(path.join(payload, 'dist/sqlite/SqliteRuntime.cjs'))});
    const install = require(${JSON.stringify(path.join(payload, 'dist/agent-fs/install.cjs'))});
    const rg = require('node:child_process').spawnSync('/usr/bin/which', ['rg'], {encoding:'utf8', env:{...process.env, PATH:${JSON.stringify(process.env.PATH)}}});
    assert.equal(rg.status, 0); assert.equal(rg.error, undefined);
    const installedWrapper = install.installRgWrapper({dir:path.join(process.argv[2],'wrapper'), roots:[], nativeRg:rg.stdout.trim()});
    assert.equal(installedWrapper.launcher[1], fs.realpathSync(${JSON.stringify(path.join(payload, 'dist/entry.mjs'))}));
    const savedArgv = process.argv; process.argv = [process.execPath];
    assert.equal(lib.runtime.moduleLauncher()[1], installedWrapper.launcher[1]);
    process.argv = [process.execPath, '/unrelated/xpodcli.mjs'];
    assert.equal(lib.runtime.moduleLauncher()[1], installedWrapper.launcher[1]); process.argv = savedArgv;
    assert.ok(fs.readFileSync(installedWrapper.wrapperPath,'utf8').includes(' rg '));
    assert.equal(api.LocalSolidFS, lib.workcopy_index.LocalSolidFS);
    assert.equal(sqlite.getSqliteRuntime(), lib.sqlite_SqliteRuntime.getSqliteRuntime());
    const db = sqlite.getSqliteRuntime().openDatabase(':memory:');
    db.exec('CREATE TABLE fixture (value INTEGER)'); db.prepare('INSERT INTO fixture VALUES (?)').run(42);
    assert.equal(db.prepare('SELECT value FROM fixture').get().value, 42); db.close();
    (async () => {
      const source = path.join(process.argv[2], 'authority'); fs.mkdirSync(source, {recursive:true}); fs.writeFileSync(path.join(source,'file.txt'),'before');
      const solid = new api.LocalSolidFS({workRoot:path.join(process.argv[2],'workcopies')});
      const prepared = await solid.prepare({workspace:source, projection:'copy'});
      fs.writeFileSync(path.join(prepared.cwd,'file.txt'),'after'); await prepared.commit();
      assert.equal(fs.readFileSync(path.join(source,'file.txt'),'utf8'),'after');
      const again = await solid.prepare({workspace:source,projection:'copy'});
      assert.equal(fs.readFileSync(path.join(again.cwd,'file.txt'),'utf8'),'after');
      process.stdout.write(JSON.stringify({runtime:process.versions.bun?'bun':'node', sqlite:true, copyCommit:true, singleton:true})+'\\n');
    })().catch(()=>{process.exitCode=1;});
  `);
  const located = spawnSync('which', ['node'], { encoding: 'utf8' });
  expect(located.status).toBe(0); expect(located.error).toBeUndefined();
  const node = located.stdout.trim(); expect(path.isAbsolute(node)).toBe(true);
  const versionCheck = spawnSync(node, ['--version'], { encoding: 'utf8' });
  expect(versionCheck.status).toBe(0); expect(versionCheck.stdout.trim()).toBe('v22.21.1');
  const receipts = path.resolve('.test-data/afs-installed-receipts', path.basename(root));
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  async function receipt(stage: string, result: SpawnSyncReturns<string | Buffer>): Promise<void> {
    const stdout = Buffer.from(result.stdout ?? ''); const stderr = Buffer.from(result.stderr ?? '');
    await writeFile(path.join(receipts, stage + '.stdout'), stdout, { mode: 0o600 });
    await writeFile(path.join(receipts, stage + '.stderr'), stderr, { mode: 0o600 });
    let absent = false;
    try { process.kill(-result.pid, 0); } catch (cause) { absent = (cause as NodeJS.ErrnoException).code === 'ESRCH'; }
    const row = { stage, pid: result.pid, actualExit: result.status, actualSignal: result.signal,
      actualWait: true, rawClosed: true, groupAbsent: absent,
      stdoutSHA256: createHash('sha256').update(stdout).digest('hex'), stderrSHA256: createHash('sha256').update(stderr).digest('hex') };
    await writeFile(path.join(receipts, stage + '.safe.json'), JSON.stringify(row) + '\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify(row) + '\n'); expect(absent).toBe(true);
  }
  async function runOwned(runtime: string, args: string[], env: NodeJS.ProcessEnv): Promise<SpawnSyncReturns<Buffer>> {
    const child = spawn(runtime, args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let error: Error | undefined; let timedOut = false;
    const signalGroup = (signal: NodeJS.Signals): void => {
      if (!child.pid) { return; }
      try { process.kill(-child.pid, signal); } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') { error = new Error('Owned group signal failed'); }
      }
    };
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const watchdog = setTimeout(() => {
      timedOut = true; signalGroup('SIGTERM'); escalation = setTimeout(() => signalGroup('SIGKILL'), 1000);
    }, 10_000);
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk))); child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.once('error', cause => { error = cause; });
    return new Promise(resolve => child.once('close', async (status, signal) => {
      clearTimeout(watchdog); clearTimeout(escalation);
      const present = (): boolean => {
        if (!child.pid) { return false; }
        try { process.kill(-child.pid, 0); return true; }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ESRCH') { return false; } error = new Error('Owned group absence unconfirmed'); return true; }
      };
      if (present()) {
        signalGroup('SIGTERM');
        for (let n = 0; n < 40 && present(); n++) { await new Promise(done => setTimeout(done, 25)); }
        if (present()) { signalGroup('SIGKILL'); }
        for (let n = 0; n < 40 && present(); n++) { await new Promise(done => setTimeout(done, 25)); }
        if (present()) { error = new Error('Owned group absence unconfirmed'); }
      }
      resolve({ pid: child.pid!, status, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr),
        error: error ?? (timedOut ? new Error('Owned consumer timeout') : undefined) } as SpawnSyncReturns<Buffer>);
    }));
  }
  // Type consumers are outside workspace ancestors and resolve the installed
  // public package, through exports and through classic typesVersions.
  await mkdir(path.join(root, 'node_modules/@undefineds.co'), { recursive: true });
  await symlink(payload, path.join(root, 'node_modules/@undefineds.co/xpod-afs'), 'dir');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({type:'module'}));
  const typeConsumer = path.join(root, 'consumer.ts');
  await writeFile(typeConsumer, `import { LocalSolidFS, type SolidFsPrepareInput, type MaterializedWorkspace } from '@undefineds.co/xpod-afs/workcopy';
async function useWorkcopy(fs: LocalSolidFS, options: SolidFsPrepareInput): Promise<MaterializedWorkspace> {
  const prepared = await fs.prepare(options);
  const cwd: string = prepared.cwd;
  await prepared.commit(); void cwd; return prepared;
}
// @ts-expect-error A projection is a closed public contract, not any.
const invalid: SolidFsPrepareInput = {workspace: '.', projection: 'invalid'};
void useWorkcopy; void invalid;
`);
  const compiler = path.resolve(import.meta.dir, '../../../node_modules/typescript/bin/tsc');
  const typeRoots = path.resolve(import.meta.dir, '../../../node_modules/@types');
  for (const [mode, module] of [['Node16', 'Node16'], ['Node', 'CommonJS']]) {
    const result = await runOwned(node, [compiler, '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2021', '--moduleResolution', mode!, '--module', module!, '--typeRoots', typeRoots, '--types', 'node', typeConsumer], { ...process.env, NODE_PATH: '' });
    await receipt('public-workcopy-types-' + mode, result);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.signal).toBeNull();
  }
  const esmConsumer = path.join(root, 'public-runtime.mjs');
  await writeFile(esmConsumer, `
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import {createRequire} from 'node:module'; import {pathToFileURL} from 'node:url';
import {LocalSolidFS} from '@undefineds.co/xpod-afs/workcopy';
import {getSqliteRuntime} from '@undefineds.co/xpod-afs/sqlite/SqliteRuntime';
const require=createRequire(import.meta.url);
assert.equal(LocalSolidFS, require('@undefineds.co/xpod-afs/workcopy').LocalSolidFS);
assert.equal(getSqliteRuntime, require('@undefineds.co/xpod-afs/sqlite/SqliteRuntime').getSqliteRuntime);
const declared=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(payload,'dist/public-value-exports.json'))},'utf8'));
for (const [subpath,names] of Object.entries(declared)) {
  const specifier='@undefineds.co/xpod-afs'+(subpath==='.'?'':subpath.slice(1));
  const esm=await import(specifier); const cjs=require(specifier);
  assert.deepEqual(Object.keys(esm).sort(),names);
  for (const name of names) { assert.ok(Object.prototype.hasOwnProperty.call(cjs,name)); assert.equal(esm[name],cjs[name]); }
}
const db=getSqliteRuntime().openDatabase(':memory:');
db.exec('CREATE TABLE fixture (value INTEGER)'); db.prepare('INSERT INTO fixture VALUES (?)').run(73);
assert.equal(db.prepare('SELECT value FROM fixture').get().value,73); db.close();
assert.equal(getSqliteRuntime(),require('@undefineds.co/xpod-afs/sqlite/SqliteRuntime').getSqliteRuntime());
const clientRoot=${JSON.stringify(path.join(payload,'node_modules/@undefineds.co/xpod-cli'))};
const cliCjs=require(path.join(clientRoot,'dist/client.cjs'));
const cliEsm=await import(pathToFileURL(path.join(clientRoot,'dist/client.mjs')).href);
assert.equal(cliEsm.authFetch,cliCjs.authFetch); assert.equal(cliEsm.Session,cliCjs.Session);
const authority=path.join(process.argv[2],'esm-authority'); fs.mkdirSync(authority,{recursive:true}); fs.writeFileSync(path.join(authority,'file.txt'),'before');
const solid=new LocalSolidFS({workRoot:path.join(process.argv[2],'esm-workcopies')});
const prepared=await solid.prepare({workspace:authority,projection:'copy'}); fs.writeFileSync(path.join(prepared.cwd,'file.txt'),'after'); await prepared.commit();
assert.equal(fs.readFileSync(path.join(authority,'file.txt'),'utf8'),'after');
console.log(JSON.stringify({esmNamedImports:true,allPublicIdentity:true,sqliteSingleton:true,clientAuthIdentity:true,copyCommit:true}));
`);
  for (const runtime of [node, process.execPath]) {
    const label = runtime === node ? 'node' : 'bun';
    const env = { ...process.env, HOME: path.join(root, 'home'), SOLID_HOME: path.join(root, 'home'), NODE_PATH: '', PATH: '/usr/bin:/bin' };
    const esm = await runOwned(runtime, [esmConsumer, path.join(root, label + '-esm')], env);
    await receipt(label + '-esm-public-runtime', esm);
    expect(esm.error).toBeUndefined(); expect(esm.status).toBe(0); expect(esm.signal).toBeNull();
    expect(esm.stdout.toString()).toContain('"allPublicIdentity":true');
    const status = await runOwned(runtime, [path.join(payload, 'dist/entry.mjs'), 'status', '--json'], env);
    await receipt(label + '-status', status);
    expect(status.error).toBeUndefined();
    expect(status.status).toBe(0); expect(status.signal).toBeNull();
    expect(status.stdout.toString()).toContain(path.join(payload, 'helper/agentfs-pod'));
    const result = await runOwned(runtime, [path.join(root, 'runtime-test.cjs'), root], env);
    await receipt(label + '-workcopy-sqlite', result);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0); expect(result.signal).toBeNull(); expect(result.stdout.toString()).toContain('"copyCommit":true');
  }
  // Real OS signal to an installed foreground process while its real auth
  // proxy is awaiting a controlled token response. No native mount is started.
  let tokenObserved!: () => void; const tokenStarted = new Promise<void>(resolve => { tokenObserved = resolve; });
  const server = createServer((request, response) => {
    if (request.url === '/.well-known/openid-configuration') {
      const address = server.address() as { port: number };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ token_endpoint: `http://127.0.0.1:${address.port}/token` }));
    } else if (request.url === '/token') { tokenObserved(); }
    else { response.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number }; const origin = `http://127.0.0.1:${address.port}/`;
  const auth = path.join(root, 'auth'); await mkdir(auth);
  await writeFile(path.join(auth, 'credentials.json'), JSON.stringify({ url: origin, webId: origin + 'pod/profile/card#me',
    authType: 'client_credentials', secrets: { clientId: 'controlled-fixture', clientSecret: 'controlled-fixture' } }), { mode: 0o600 });
  const session = path.join(root, 'cancel-session');
  const child = spawn(node, [path.join(payload, 'dist/entry.mjs'), 'mount', '--pod-root', origin + 'pod/', '--session-dir', session, '--backend', 'nfs', '--json'],
    { cwd: root, detached: true, env: { ...process.env, HOME: path.join(root, 'home'), SOLID_HOME: root, NODE_PATH: '', PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out: Buffer[] = []; const err: Buffer[] = [];
  child.stdout.on('data', bytes => out.push(Buffer.from(bytes))); child.stderr.on('data', bytes => err.push(Buffer.from(bytes)));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const startupDeadline = setTimeout(() => {
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  }, 15_000);
  let owner: { pid: number } | undefined;
  try {
    await Promise.race([tokenStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('Controlled token fixture did not start')), 10_000).unref())]);
    owner = JSON.parse(await readFile(path.join(session, 'proxy-owner.json'), 'utf8'));
    child.kill('SIGTERM'); const result = await closed;
    const row = { pid: child.pid!, status: result.code, signal: result.signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err) } as SpawnSyncReturns<Buffer>;
    await receipt('node-startup-cancel', row);
    expect(result.code).toBe(143); expect(result.signal).toBeNull();
    let absent = false;
    try { process.kill(-owner!.pid, 0); } catch (cause) { absent = (cause as NodeJS.ErrnoException).code === 'ESRCH'; }
    expect(absent).toBe(true);
    await writeFile(path.join(receipts, 'proxy-cancel.safe.json'), JSON.stringify({ pid: owner!.pid, groupAbsent: absent, tokenFixtureObserved: true, nativeMountStarted: false }) + '\n', { mode: 0o600 });
  } finally {
    clearTimeout(startupDeadline);
    try {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') { throw cause; } }
      await closed;
    }
    if (!owner) {
      try { owner = JSON.parse(await readFile(path.join(session, 'proxy-owner.json'), 'utf8')); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') { throw cause; } }
    }
    if (owner) {
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 1) { throw new Error('Invalid owned proxy receipt'); }
      try { process.kill(-owner.pid, 'SIGKILL'); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') { throw cause; } }
      let absent = false;
      for (let n = 0; n < 80; n++) {
        try { process.kill(-owner.pid, 0); } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === 'ESRCH') { absent = true; break; } throw cause;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(absent).toBe(true);
    }
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
  expect(downloads).toBe(1);
  await writeFile(path.join(payload, 'dist/entry.mjs'), 'tampered');
  await expect(store.current('afs')).rejects.toMatchObject({ code: 'module_file_changed' });
  expect(downloads).toBe(1);
}, 30_000);
