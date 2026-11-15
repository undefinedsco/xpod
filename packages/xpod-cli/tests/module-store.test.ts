import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { c as packTar, x as extractTar, Header } from 'tar';
import { gzipSync } from 'node:zlib';
import { ModuleStore, type ModuleManifest } from '../src/module-store';
import { MODULE_CATALOG } from '../src/module-catalog';
import { withModuleOwnedLock } from '../src/module-owned-lock';

const roots: string[] = [];
const coreSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(options: { version?: string; api?: number; link?: boolean; drift?: boolean; wrongPlatform?: boolean; source?: string;
  inventoryCase?: 'many' | 'late-tamper' | 'duplicate' | 'extra'; archiveMtime?: Date; blockedParent?: boolean; beforeArchive?: (storeRoot: string) => Promise<void> } = {}) {
  const base = path.resolve('.test-data/cli-modules'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'case-')); roots.push(root);
  const packageRoot = path.join(root, 'input/package'); await mkdir(path.join(packageRoot, 'dist'), { recursive: true });
  const source = options.source ?? 'process.exit(Number(process.argv[2] ?? 0));\n'; const version = options.version ?? '0.1.0';
  const manifest: ModuleManifest = { schemaVersion: 1, id: 'afs', cliApiVersion: options.api ?? 1, platform: options.wrongPlatform ? 'linux' : 'darwin', arch: 'arm64', entry: 'dist/entry.mjs',
    files: [{ path: 'dist/entry.mjs', sha256: createHash('sha256').update(options.drift ? 'different' : source).digest('hex'), size: Buffer.byteLength(source), mode: 0o644 }] };
  await writeFile(path.join(packageRoot, 'dist/entry.mjs'), source); await chmod(path.join(packageRoot, 'dist/entry.mjs'), 0o644);
  if (options.inventoryCase) {
    for (let index = 0; index < 12; index++) {
      const relative = `dist/file-${index}.txt`; const contents = `inventory-${index}`;
      await writeFile(path.join(packageRoot, relative), contents);
      await chmod(path.join(packageRoot, relative), 0o644);
      manifest.files.push({ path: relative, sha256: createHash('sha256').update(contents).digest('hex'), size: Buffer.byteLength(contents), mode: 0o644 });
    }
    if (options.inventoryCase === 'late-tamper') await writeFile(path.join(packageRoot, 'dist/file-11.txt'), 'inventory-XX');
    if (options.inventoryCase === 'duplicate') manifest.files.push({ ...manifest.files[12] });
    if (options.inventoryCase === 'extra') await writeFile(path.join(packageRoot, 'dist/undeclared.txt'), 'unbound');
  }
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@undefineds.co/xpod-afs-darwin-arm64', version, xpodModule: manifest,
    scripts: { postinstall: 'exit 99' } }));
  if (options.link) await symlink('/etc/passwd', path.join(packageRoot, 'escape'));
  const tarball = path.join(root, 'module.tgz'); await packTar({ gzip: true, file: tarball, cwd: path.dirname(packageRoot), mtime: options.archiveMtime }, ['package']);
  if (options.blockedParent) {
    const chunks: Buffer[] = [];
    for (const [name, body] of [['package/package.json', await readFile(path.join(packageRoot, 'package.json'))],
      ['package/dist', Buffer.from('parent is a file')], ['package/dist/entry.mjs', Buffer.from(source)]] as const) {
      const header = new Header({ path: name, type: 'File', mode: 0o644, size: body.length }); header.encode();
      chunks.push(header.block!, body, Buffer.alloc((512 - body.length % 512) % 512));
    }
    chunks.push(Buffer.alloc(1024)); await writeFile(tarball, gzipSync(Buffer.concat(chunks)));
  }
  const bytes = await readFile(tarball); const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  let downloads = 0; let corrupt = false; let denied = false;
  const request = (async (input: string | URL | Request) => {
    if (denied) return new Response('', { status: 404 });
    if (String(input).endsWith('.tgz')) { await options.beforeArchive?.(path.join(root, 'store')); downloads++; return new Response(corrupt ? Buffer.from('changed') : bytes); }
    return Response.json({ name: '@undefineds.co/xpod-afs-darwin-arm64', version, dist: { integrity, tarball: 'https://registry.npmjs.org/afs.tgz' } });
  }) as typeof fetch;
  const store = new ModuleStore({ root: path.join(root, 'store'), platform: 'darwin', arch: 'arm64', fetch: request });
  return { root, store, tarball, integrity, get downloads() { return downloads; }, corrupt: () => { corrupt = true; }, deny: () => { denied = true; } };
}

