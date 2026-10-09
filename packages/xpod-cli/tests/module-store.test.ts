import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { c as packTar } from 'tar';
import { ModuleStore, type ModuleManifest } from '../src/module-store';
import { MODULE_CATALOG } from '../src/module-catalog';

const roots: string[] = [];
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
  await mkdir(f.store.root, { recursive: true }); await mkdir(path.join(f.store.root, 'afs-darwin-arm64.lock'));
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
