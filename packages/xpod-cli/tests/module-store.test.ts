import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { c as packTar } from 'tar';
import { ModuleStore, type ModuleManifest } from '../src/module-store';
import { MODULE_CATALOG } from '../src/module-catalog';
import { withModuleOwnedLock } from '../src/module-owned-lock';

const roots: string[] = [];
const coreSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(options: { version?: string; api?: number; link?: boolean; drift?: boolean; wrongPlatform?: boolean; source?: string } = {}) {
  const base = path.resolve('.test-data/cli-modules'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'case-')); roots.push(root);
  const packageRoot = path.join(root, 'input/package'); await mkdir(path.join(packageRoot, 'dist'), { recursive: true });
  const source = options.source ?? 'process.exit(Number(process.argv[2] ?? 0));\n'; const version = options.version ?? '0.1.0';
  const manifest: ModuleManifest = { schemaVersion: 1, id: 'afs', cliApiVersion: options.api ?? 1, platform: options.wrongPlatform ? 'linux' : 'darwin', arch: 'arm64', entry: 'dist/entry.mjs',
    files: [{ path: 'dist/entry.mjs', sha256: createHash('sha256').update(options.drift ? 'different' : source).digest('hex'), size: Buffer.byteLength(source), mode: 0o644 }] };
  await writeFile(path.join(packageRoot, 'dist/entry.mjs'), source); await chmod(path.join(packageRoot, 'dist/entry.mjs'), 0o644);
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@undefineds.co/xpod-afs-darwin-arm64', version, xpodModule: manifest,
    scripts: { postinstall: 'exit 99' } }));
  if (options.link) await symlink('/etc/passwd', path.join(packageRoot, 'escape'));
  const tarball = path.join(root, 'module.tgz'); await packTar({ gzip: true, file: tarball, cwd: path.dirname(packageRoot) }, ['package']);
  const bytes = await readFile(tarball); const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  let downloads = 0; let corrupt = false; let denied = false;
  const request = (async (input: string | URL | Request) => {
    if (denied) return new Response('', { status: 404 });
    if (String(input).endsWith('.tgz')) { downloads++; return new Response(corrupt ? Buffer.from('changed') : bytes); }
    return Response.json({ name: '@undefineds.co/xpod-afs-darwin-arm64', version, dist: { integrity, tarball: 'https://registry.npmjs.org/afs.tgz' } });
  }) as typeof fetch;
  const store = new ModuleStore({ root: path.join(root, 'store'), platform: 'darwin', arch: 'arm64', fetch: request });
  return { root, store, get downloads() { return downloads; }, corrupt: () => { corrupt = true; }, deny: () => { denied = true; } };
}

test('first use installs once, pins the version, relays exit status and never executes postinstall', async () => {
  const f = await fixture(); expect(await f.store.current('afs')).toBeUndefined();
  expect(await f.store.run('afs', ['7'])).toBe(7); expect(f.downloads).toBe(1);
  expect(await f.store.run('agent-fs', ['0'])).toBe(0); expect(f.downloads).toBe(1);
  expect((await f.store.current('afs'))?.version).toBe('0.1.0');
  expect((await readdir(path.join(f.store.root, 'afs/darwin-arm64'))).some(name => name.startsWith('.install-'))).toBe(false);
});
test('archive integrity failure leaves no selection or partial install', async () => {
  const f = await fixture(); f.corrupt();
  expect(await f.store.install('afs').then(() => null, cause => cause.code)).toBe('module_integrity_failed');
  expect(await f.store.current('afs')).toBeUndefined();
  expect(await readdir(path.join(f.store.root, 'afs/darwin-arm64'))).toEqual([]);
});
test('incompatible API/platform and missing or changed file inventories cannot activate', async () => {
  for (const options of [{ api: 2 }, { wrongPlatform: true }, { drift: true }]) {
    const f = await fixture(options); await expect(f.store.install('afs')).rejects.toThrow();
    expect(await f.store.current('afs')).toBeUndefined();
  }
});
test('links cannot escape extraction even when the tarball SRI is valid', async () => {
  const f = await fixture({ link: true }); expect(await f.store.install('afs').then(() => null, cause => cause.code)).toBe('module_archive_invalid');
  expect(await f.store.current('afs')).toBeUndefined();
});
test('installed bytes are checked before executing and no reinstall fallback hides corruption', async () => {
  const f = await fixture(); await f.store.install('afs');
  await writeFile(path.join(f.store.root, 'afs/darwin-arm64/0.1.0/package/dist/entry.mjs'), 'process.exit(0);');
  expect(await f.store.run('afs', []).then(() => null, cause => cause.code)).toBe('module_file_changed'); expect(f.downloads).toBe(1);
});
test('unavailable updates preserve the successful current version; removal only deletes modules', async () => {
  const f = await fixture(); await f.store.install('afs'); f.deny();
  expect(await f.store.install('afs', '0.2.0').then(() => null, cause => cause.code)).toBe('module_unavailable');
  expect((await f.store.current('afs'))?.version).toBe('0.1.0');
  const data = path.join(f.root, 'user-data'); await writeFile(data, 'pending');
  await f.store.remove('afs'); expect(await f.store.current('afs')).toBeUndefined(); expect(await readFile(data, 'utf8')).toBe('pending');
});
test('unknown modules, version paths, unsupported targets and active locks fail clearly', async () => {
  const f = await fixture(); expect(await f.store.install('../afs').then(() => null, cause => cause.code)).toBe('module_unknown');
  expect(await f.store.install('afs', '../version').then(() => null, cause => cause.code)).toBe('module_version_invalid');
  await mkdir(f.store.root, { recursive: true, mode: 0o700 }); await mkdir(path.join(f.store.root, 'afs-darwin-arm64.lock'));
  expect(await f.store.install('afs').then(() => null, cause => cause.code)).toBe('module_busy');
  expect(await new ModuleStore({ root: f.store.root, platform: 'win32' }).install('afs').then(() => null, cause => cause.code)).toBe('module_platform_unsupported');
  expect(new Set(MODULE_CATALOG.flatMap(row => [...row.commands])).size).toBe(4);
});