for (const runtime of ['bun', 'node']) test(`${runtime}: extraction failure closes writes before staging cleanup and preserves the original error`, async () => {
  const f = await fixture({ blockedParent: true });
  const script = path.join(f.root, 'probe.ts'); const payload = path.join(f.root, 'probe.mjs');
  await writeFile(script, `
import {createRequire} from 'node:module';globalThis.require=createRequire(import.meta.url);
const {readFile,readdir}=await import('node:fs/promises');
const {ModuleStore}=await import(${JSON.stringify(path.join(coreSource, 'module-store.ts'))});
const bytes=await readFile(${JSON.stringify(f.tarball)});
const store=new ModuleStore({root:${JSON.stringify(path.join(f.root, 'probe-store'))},platform:'darwin',arch:'arm64',fetch:async input=>String(input).endsWith('.tgz')?new Response(bytes):Response.json({name:'@undefineds.co/xpod-afs-darwin-arm64',version:'0.1.0',dist:{integrity:${JSON.stringify(f.integrity)},tarball:'https://registry.npmjs.org/afs.tgz'}})});
let code;try {await store.install('afs');}catch(error){code=error.code;}
const directory=store.root+'/afs/darwin-arm64';const immediate=await readdir(directory);
await new Promise(resolve=>setTimeout(resolve,300));
console.log(JSON.stringify({code,immediate,later:await readdir(directory),current:await store.current('afs')??null}));
`);
  const built = spawnSync('bun', ['build', '--target=node', '--format=esm', '--outfile', payload, script], { encoding: 'utf8' });
  expect(built.status).toBe(0);
  const result = spawnSync(runtime, [payload], { encoding: 'utf8' });
  expect(result.status).toBe(0); expect(result.signal).toBeNull();
  expect(JSON.parse(result.stdout)).toEqual({ code: 'ENOTDIR', immediate: [], later: [], current: null });
});

