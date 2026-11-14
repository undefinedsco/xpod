import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';

const require = createRequire(import.meta.url);
const { installLocalTarballViaRegistry, withSmokeTarball, createSmokeTarball } = require('../../scripts/package-smoke-install.cjs');
const { createRegistry, publishArtifact } = require('../../scripts/check-package-registry-consumer.cjs');

const repoRoot = process.cwd();
const roots: string[] = [];
// Prove the fixture never writes to the repository root's manifest or lockfile.
const rootManifest = fs.readFileSync(path.join(repoRoot, 'package.json'));
const rootLock = fs.existsSync(path.join(repoRoot, 'bun.lock')) ? fs.readFileSync(path.join(repoRoot, 'bun.lock')) : undefined;

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  expect(fs.readFileSync(path.join(repoRoot, 'package.json')).equals(rootManifest)).toBe(true);
  if (rootLock) expect(fs.readFileSync(path.join(repoRoot, 'bun.lock')).equals(rootLock)).toBe(true);
});

function scratch(): string {
  fs.mkdirSync('.test-data', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('.test-data/package-smoke-install-'));
  roots.push(root);
  return root;
}

function consumerTarget(root: string): { target: string; cache: string } {
  const target = path.join(root, 'target');
  const cache = path.join(root, 'cache');
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'consumer', version: '1.0.0', private: true }));
  return { target, cache };
}

// A bounded, fully offline Xpod tarball: the only dependency is a private package
// bundled through the same package-local `file:` edge run-npm-pack writes.
function fixtureTarball(root: string, manifestExtra: Record<string, unknown> = {}): string {
  const packageDir = path.join(root, 'package');
  const localDir = path.join(packageDir, 'node_modules', '@undefineds.co', 'local');
  fs.mkdirSync(localDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: '@undefineds.co/xpod',
    version: '0.0.0-fixture',
    dependencies: { '@undefineds.co/local': 'file:./node_modules/@undefineds.co/local' },
    bundledDependencies: [ '@undefineds.co/local' ],
    ...manifestExtra,
  }));
  fs.writeFileSync(path.join(localDir, 'package.json'), JSON.stringify({ name: '@undefineds.co/local', version: '1.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(localDir, 'index.js'), 'module.exports = 42;\n');
  const tarball = path.join(root, 'fixture.tgz');
  execFileSync('tar', [ 'czf', tarball, '-C', root, 'package' ]);
  return tarball;
}

// A public dependency that exists only in this fixture's local mirror; the
// fixture Xpod tarball depends on it so the install must reach the mirror.
function publicDependencyTarball(root: string): Buffer {
  const staging = path.join(root, 'public-staging');
  const packageDir = path.join(staging, 'package');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@fixture/public', version: '1.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(packageDir, 'index.js'), 'module.exports = "public";\n');
  const tarball = path.join(root, 'public.tgz');
  execFileSync('tar', [ 'czf', tarball, '-C', staging, 'package' ]);
  return fs.readFileSync(tarball);
}

function artifactFor(tarball: string) {
  const bytes = fs.readFileSync(tarball);
  const manifest = JSON.parse(execFileSync('tar', [ 'xOf', tarball, 'package/package.json' ], { encoding: 'utf8' }));
  return { tarball, bytes, manifest, integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}` };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function installedLocal(root: string): string {
  return path.join(root, 'target', 'node_modules', '@undefineds.co', 'xpod', 'node_modules', '@undefineds.co', 'local', 'index.js');
}

function evidenceDirs(root: string): string[] {
  const cache = path.join(root, 'cache');
  return fs.existsSync(cache) ? fs.readdirSync(cache).filter((name) => name.startsWith('registry-publish-')) : [];
}

describe('package-smoke-install Bun local tarball transport', () => {
  it('installs a bundled private file edge through the real loopback publication capture', async () => {
    const root = scratch();
    const tarball = fixtureTarball(root);
    const { target, cache } = consumerTarget(root);

    const registry = await installLocalTarballViaRegistry(tarball, target, cache, process.env);

    expect(registry).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(fs.readFileSync(installedLocal(root), 'utf8')).toBe('module.exports = 42;\n');
    expect(evidenceDirs(root)).toEqual([]);
  }, 600_000);

  it('closes the loopback server and removes evidence when publication is refused', async () => {
    const root = scratch();
    const tarball = fixtureTarball(root, { publishConfig: { registry: 'https://must-not-publish.invalid' } });
    const { target, cache } = consumerTarget(root);

    await expect(installLocalTarballViaRegistry(tarball, target, cache, process.env)).rejects.toThrow(/publishConfig/);
    expect(fs.existsSync(installedLocal(root))).toBe(false);
    expect(evidenceDirs(root)).toEqual([]);
  }, 600_000);

  it('refuses to install without a consumer manifest so it cannot write to an ancestor project', async () => {
    const root = scratch();
    const tarball = fixtureTarball(root);
    const target = path.join(root, 'target');
    const cache = path.join(root, 'cache');
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(cache, { recursive: true });

    await expect(installLocalTarballViaRegistry(tarball, target, cache, process.env)).rejects.toThrow(/consumer manifest/);
    expect(fs.readdirSync(target)).toEqual([]);
    expect(evidenceDirs(root)).toEqual([]);
  }, 600_000);

  it('uses the configured upstream mirror for a public dependency while keeping Xpod and private edges local', async () => {
    const root = scratch();
    const publicTgz = publicDependencyTarball(root);
    const tarball = fixtureTarball(root, {
      dependencies: {
        '@undefineds.co/local': 'file:./node_modules/@undefineds.co/local',
        '@fixture/public': '1.0.0',
      },
    });
    const requests: string[] = [];
    const mirror = http.createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url!, 'http://localhost').pathname);
      requests.push(pathname);
      if (pathname === '/mirror/@fixture/public') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          name: '@fixture/public',
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name: '@fixture/public',
              version: '1.0.0',
              dist: {
                tarball: `http://127.0.0.1:${(mirror.address() as { port: number }).port}/mirror/@fixture/public/-/public-1.0.0.tgz`,
                integrity: `sha512-${crypto.createHash('sha512').update(publicTgz).digest('base64')}`,
                shasum: crypto.createHash('sha1').update(publicTgz).digest('hex'),
              },
            },
          },
        }));
        return;
      }
      if (pathname === '/mirror/@fixture/public/-/public-1.0.0.tgz') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(publicTgz);
        return;
      }
      res.writeHead(404); res.end();
    });
    const mirrorOrigin = await listen(mirror);
    const { target, cache } = consumerTarget(root);
    try {
      await installLocalTarballViaRegistry(tarball, target, cache, {
        ...process.env,
        XPOD_INSTALL_REGISTRY: `${mirrorOrigin}/mirror`,
      });
      expect(requests).toContain('/mirror/@fixture/public');
      expect(fs.readFileSync(installedLocal(root), 'utf8')).toBe('module.exports = 42;\n');
      const publicIndex = [
        path.join(target, 'node_modules', '@fixture', 'public', 'index.js'),
        path.join(target, 'node_modules', '@undefineds.co', 'xpod', 'node_modules', '@fixture', 'public', 'index.js'),
      ].find((candidate) => fs.existsSync(candidate));
      expect(publicIndex).toBeTruthy();
      expect(fs.readFileSync(publicIndex!, 'utf8')).toBe('module.exports = "public";\n');
      expect(evidenceDirs(root)).toEqual([]);
    } finally {
      await close(mirror);
    }
  }, 600_000);
});