test('signal termination relays the conventional exit status and releases the module lock', async () => {
  const f = await fixture({ source: "process.kill(process.pid, 'SIGTERM');\n" });
  expect(await f.store.run('afs', [])).toBe(143);
  await f.store.remove('afs');
  expect(await f.store.current('afs')).toBeUndefined();
});

test('signal and successful execution clean up forwarding listeners', async () => {
  const counts = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));
  for (const source of ["process.kill(process.pid, 'SIGINT');", 'process.exit(19);']) {
    const f = await fixture({ source });
    expect(await f.store.run('afs', [])).toBe(source.includes('SIGINT') ? 130 : 19);
    expect(['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal))).toEqual(counts);
    await f.store.remove('afs');
  }
});

test('successful module close preserves an intentionally detached long-lived daemon', async () => {
  const f = await fixture({ source: "import { spawn } from 'node:child_process'; import { writeFile } from 'node:fs/promises'; const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached:true,stdio:'ignore'}); daemon.unref(); await writeFile(process.argv[2], String(daemon.pid));" });
  const filename = path.join(f.root, 'daemon.pid'); let pid: number | undefined;
  try {
    expect(await f.store.run('afs', [filename])).toBe(0); pid = Number(await readFile(filename, 'utf8'));
    expect(() => process.kill(pid!, 0)).not.toThrow();
    await f.store.remove('afs'); expect(() => process.kill(pid!, 0)).not.toThrow();
  } finally { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
});

async function waitForFile(filename: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { await readFile(filename); return; } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Process did not publish readiness: ${filename}`);
}
function childClosure(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
}
function bundle(entry: string, outfile: string): string {
  const result = spawnSync('bun', ['build', entry, '--target=node', '--outfile', outfile], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`Fixture bundle failed: ${result.error ?? result.stderr}`);
  return outfile;
}

test('SQLite lock rejects unsafe and legacy files and recovers empty creation after a crash', async () => {
  const f = await fixture(); const lock = path.join(f.root, 'operation.lock');
  await writeFile(`${lock}.sqlite`, '', { mode: 0o600 });
  expect(await withModuleOwnedLock(lock, async () => 17)).toBe(17);
  await withModuleOwnedLock(lock, async () => {
    await expect(withModuleOwnedLock(lock, async () => 1)).rejects.toMatchObject({ code: 'module_busy' });
  });
  await chmod(`${lock}.sqlite`, 0o644);
  await expect(withModuleOwnedLock(lock, async () => 1)).rejects.toMatchObject({ code: 'module_lock_invalid' });
  await rm(`${lock}.sqlite`); await symlink(path.join(f.root, 'unrelated'), `${lock}.sqlite`);
  await expect(withModuleOwnedLock(lock, async () => 1)).rejects.toMatchObject({ code: 'module_lock_invalid' });
  await rm(`${lock}.sqlite`); await mkdir(lock);
  await expect(withModuleOwnedLock(lock, async () => 1)).rejects.toMatchObject({ code: 'module_busy' });
});

test('SQLite fixed-inode lock requires a private owned store and rejects linked files', async () => {
  const f = await fixture(); const directory = path.join(f.root, 'lock-store'); await mkdir(directory, { mode: 0o700 });
  const lock = path.join(directory, 'operation.lock');
  await chmod(directory, 0o777);
  await expect(withModuleOwnedLock(lock, async () => 1)).rejects.toMatchObject({ code: 'module_lock_invalid' });
  await chmod(directory, 0o700);
  const alias = path.join(f.root, 'store-alias'); await symlink(directory, alias);
  await expect(withModuleOwnedLock(path.join(alias, 'operation.lock'), async () => 1)).rejects.toMatchObject({ code: 'module_lock_invalid' });
  await writeFile(`${lock}.sqlite`, '', { mode: 0o600 }); await link(`${lock}.sqlite`, path.join(directory, 'other-name'));
  await expect(withModuleOwnedLock(lock, async () => 1)).rejects.toMatchObject({ code: 'module_lock_invalid' });
});

for (const runtime of ['bun', 'node']) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    test(`${runtime}: forwards ${signal}, waits for close, cleans listeners and releases lock`, async () => {
      const f = await fixture({ source: "import { writeFile } from 'node:fs/promises'; await writeFile(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);" });
      await f.store.install('afs');
      const bundled = bundle(path.join(coreSource, 'module-store.ts'), path.join(f.root, 'module-store.mjs'));
      const ready = path.join(f.root, 'child.ready'); const result = path.join(f.root, 'result.json');
      const script = path.join(f.root, 'runner.mjs');
      await writeFile(script, `import { ModuleStore } from ${JSON.stringify(bundled)};
import { writeFile } from 'node:fs/promises';
const before = ['SIGINT','SIGTERM'].map(s => process.listenerCount(s));
const status = await new ModuleStore({root:process.argv[2],platform:'darwin',arch:'arm64'}).run('afs',[process.argv[3]]);
await writeFile(process.argv[4], JSON.stringify({status,before,after:['SIGINT','SIGTERM'].map(s => process.listenerCount(s))}));
process.exitCode=status;
`);
      const child = spawn(runtime, [script, f.store.root, ready, result], { stdio: 'ignore' }); const closed = childClosure(child);
      let modulePid: number | undefined;
      try {
        await waitForFile(ready); modulePid = Number(await readFile(ready, 'utf8'));
        child.kill(signal); expect((await closed).code).toBe(signal === 'SIGINT' ? 130 : 143);
        const receipt = JSON.parse(await readFile(result, 'utf8')); expect(receipt.after).toEqual(receipt.before);
        expect(() => process.kill(modulePid!, 0)).toThrow();
        await f.store.remove('afs'); expect(await f.store.current('afs')).toBeUndefined();
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        if (modulePid) { try { process.kill(modulePid, 'SIGKILL'); } catch {} }
        await closed;
      }
    }, 30_000);
  }
  test(`${runtime}: SIGKILL recovery and two contenders never steal a live lock`, async () => {
    const f = await fixture();
    const bundled = bundle(path.join(coreSource, 'module-owned-lock.ts'), path.join(f.root, 'module-owned-lock.mjs'));
    const script = path.join(f.root, 'owner.mjs');
    await writeFile(script, `import { withModuleOwnedLock } from ${JSON.stringify(bundled)};
import { writeFile, access } from 'node:fs/promises';
try { await withModuleOwnedLock(process.argv[2], async () => {
  await writeFile(process.argv[3], String(process.pid));
  while (true) { try { await access(process.argv[4]); break; } catch {} await new Promise(r => setTimeout(r, 10)); }
}); } catch (e) { if (e.code === 'module_busy') process.exit(23); throw e; }
`);
    const lock = path.join(f.root, 'contested.lock');
    const children: ChildProcess[] = []; const closures: Promise<{ code: number | null; signal: string | null }>[] = [];
    const start = (name: string, executable = runtime) => {
      const child = spawn(executable, [script, lock, path.join(f.root, `${name}.ready`), path.join(f.root, `${name}.release`)], { stdio: 'ignore' });
      children.push(child); const closed = childClosure(child); closures.push(closed); return { child, closed };
    };
    try {
      const first = start('first'); await waitForFile(path.join(f.root, 'first.ready'));
      const otherRuntime = runtime === 'node' ? 'bun' : 'node';
      expect((await start('busy', otherRuntime).closed).code).toBe(23);
      first.child.kill('SIGKILL'); expect((await first.closed).signal).toBe('SIGKILL');
      const contenders = [start('a'), start('b', otherRuntime)];
      const loser = await Promise.race(contenders.map(async (row, index) => ({ index, result: await row.closed })));
      expect(loser.result.code).toBe(23);
      const winner = loser.index === 0 ? 'b' : 'a'; await waitForFile(path.join(f.root, `${winner}.ready`));
      expect((await start('late').closed).code).toBe(23);
      await writeFile(path.join(f.root, `${winner}.release`), 'release');
      expect((await contenders[1 - loser.index].closed).code).toBe(0);
      expect(await withModuleOwnedLock(lock, async () => 'released')).toBe('released');
      expect((await readdir(f.root)).filter(name => name.startsWith('contested.lock'))).toEqual(['contested.lock.sqlite']);
    } finally { for (const child of children) { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } await Promise.allSettled(closures); }
  }, 30_000);
}