test('a staging cleanup failure preserves the primary installation error', async () => {
  if (process.getuid?.() === 0) return; // A privileged user bypasses the deterministic filesystem permission fault.
  let protectedDirectory = '';
  const f = await fixture({ drift: true, beforeArchive: async storeRoot => {
    const parent = path.join(storeRoot, 'afs/darwin-arm64');
    const stage = (await readdir(parent)).find(name => name.startsWith('.install-'))!;
    protectedDirectory = path.join(parent, stage, 'protected');
    await mkdir(protectedDirectory); await writeFile(path.join(protectedDirectory, 'file'), 'cleanup denied');
    await chmod(protectedDirectory, 0o500);
  } });
  try {
    const failure = await f.store.install('afs').then(() => undefined, error => error);
    expect(failure instanceof AggregateError).toBe(true);
    expect(failure.errors[0].code).toBe('module_file_changed');
    expect(['EACCES', 'EPERM', 'ENOTEMPTY']).toContain(failure.errors[1].code);
    expect(failure.message).toContain('Installed module contents changed');
    expect(await f.store.current('afs')).toBeUndefined();
  } finally { if (protectedDirectory) await chmod(protectedDirectory, 0o700); }
});

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
test('admitted entry remains locked until the consuming lifecycle completes', async () => {
  const f = await fixture();
  await f.store.withAdmittedModules(['agent-fs'], async modules => {
    expect(modules[0].installed.id).toBe('afs');
    expect(await readFile(modules[0].entry, 'utf8')).toContain('process.exit');
    expect(path.dirname(path.dirname(modules[0].entry))).toBe(modules[0].cwd);
    expect(await f.store.remove('afs').then(() => null, cause => cause.code)).toBe('module_busy');
  });
  await f.store.remove('afs');
  expect(await f.store.current('afs')).toBeUndefined();
});
test('admission rejects duplicate aliases before installation and checks installed bytes', async () => {
  const f = await fixture();
  await expect(f.store.withAdmittedModules(['afs', 'agent-fs'], async () => {})).rejects.toThrow();
  expect(f.downloads).toBe(0);
  await f.store.install('afs');
  await writeFile(path.join(f.store.root, 'afs/darwin-arm64/0.1.0/package/dist/entry.mjs'), 'changed');
  let consumed = false;
  await expect(f.store.withAdmittedModules(['afs'], async () => { consumed = true; })).rejects.toThrow();
  expect(consumed).toBe(false);
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
function parseReadyPid(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid readiness PID');
  return Number(value);
}
test('readiness PID rejects incomplete, zero, negative and unsafe identities', () => {
  for (const value of ['', '0', '-1', '1\n', 'NaN', '9007199254740992']) {
    expect(() => parseReadyPid(value)).toThrow('Invalid readiness PID');
  }
  expect(parseReadyPid('123')).toBe(123);
});
function childClosure(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
}
function safeErrorCode(cause: unknown): string {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'UNKNOWN';
}
function linuxProcessIdentity(pid: number) {
  if (process.platform !== 'linux') {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 });
    const birth = result.stdout.trim();
    return result.status === 0 && /^[A-Za-z0-9 :]+$/.test(birth)
      ? { birth } : { errorCode: 'IDENTITY_UNAVAILABLE' };
  }
  try {
    // comm can contain spaces and parentheses; fields after its final ')' start at state.
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (!/^[A-Za-z]$/.test(fields[0] ?? '') || !/^\d+$/.test(fields[1] ?? '')
      || !/^\d+$/.test(fields[19] ?? '')) return { errorCode: 'INVALID_STAT' };
    return { state: fields[0], ppid: Number(fields[1]), birth: fields[19] };
  } catch (cause) { return { errorCode: safeErrorCode(cause) }; }
}
function independentNodePresence(pid: number) {
  const observer = spawnSync('node', ['-e',
    "try { process.kill(Number(process.argv[1]), 0); process.stdout.write('PRESENT'); } catch (e) { process.stdout.write(typeof e.code === 'string' && /^[A-Z0-9_]+$/.test(e.code) ? e.code : 'UNKNOWN'); }",
    String(pid)], { encoding: 'utf8', timeout: 5_000 });
  return {
    exit: observer.status,
    errorCode: observer.error ? safeErrorCode(observer.error)
      : /^[A-Z0-9_]+$/.test(observer.stdout) ? observer.stdout : 'INVALID_OBSERVER_RESULT',
  };
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
      const f = await fixture({ source: "import { writeFile, rename } from 'node:fs/promises'; const pending=process.argv[2]+'.tmp'; await writeFile(pending, String(process.pid)); await rename(pending,process.argv[2]); setInterval(() => {}, 1000);" });
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
      let readyIdentity: ReturnType<typeof linuxProcessIdentity> | undefined;
      try {
        await waitForFile(ready); modulePid = parseReadyPid(await readFile(ready, 'utf8'));
        readyIdentity = linuxProcessIdentity(modulePid);
        child.kill(signal); expect((await closed).code).toBe(signal === 'SIGINT' ? 130 : 143);
        const closedIdentity = linuxProcessIdentity(modulePid);
        const nodeObserver = independentNodePresence(modulePid);
        const receipt = JSON.parse(await readFile(result, 'utf8')); expect(receipt.after).toEqual(receipt.before);
        let localObserver = 'PRESENT';
        try { process.kill(modulePid, 0); } catch (cause) { localObserver = safeErrorCode(cause); }
        if (localObserver !== 'ESRCH') {
          console.error(JSON.stringify({ diagnostic: 'module_signal_pid_presence', pid: modulePid,
            readyIdentity, closedIdentity, nodeObserver, localObserver }));
        }
        expect(() => process.kill(modulePid!, 0)).toThrow();
        await f.store.remove('afs'); expect(await f.store.current('afs')).toBeUndefined();
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        if (modulePid && readyIdentity?.birth
          && linuxProcessIdentity(modulePid).birth === readyIdentity.birth) {
          try { process.kill(modulePid, 'SIGKILL'); } catch {}
        }
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

test('diagnostics: successful phases are ordered, bounded and do not disclose paths', async () => {
  const events: import('../src/module-install-diagnostics').ModuleInstallDiagnostic[] = [];
  let archiveChecks = 0;
  const f = await fixture({ beforeArchive: async () => {
    if (archiveChecks++ > 0) return;
    expect(events.slice(0, 2).map(event => [event.phase, event.state])).toEqual([['lock-acquire', 'started'], ['lock-acquire', 'completed']]);
    expect(events[events.length - 1].phase).toBe('archive-download-hash');
    expect(events[events.length - 1].state).toBe('started');
  } });
  const installed = await f.store.install('afs', '0.1.0', event => events.push(event));
  expect(installed.version).toBe('0.1.0');
  const phases = ['lock-acquire', 'metadata', 'archive-download-hash', 'archive-scan', 'archive-extract', 'manifest-modes',
    'verify-manifest', 'verify-files', 'verify-walk', 'publish', 'cleanup'];
  expect(events.filter(event => event.state === 'started').map(event => event.phase)).toEqual(phases);
  expect(events.map(event => event.state)).toEqual(phases.flatMap(() => ['started', 'completed']));
  expect(events.length).toBe(22);
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    expect(event.kind).toBe('module-install-phase');
    expect(event.elapsedMs >= (events[index - 1]?.elapsedMs ?? 0)).toBe(true);
    expect(Object.keys(event).sort()).toEqual((event.state === 'started' ? ['kind', 'phase', 'state', 'elapsedMs'] : ['kind', 'phase', 'state', 'elapsedMs', 'durationMs']).sort());
  }
  expect(JSON.stringify(events).includes(f.root)).toBe(false);
  expect(JSON.stringify(events).includes('registry.npmjs.org')).toBe(false);
  const again: typeof events = []; await f.store.install('afs', '0.1.0', event => again.push(event));
  expect(again.filter(event => event.phase === 'verify-manifest' && event.state === 'completed').length).toBe(2);
});
test('diagnostics: observer failures never alter successful install or original failure', async () => {
  const f = await fixture();
  expect((await f.store.install('afs', '0.1.0', () => { throw new Error('observer private data'); })).version).toBe('0.1.0');
  f.corrupt(); const events: import('../src/module-install-diagnostics').ModuleInstallDiagnostic[] = [];
  const failure = await f.store.install('afs', '0.1.0', event => { events.push(event); throw new Error('observer'); }).catch(error => error);
  expect(failure.code).toBe('module_integrity_failed');
  expect(events.filter(event => event.state === 'failed').map(event => event.phase)).toEqual(['archive-download-hash']);
  expect(events.slice(-2).map(event => [event.phase, event.state])).toEqual([['cleanup', 'started'], ['cleanup', 'completed']]);
});
test('diagnostics: lock acquisition completes before metadata work and failures mark only acquisition', async () => {
  const f = await fixture(); await mkdir(f.store.root, { recursive: true, mode: 0o700 });
  await writeFile(path.join(f.store.root, 'afs-darwin-arm64.lock'), 'legacy busy lock');
  const events: import('../src/module-install-diagnostics').ModuleInstallDiagnostic[] = [];
  const failure = await f.store.install('afs', '0.1.0', event => events.push(event)).catch(error => error);
  expect(failure.code).toBe('module_busy');
  expect(events.map(event => [event.phase, event.state])).toEqual([['lock-acquire', 'started'], ['lock-acquire', 'failed']]);
});


test('bounded inventory verification covers files beyond the first worker batch and retains the exact walk', async () => {
  const valid = await fixture({ inventoryCase: 'many' });
  await valid.store.install('afs');
  expect((await valid.store.current('afs'))?.version).toBe('0.1.0');
  const lastFile = path.join(valid.store.root, 'afs/darwin-arm64/0.1.0/package/dist/file-11.txt');
  await chmod(lastFile, 0o755);
  expect(await valid.store.current('afs').then(() => null, cause => cause.code)).toBe('module_file_changed');
  await chmod(lastFile, 0o644);
  await rm(lastFile);
  expect(await valid.store.current('afs').then(() => null, cause => cause.code)).toBe('ENOENT');
  for (const [inventoryCase, code] of [['late-tamper', 'module_file_changed'], ['duplicate', 'module_inventory_invalid'],
    ['extra', 'module_inventory_invalid']] as const) {
    const f = await fixture({ inventoryCase });
    expect(await f.store.install('afs').then(() => null, cause => cause.code)).toBe(code);
    expect(await f.store.current('afs')).toBeUndefined();
    expect(await readdir(path.join(f.store.root, 'afs/darwin-arm64'))).toEqual([]);
  }
});


test('installation skips historical archive mtime restoration while retaining content, mode and exact inventory checks', async () => {
  const historical = new Date('2001-01-01T00:00:00Z');
  const f = await fixture({ archiveMtime: historical });
  const control = path.join(f.root, 'mtime-control'); await mkdir(control);
  await extractTar({ file: f.tarball, cwd: control, strict: true, noChmod: false, sync: true });
  const relative = 'package/dist/entry.mjs';
  expect((await lstat(path.join(control, relative))).mtimeMs).toBe(historical.getTime());
  const originalUmask = process.umask(0o077);
  try { await f.store.install('afs'); } finally { process.umask(originalUmask); }
  const installed = path.join(f.store.root, 'afs/darwin-arm64/0.1.0');
  const filename = path.join(installed, relative); const stat = await lstat(filename);
  expect(stat.mtimeMs).not.toBe(historical.getTime());
  expect(stat.mode & 0o7777).toBe(0o644);
  expect(await readFile(filename)).toEqual(await readFile(path.join(control, relative)));
  expect((await f.store.current('afs'))?.version).toBe('0.1.0');
  await chmod(filename, 0o755);
  expect(await f.store.current('afs').then(() => null, cause => cause.code)).toBe('module_file_changed');
  await chmod(filename, 0o644);
  const extra = path.join(installed, 'package/undeclared'); await writeFile(extra, 'extra');
  expect(await f.store.current('afs').then(() => null, cause => cause.code)).toBe('module_inventory_invalid');
  await rm(extra);
  const source = await readFile(filename, 'utf8'); await writeFile(filename, source.replace('process.exit', 'process.exiT'));
  expect(await f.store.current('afs').then(() => null, cause => cause.code)).toBe('module_file_changed');
});


/** Seed a read-only module tree exactly as the desktop build stages it. */
async function seedFixture() {
  const base = path.resolve('.test-data/cli-modules'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'seed-')); roots.push(root);
  const seed = path.join(root, 'bundle', 'modules'); const store = path.join(root, 'owned', 'modules');
  const version = '0.1.0'; const source = 'process.exit(0);\n';
  const dir = path.join(seed, 'afs', 'darwin-arm64', version, 'package');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'entry.mjs'), source);
  await chmod(path.join(dir, 'entry.mjs'), 0o644);
  const manifest: ModuleManifest = { schemaVersion: 1, id: 'afs', cliApiVersion: 1, platform: 'darwin', arch: 'arm64',
    entry: 'entry.mjs', files: [{ path: 'entry.mjs', sha256: createHash('sha256').update(source).digest('hex'),
      size: Buffer.byteLength(source), mode: 0o644 }] };
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: '@undefineds.co/xpod-afs-darwin-arm64',
    version, xpodModule: manifest }));
  return { root, seed, store, version };
}