describe('loopback registry upstream routing', () => {
  it('redirects public dependencies to the configured upstream, not npmjs', async () => {
    const root = scratch();
    const server = createRegistry(artifactFor(fixtureTarball(root)), 'token', 'https://mirror.example/npm/');
    const registry = await listen(server);
    try {
      const response = await fetch(`${registry}/react`, { redirect: 'manual' });
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('https://mirror.example/npm/react');
    } finally {
      await close(server);
    }
  }, 60_000);

  it('keeps the npmjs default when no upstream is given', async () => {
    const root = scratch();
    const server = createRegistry(artifactFor(fixtureTarball(root)), 'token');
    const registry = await listen(server);
    try {
      const response = await fetch(`${registry}/react`, { redirect: 'manual' });
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('https://registry.npmjs.org/react');
    } finally {
      await close(server);
    }
  }, 60_000);

  it('forwards only the path, dropping the query string', async () => {
    const root = scratch();
    const server = createRegistry(artifactFor(fixtureTarball(root)), 'token', 'https://mirror.example/npm');
    const registry = await listen(server);
    try {
      const response = await fetch(`${registry}/react?token=do-not-forward`, { redirect: 'manual' });
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('https://mirror.example/npm/react');
    } finally {
      await close(server);
    }
  }, 60_000);

  it('serves the pinned Xpod metadata locally while public deps use the configured upstream', async () => {
    const root = scratch();
    const artifact = artifactFor(fixtureTarball(root));
    const token = 'fixture-token';
    const server = createRegistry(artifact, token, 'https://mirror.example/npm');
    const registry = await listen(server);
    const evidence = fs.mkdtempSync(path.join(root, 'publish-'));
    try {
      await publishArtifact(artifact, registry, token, evidence);
      const xpod = await fetch(`${registry}/@undefineds.co/xpod`, { redirect: 'manual' });
      expect(xpod.status).toBe(200);
      expect((await xpod.json()).name).toBe('@undefineds.co/xpod');
      const dep = await fetch(`${registry}/react`, { redirect: 'manual' });
      expect(dep.headers.get('location')).toBe('https://mirror.example/npm/react');
    } finally {
      await close(server);
      fs.rmSync(evidence, { recursive: true, force: true });
    }
  }, 120_000);
});