test('an owned store imports a packaged capability from a READ-ONLY seed', async () => {
  const f = await seedFixture();
  // Prove the bundle stays read-only: make the seed tree unwritable.
  const { chmodSync } = await import('node:fs');
  const freeze = (dir: string): void => {
    for (const entry of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) freeze(full); else chmodSync(full, 0o444);
    }
  };
  freeze(f.seed);
  try {
    const store = new ModuleStore({ root: f.store, seed: f.seed, offline: true, platform: 'darwin', arch: 'arm64' });
    let admitted: readonly unknown[] = [];
    await store.withAdmittedModules(['afs'], async modules => { admitted = modules; });
    expect(admitted.length).toBe(1);
    // The import landed in the OWNED store, not in the bundle.
    expect(await store.current('afs')).toBeDefined();
    expect(store.root).toBe(path.resolve(f.store));
  } finally {
    const relax = (dir: string): void => {
      for (const entry of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) relax(full); else chmodSync(full, 0o644);
      }
    };
    relax(f.seed);
  }
});

test('an offline store fails closed when the seed lacks the capability', async () => {
  const f = await seedFixture();
  const empty = path.join(f.root, 'bundle-empty', 'modules'); await mkdir(empty, { recursive: true });
  const store = new ModuleStore({ root: f.store, seed: empty, offline: true, platform: 'darwin', arch: 'arm64' });
  const failure = await store.withAdmittedModules(['afs'], async () => {})
    .then(() => undefined, error => error as { message?: string });
  expect(String(failure?.message)).toContain('not staged');
});

test('seed staging preserves every manifest mode exactly, including files that start 0600', async () => {
  const f = await seedFixture();
  // A second manifest file with the other allowed mode proves the staging pass is
  // driven by the manifest, not by a hardcoded 0600/0644.
  const executable = '#!/bin/sh\nexit 0\n';
  const packageDir = path.join(f.seed, 'afs', 'darwin-arm64', f.version, 'package');
  await writeFile(path.join(packageDir, 'run.sh'), executable);
  await chmod(path.join(packageDir, 'run.sh'), 0o600);
  const manifestPath = path.join(packageDir, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { xpodModule: ModuleManifest };
  manifest.xpodModule.files.push({ path: 'run.sh',
    sha256: createHash('sha256').update(executable).digest('hex'),
    size: Buffer.byteLength(executable), mode: 0o755 });
  await writeFile(manifestPath, JSON.stringify(manifest));

  const store = new ModuleStore({ root: f.store, seed: f.seed, offline: true, platform: 'darwin', arch: 'arm64' });
  // Use the admitted module's OWN cwd: a seed import is published under the
  // packaged tree, so the location comes from the store, never from a guess.
  const admitted = await store.withAdmittedModules(['afs'], async modules => modules[0]!);
  const installed = admitted.cwd;
  // The FINAL modes are exactly the manifest's, including the file that started
  // life as 0600 in the seed.
  expect((await lstat(path.join(installed, 'entry.mjs'))).mode & 0o777).toBe(0o644);
  expect((await lstat(path.join(installed, 'run.sh'))).mode & 0o777).toBe(0o755);
  // A later admission re-verifies the same published modes.
  await store.withAdmittedModules(['afs'], async () => {});
  expect((await lstat(path.join(installed, 'run.sh'))).mode & 0o777).toBe(0o755);
});

test('a second admission reuses the already imported module', async () => {
  const f = await seedFixture();
  const store = new ModuleStore({ root: f.store, seed: f.seed, offline: true, platform: 'darwin', arch: 'arm64' });
  await store.withAdmittedModules(['afs'], async () => {});
  const first = await store.current('afs');
  await store.withAdmittedModules(['afs'], async () => {});
  expect(await store.current('afs')).toEqual(first!);
});

test('store options are per-instance and never read a process-wide snapshot', async () => {
  const f = await seedFixture();
  const previous = process.env.XPOD_MODULES_OFFLINE;
  process.env.XPOD_MODULES_OFFLINE = '1';
  try {
    // An explicit non-offline store must still be able to use its own root even
    // while the environment carries an unrelated flag.
    const store = new ModuleStore({ root: f.store, platform: 'darwin', arch: 'arm64' });
    expect(store.root).toBe(path.resolve(f.store));
  } finally {
    if (previous === undefined) delete process.env.XPOD_MODULES_OFFLINE;
    else process.env.XPOD_MODULES_OFFLINE = previous;
  }
});


/** Write one seed version directory with a real xpodModule manifest. */
async function writeSeedVersion(seed: string, version: string, source: string, id: 'afs' | 'api' = 'afs'): Promise<void> {
  const dir = path.join(seed, id, 'darwin-arm64', version, 'package');
  await mkdir(dir, { recursive: true });
  const name = id === 'afs' ? '@undefineds.co/xpod-afs-darwin-arm64' : '@undefineds.co/xpod-api-darwin-arm64';
  await writeFile(path.join(dir, 'entry.mjs'), source);
  await chmod(path.join(dir, 'entry.mjs'), 0o644);
  const manifest: ModuleManifest = { schemaVersion: 1, id, cliApiVersion: 1, platform: 'darwin', arch: 'arm64',
    entry: 'entry.mjs', files: [{ path: 'entry.mjs', sha256: createHash('sha256').update(source).digest('hex'),
      size: Buffer.byteLength(source), mode: 0o644 }] };
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version, xpodModule: manifest }));
}