describe('temporary material lifetimes', () => {
  const { withOwnedTempRoot } = require('../../scripts/lib/owned-temp-root.cjs');
  function tempParent(): string {
    const parent = scratch();
    vi.spyOn(os, 'tmpdir').mockReturnValue(parent);
    return parent;
  }
  const digest = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

  it('cleans successful owned material and preserves the returned result', async () => {
    const parent = tempParent();
    const value = await withOwnedTempRoot('xpod-bun-single-', async (root: string) => {
      fs.writeFileSync(path.join(root, 'fixture'), 'small');
      return 42;
    });
    expect(value).toBe(42); expect(fs.readdirSync(parent)).toEqual([]);
  });
  it('preserves the original operation error after cleaning', async () => {
    const parent = tempParent(); const original = new Error('original build failed');
    await expect(withOwnedTempRoot('xpod-bun-single-', () => { throw original; })).rejects.toBe(original);
    expect(fs.readdirSync(parent)).toEqual([]);
  });
  it('retains operation and cleanup failures together', async () => {
    const parent = tempParent(), original = new Error('operation failed'), secondary = new Error('cleanup failed');
    vi.spyOn(fs, 'rmSync').mockImplementation(() => { throw secondary; });
    let error: any;
    try { await withOwnedTempRoot('xpod-bun-single-', () => { throw original; }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual([original, secondary]); expect(error.cause).toBe(original);
    vi.restoreAllMocks(); expect(fs.readdirSync(parent)).toHaveLength(1);
  });
  it('reports cleanup failure after an otherwise successful operation', async () => {
    tempParent(); const secondary = new Error('cleanup failed');
    vi.spyOn(fs, 'rmSync').mockImplementation(() => { throw secondary; });
    await expect(withOwnedTempRoot('xpod-bun-single-', () => 42)).rejects.toBe(secondary);
  });
  it('removes a replaced root symlink without traversing its target', async () => {
    const parent = tempParent(), outside = path.join(parent, 'keep'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'original'), 'keep');
    await withOwnedTempRoot('xpod-bun-single-', (root: string) => {
      fs.rmSync(root, { recursive: true }); fs.symlinkSync(outside, root, 'dir');
    });
    expect(fs.readdirSync(parent)).toEqual(['keep']); expect(fs.readFileSync(path.join(outside, 'original'), 'utf8')).toBe('keep');
  });
  for (const fail of [false, true]) it(`cleans smoke material after ${fail ? 'failure' : 'success'} without deleting original or consumer`, async () => {
    const parent = tempParent(), original = fixtureTarball(parent, { optionalDependencies: { unused: '1.0.0' } });
    const before = digest(original), target = consumerTarget(parent).target, failure = new Error('original probe failed'); let derived = '';
    const pending = withSmokeTarball(original, async (archive: string) => {
      derived = archive; expect(fs.existsSync(archive)).toBe(true);
      const manifest = JSON.parse(execFileSync('tar', ['xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
      expect(manifest.optionalDependencies).toBeUndefined();
      fs.writeFileSync(path.join(target, 'installed'), 'preserve consumer');
      if (fail) throw failure; return 42;
    });
    if (fail) await expect(pending).rejects.toBe(failure); else expect(await pending).toBe(42);
    expect(fs.existsSync(path.dirname(derived))).toBe(false); expect(digest(original)).toBe(before);
    expect(fs.readFileSync(path.join(target, 'installed'), 'utf8')).toBe('preserve consumer');
  });
  it('cleans when tarball preparation fails before the operation begins', async () => {
    const parent = tempParent(), file = path.join(parent, 'invalid.tgz'); fs.writeFileSync(file, 'not a gzip');
    const operation = vi.fn(); await expect(withSmokeTarball(file, operation)).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled(); expect(fs.readdirSync(parent)).toEqual(['invalid.tgz']);
  });
  it('retains the legacy path-returning API until its caller cleans up', () => {
    const parent = tempParent(), file = fixtureTarball(parent), before = digest(file);
    const derived = createSmokeTarball(file); expect(typeof derived).toBe('string'); expect(fs.existsSync(derived)).toBe(true);
    fs.rmSync(path.dirname(derived), { recursive: true }); expect(digest(file)).toBe(before);
  });
  it('does not create temporary material for a registry specification', async () => {
    const parent = tempParent(); expect(await withSmokeTarball('@fixture/package@1.0.0', (spec: string) => spec)).toBe('@fixture/package@1.0.0');
    expect(fs.readdirSync(parent)).toEqual([]);
  });
  it.skipIf(process.platform === 'win32')('actual smoke main cleans derived material when the installer cannot start', () => {
    const parent = tempParent(), file = fixtureTarball(parent), before = digest(file), tmp = path.join(parent, 'temp'); fs.mkdirSync(tmp);
    let error: any;
    try { execFileSync(process.execPath, [path.join(repoRoot, 'scripts/package-smoke-install.cjs'), file, path.join(parent, 'consumer'), path.join(parent, 'cache'), 'npm'], {
      cwd: repoRoot, env: { PATH: '/usr/bin:/bin', TMPDIR: tmp, TEMP: tmp, TMP: tmp }, stdio: 'pipe',
    }); } catch (caught) { error = caught; }
    expect(error.status).toBe(1); expect(error.stderr.toString()).toContain('npm'); expect(fs.readdirSync(tmp)).toEqual([]); expect(digest(file)).toBe(before);
  });
  // These child commands are controlled lifecycle fixtures, not package or auth acceptance.
  for (const phase of ['success', 'install-failure', 'probe-failure']) it.skipIf(process.platform === 'win32')(`actual smoke main cleans owned material after ${phase}`, () => {
    const parent = tempParent(), file = fixtureTarball(parent), before = digest(file), tmp = path.join(parent, 'temp'), bin = path.join(parent, 'bin');
    fs.mkdirSync(tmp); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'npm'), `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[2]==='install'){const archive=process.argv.at(-1);if(!fs.existsSync(archive))throw Error('derived archive missing');fs.writeFileSync('derived-path',archive);fs.writeFileSync('installed','keep');if(${JSON.stringify(phase)}==='install-failure'){console.error('expected-install-failure');process.exit(17)}}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'node'), `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync('probe-ran','yes');if(${JSON.stringify(phase)}==='probe-failure'){console.error('expected-probe-failure');process.exit(19)}\n`, { mode: 0o755 });
    const target = path.join(parent, 'consumer'); let error: any;
    try { execFileSync(process.execPath, [path.join(repoRoot, 'scripts/package-smoke-install.cjs'), file, target, path.join(parent, 'cache'), 'npm'], {
      cwd: repoRoot, env: { PATH: bin + ':/usr/bin:/bin', HOME: parent, TMPDIR: tmp, TEMP: tmp, TMP: tmp }, stdio: 'pipe',
    }); } catch (caught) { error = caught; }
    if (phase === 'success') expect(error).toBeUndefined(); else { expect(error.status).toBe(1); expect(error.stderr.toString()).toContain('expected-' + phase); }
    expect(fs.readdirSync(tmp)).toEqual([]); expect(digest(file)).toBe(before);
    expect(fs.readFileSync(path.join(target, 'installed'), 'utf8')).toBe('keep');
    expect(fs.existsSync(path.dirname(fs.readFileSync(path.join(target, 'derived-path'), 'utf8')))).toBe(false);
    expect(fs.existsSync(path.join(target, 'probe-ran'))).toBe(phase !== 'install-failure');
  });
  it('actual single-build failure exits naturally after cleaning its own root', () => {
    const parent = tempParent(), tmp = path.join(parent, 'temp'); fs.mkdirSync(tmp);
    const hook = path.join(parent, 'preload.cjs');
    fs.writeFileSync(hook, `const Module=require('node:module'),fs=require('node:fs'),cp=require('node:child_process');const original=Module._load;Module._load=function(id,...args){if(id==='esbuild')return{build:async()=>{throw Error('expected-single-build-failure')}};if(id.includes('ensureSupportedBun'))return{ensureSupportedBun(){}};return original.call(this,id,...args)};const exists=fs.existsSync;fs.existsSync=f=>/dist[\\/]index.js$|dist[\\/]components[\\/]components.jsonld$|config[\\/]local.json$/.test(String(f))||exists(f);const spawn=cp.spawnSync;cp.spawnSync=(command,args,...rest)=>command==='bun'&&args[0]==='--version'?{status:0,stdout:'1.4.2',stderr:''}:spawn(command,args,...rest);`);
    let error: any;
    try { execFileSync(process.execPath, ['--require', hook, path.join(repoRoot, 'scripts/build-bun-single.js')], { cwd: repoRoot,
      env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp }, stdio: 'pipe' }); } catch (caught) { error = caught; }
    expect(error.status).toBe(1); expect(error.stderr.toString()).toContain('expected-single-build-failure'); expect(fs.readdirSync(tmp)).toEqual([]);
  });
});