test('a seed with more than one version directory is rejected as ambiguous', async () => {
  const f = await seedFixture();
  await writeSeedVersion(f.seed, '0.1.0-preview.9', 'process.exit(0);\n');
  await writeSeedVersion(f.seed, '0.1.0-preview.10', 'process.exit(0);\n');
  const store = new ModuleStore({ root: f.store, seed: f.seed, offline: true, platform: 'darwin', arch: 'arm64' });
  const failure = await store.withAdmittedModules(['afs'], async () => {})
    .then(() => null, cause => cause as { code?: string });
  expect(failure?.code).toBe('module_seed_ambiguous');
});

test('an updated same-version seed re-imports instead of reusing stale bytes', async () => {
  const f = await seedFixture();
  const store = new ModuleStore({ root: f.store, seed: f.seed, offline: true, platform: 'darwin', arch: 'arm64' });
  const oldEntry = await store.withAdmittedModules(['afs'], async modules => modules[0]!.entry);
  const first = await store.current('afs');
  // Same declared version, different packaged bytes: the seed is the authority.
  await writeSeedVersion(f.seed, f.version, 'process.exit(7);\n');
  const newEntry = await store.withAdmittedModules(['afs'], async modules => modules[0]!.entry);
  const second = await store.current('afs');
  expect(second?.version).toBe(first?.version);
  expect(second?.manifestSha256).not.toBe(first?.manifestSha256);
  expect(second?.integrity.startsWith('seed-package-sha256-')).toBe(true);
  expect(newEntry).not.toBe(oldEntry);
  expect(await readFile(oldEntry, 'utf8')).toBe('process.exit(0);\n');
  expect(await readFile(newEntry, 'utf8')).toBe('process.exit(7);\n');
});

test('a failed seed publication preserves the prior selection and its executable', async () => {
  const f = await seedFixture();
  const options = { root: f.store, seed: f.seed, offline: true, platform: 'darwin', arch: 'arm64' };
  const store = new ModuleStore(options);
  const oldEntry = await store.withAdmittedModules(['afs'], async modules => modules[0]!.entry);
  const previous = await store.current('afs');
  await writeSeedVersion(f.seed, f.version, 'process.exit(7);\n');
  const script = path.join(f.root, 'publication-fault.ts');
  await writeFile(script, `
import { mock } from 'bun:test';
const original = { ...await import('node:fs/promises') };
mock.module('node:fs/promises', () => ({ ...original, rename: async (from, to) => {
  if (String(from).includes('/.seed-')) throw Object.assign(new Error('publication fault'), { code: 'EIO' });
  return original.rename(from, to);
} }));
const { ModuleStore } = await import(${JSON.stringify(path.join(coreSource, 'module-store.ts'))});
const store = new ModuleStore(${JSON.stringify(options)});
let code;
try { await store.withAdmittedModules(['afs'], async () => {}); } catch (error) { code = error.code; }
console.log(JSON.stringify({ code, current: await store.current('afs') }));
`);
  const result = spawnSync('bun', [script], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ code: 'EIO', current: previous });
  expect(await readFile(oldEntry, 'utf8')).toBe('process.exit(0);\n');
});

test('a copy failure in the bounded staging pool drains every started copy and never publishes', async () => {
  const f = await seedFixture();
  const options = { root: f.store, seed: f.seed, offline: true, platform: 'darwin', arch: 'arm64' };
  // Several extra files so more than one pool worker is guaranteed to start.
  const packageDir = path.join(f.seed, 'afs', 'darwin-arm64', f.version, 'package');
  const manifestPath = path.join(packageDir, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { xpodModule: ModuleManifest };
  for (let index = 0; index < 16; index += 1) {
    const name = `extra-${index}.mjs`; const body = `// ${index}\n`;
    await writeFile(path.join(packageDir, name), body);
    manifest.xpodModule.files.push({ path: name,
      sha256: createHash('sha256').update(body).digest('hex'), size: Buffer.byteLength(body), mode: 0o644 });
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
  const script = path.join(f.root, 'copy-fault.ts');
  await writeFile(script, `
import { mock } from 'bun:test';
const original = { ...await import('node:fs/promises') };
let started = 0; let active = 0; let peak = 0;
mock.module('node:fs/promises', () => ({ ...original, copyFile: async (from, to, flags) => {
  // Capture THIS copy's index at entry: reading the shared counter after an await
  // would race the other workers and never select a fixed failing index.
  const index = ++started; active += 1; peak = Math.max(peak, active);
  try {
    // Every copy parks briefly, so at least one is still IN FLIGHT when the
    // failure is raised. A fail-fast regression that released the lock while a
    // copy was live would then be observable in "activeAtRejection".
    await new Promise(resolve => setTimeout(resolve, 5));
    if (index === 3) throw Object.assign(new Error('copy fault'), { code: 'EIO' });
    return await original.copyFile(from, to, flags);
  } finally { active -= 1; }
} }));
const { ModuleStore } = await import(${JSON.stringify(path.join(coreSource, 'module-store.ts'))});
const store = new ModuleStore(${JSON.stringify(options)});
let code; let activeAtRejection = -1;
try { await store.withAdmittedModules(['afs'], async () => {}); }
catch (error) { code = error.code; activeAtRejection = active; }
const current = await store.current('afs');
// The published root for a SEED import is packaged/<manifestSha>/<id>/<platform>/:
// read the REAL location, never a guessed legacy one.
const manifestSha = ${JSON.stringify(createHash('sha256').update(JSON.stringify(manifest)).digest('hex'))};
const publishedRoot = ${JSON.stringify(path.join(f.store, 'packaged'))} + '/' + manifestSha + '/afs/darwin-arm64';
const entries = await original.readdir(publishedRoot);
const leftovers = entries.filter(name => name.startsWith('.seed-'));
const publishedVersionTree = entries.includes(${JSON.stringify(f.version)});
// Lock must be immediately reusable: a task still copying would hold it.
let second;
try { await store.withAdmittedModules(['afs'], async () => {}); second = 'admitted'; }
catch (error) { second = error.code; }
console.log(JSON.stringify({ code, current: current ?? null, entries, leftovers, publishedVersionTree,
  activeAtRejection, peak, second, manifestSha, publishedRoot }));
`);
  const result = spawnSync('bun', [script], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`fault child exited ${result.status}: ${result.stderr}`);
  const observed = JSON.parse(result.stdout) as { code?: string; current: unknown; entries: string[];
    leftovers: string[]; publishedVersionTree: boolean; activeAtRejection: number; peak: number;
    second: string; manifestSha: string };
  // The injected error surfaces unchanged and nothing was published.
  expect(observed.code).toBe('EIO');
  expect(observed.current).toBeNull();
  // The REAL published root is packaged/<manifestSha>/... and it holds no module
  // and no leftover .seed-* stage: cleanup did not race an in-flight copy.
  expect(/^[a-f0-9]{64}$/u.test(observed.manifestSha)).toBe(true);
  // `parent` (packaged/<sha>/afs/darwin-arm64) may legitimately be pre-created
  // before staging; what must NOT exist is the published VERSION tree itself.
  expect(observed.publishedVersionTree).toBe(false);
  expect(observed.leftovers).toEqual([]);
  // At least one copy was genuinely in flight at rejection, and every started
  // copy had settled by the time the rejection surfaced (active == 0).
  expect(observed.peak).toBeGreaterThan(1);
  expect(observed.activeAtRejection).toBe(0);
  // The lock is free enough for a clean retry.
  expect(observed.second).toBe('admitted');
});

test('an upgraded seed version replaces the older selection without partial reuse', async () => {
  const f = await seedFixture();
  const first = new ModuleStore({ root: f.store, seed: f.seed, offline: true, platform: 'darwin', arch: 'arm64' });
  const oldEntry = await first.withAdmittedModules(['afs'], async modules => modules[0]!.entry);
  expect((await first.current('afs'))?.version).toBe(f.version);
  // A new bundle carries exactly one newer version.
  await rm(path.join(f.seed, 'afs', 'darwin-arm64', f.version), { recursive: true, force: true });
  await writeSeedVersion(f.seed, '0.2.0', 'process.exit(0);\n');
  const upgraded = new ModuleStore({ root: f.store, seed: f.seed, offline: true, platform: 'darwin', arch: 'arm64' });
  await upgraded.withAdmittedModules(['afs'], async () => {});
  const current = await upgraded.current('afs');
  expect(current?.version).toBe('0.2.0');
  // The old bytes are untouched on disk but are no longer the selection.
  expect(await readFile(oldEntry, 'utf8'))
    .toBe('process.exit(0);\n');
});

test('a seed whose manifest names another capability is rejected', async () => {
  const f = await seedFixture();
  const dir = path.join(f.seed, 'afs', 'darwin-arm64', f.version, 'package');
  const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  pkg.name = '@undefineds.co/xpod-api-darwin-arm64';
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg));
  const store = new ModuleStore({ root: f.store, seed: f.seed, offline: true, platform: 'darwin', arch: 'arm64' });
  const failure = await store.withAdmittedModules(['afs'], async () => {})
    .then(() => null, cause => cause as { code?: string });
  expect(failure?.code).toBe('module_seed_invalid');
});

test('an offline store never reaches the registry even with a working fetch', async () => {
  const f = await seedFixture();
  let calls = 0;
  const store = new ModuleStore({ root: f.store, seed: f.seed, offline: true, platform: 'darwin', arch: 'arm64',
    fetch: async () => { calls += 1; throw new Error('registry must not be contacted'); } });
  await store.withAdmittedModules(['afs'], async () => {});
  expect(calls).toBe(0);
});

test('the packaged store context is explicit, complete and per-call', async () => {
  const { moduleStoreContext } = await import('../src/core');
  // A normal developer CLI carries none of the three values.
  expect(moduleStoreContext({})).toEqual({});
  // A packaged runtime must supply the whole triple.
  expect(moduleStoreContext({ XPOD_MODULES_ROOT: '/owned/modules', XPOD_MODULES_SEED: '/bundle/modules',
    XPOD_MODULES_OFFLINE: '1' })).toEqual({ root: '/owned/modules', seed: '/bundle/modules', offline: true });
  // Half a context is refused rather than degrading to $HOME or the registry.
  expect(() => moduleStoreContext({ XPOD_MODULES_SEED: '/bundle/modules', XPOD_MODULES_OFFLINE: '1' }))
    .toThrow(/XPOD_MODULES_ROOT/);
  expect(() => moduleStoreContext({ XPOD_MODULES_ROOT: '/owned/modules', XPOD_MODULES_OFFLINE: '1' }))
    .toThrow(/XPOD_MODULES_SEED/);
  // Offline without the flag is refused: a packaged runtime must never fall back.
  expect(() => moduleStoreContext({ XPOD_MODULES_ROOT: '/owned/modules', XPOD_MODULES_SEED: '/bundle/modules' }))
    .toThrow(/XPOD_MODULES_OFFLINE/);
});

test('two stores built from different contexts never share state', async () => {
  const { moduleStoreContext } = await import('../src/core');
  const a = new ModuleStore({ ...moduleStoreContext({ XPOD_MODULES_ROOT: '/tmp/a', XPOD_MODULES_SEED: '/tmp/seed-a',
    XPOD_MODULES_OFFLINE: '1' }), platform: 'darwin', arch: 'arm64' });
  const b = new ModuleStore({ ...moduleStoreContext({ XPOD_MODULES_ROOT: '/tmp/b', XPOD_MODULES_SEED: '/tmp/seed-b',
    XPOD_MODULES_OFFLINE: '1' }), platform: 'darwin', arch: 'arm64' });
  expect(a.root).toBe(path.resolve('/tmp/a'));
  expect(b.root).toBe(path.resolve('/tmp/b'));
  expect(a.root).not.toBe(b.root);
});

test('offline admission preserves the requested callback order', async () => {
  const f = await seedFixture();
  await writeSeedVersion(f.seed, f.version, 'process.exit(0);\n', 'api');
  const store = new ModuleStore({ root: f.store, seed: f.seed, offline: true, platform: 'darwin', arch: 'arm64' });
  const seen = await store.withAdmittedModules(['api', 'afs'], async modules => modules.map(row => row.installed.id));
  expect(seen).toEqual(['api', 'afs']);
});

test('a corrupted warm tree is rejected instead of being silently re-imported', async () => {
  const f = await seedFixture();
  const store = new ModuleStore({ root: f.store, seed: f.seed, offline: true, platform: 'darwin', arch: 'arm64' });
  await store.withAdmittedModules(['afs'], async () => {});
  const current = await store.current('afs');
  const record = await readFile(path.join(store.root, 'afs/darwin-arm64/current.json'), 'utf8');
  const entry = path.join(store.root, 'packaged', current!.manifestSha256, 'afs/darwin-arm64', f.version, 'package/entry.mjs');
  await writeFile(entry, 'process.exit(9);\n');
  const failure = await store.withAdmittedModules(['afs'], async () => {}).then(() => null, cause => cause as { code?: string });
  expect(failure?.code).toBe('module_file_changed');
  expect(await readFile(path.join(store.root, 'afs/darwin-arm64/current.json'), 'utf8')).toBe(record);
});

test('a second offline admission is refused while the first action runs, then succeeds', async () => {
  const f = await seedFixture();
  const store = new ModuleStore({ root: f.store, seed: f.seed, offline: true, platform: 'darwin', arch: 'arm64' });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const firstEntered = new Promise<void>(resolve => { entered = resolve; });
  const first = store.withAdmittedModules(['afs'], async () => { entered(); await gate; });
  await firstEntered;
  let consumed = false;
  const second = await store.withAdmittedModules(['afs'], async () => { consumed = true; })
    .then(() => null, cause => cause as { code?: string });
  expect(consumed).toBe(false);
  expect(second?.code).toBe('module_busy');
  release(); await first;
  await store.withAdmittedModules(['afs'], async () => { consumed = true; });
  expect(consumed).toBe(true);
});

test('inverse two-module offline admissions fail fast without overlapping', async () => {
  const f = await seedFixture();
  await writeSeedVersion(f.seed, f.version, 'process.exit(0);\n', 'api');
  const store = new ModuleStore({ root: f.store, seed: f.seed, offline: true, platform: 'darwin', arch: 'arm64' });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  const forward = store.withAdmittedModules(['api', 'afs'], async modules => {
    expect(modules.map(row => row.installed.id)).toEqual(['api', 'afs']);
    entered = true; await gate;
  });
  while (!entered) await new Promise(resolve => setTimeout(resolve, 5));
  // The inverse request must not enter a second action, and must fail fast on the
  // held module lock rather than waiting on the first action.
  const inverseFailure = await store.withAdmittedModules(['afs', 'api'], async () => {}).then(() => null, cause => cause as { code?: string });
  expect(inverseFailure?.code).toBe('module_busy');
  release(); await forward;
  const inverse = await store.withAdmittedModules(['afs', 'api'], async modules => modules.map(row => row.installed.id));
  expect(inverse).toEqual(['afs', 'api']);
});
