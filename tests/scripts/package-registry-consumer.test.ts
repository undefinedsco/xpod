import { afterEach, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { readArtifact, createRegistry, publishArtifact, isolatedEnvironment } = require('../../scripts/check-package-registry-consumer.cjs');
const { applyPlatformOptionalDependencies } = require('../../scripts/platform-binaries.cjs');
const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture(publish = true, manifestOverride: Record<string, unknown> = {}) {
  fs.mkdirSync('.test-data', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('.test-data/registry-publication-'));
  fs.chmodSync(root, 0o700); roots.push(root);
  const manifest = { name: '@undefineds.co/xpod', version: '0.4.9', dependencies: {}, optionalDependencies: applyPlatformOptionalDependencies({}, '0.4.9').optionalDependencies, bundledDependencies: ['local'], scripts: { prepublishOnly: 'exit 42', publish: 'exit 42', postpublish: 'exit 42' }, ...manifestOverride };
  fs.mkdirSync(path.join(root, 'package/node_modules/local'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package/package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, 'package/node_modules/local/package.json'), JSON.stringify({ name: 'local', version: '1.0.0' }));
  const tarball = path.join(root, 'fixture.tgz');
  execFileSync('tar', ['czf', tarball, '-C', root, 'package']);
  const artifact = readArtifact(tarball);
  const token = 'fixture-only-not-a-real-token';
  const server: Server = createRegistry(artifact, token);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const url = `http://127.0.0.1:${address.port}`;
  if (publish) await publishArtifact(artifact, url, token, root);
  return { artifact, url, token, root };
}
it('serves real npm publication normalization and exact optional tarball without lifecycle scripts', async () => {
  const { artifact, url, root } = await fixture();
  const metadata = await (await fetch(`${url}/@undefineds.co%2fxpod`)).json();
  expect(metadata.versions['0.4.9'].bundleDependencies).toEqual(['local']);
  expect(metadata.versions['0.4.9'].bundledDependencies).toBeUndefined();
  expect(metadata.versions['0.4.9'].dependencies.local).toBe('*');
  expect(metadata.versions['0.4.9'].optionalDependencies).toEqual(artifact.manifest.optionalDependencies);
  expect(metadata.versions['0.4.9'].dist.integrity).toBe(artifact.integrity);
  const response = await fetch(metadata.versions['0.4.9'].dist.tarball);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(artifact.bytes);
  expect(fs.existsSync(path.join(root, 'publish.npmrc'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'publish-global.npmrc'))).toBe(false);
});
it('redirects only public dependency paths without query secrets', async () => {
  const { url } = await fixture(false);
  const response = await fetch(`${url}/react?token=do-not-forward`, { redirect: 'manual' });
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe('https://registry.npmjs.org/react');
});
it('refuses unauthorized, other-package, and duplicate publication', async () => {
  const { url, token } = await fixture();
  expect((await fetch(`${url}/@undefineds.co%2fxpod`, { method: 'PUT', body: '{}' })).status).toBe(403);
  const init = { method: 'PUT', body: '{}', headers: { Authorization: `Bearer ${token}` } };
  expect((await fetch(`${url}/another-package`, init)).status).toBe(403);
  expect((await fetch(`${url}/@undefineds.co%2fxpod`, init)).status).toBe(409);
});
it('rejects malformed encoded paths and GET before publishing', async () => {
  const { url } = await fixture(false);
  expect((await fetch(`${url}/%ZZ`)).status).toBe(400);
  expect((await fetch(`${url}/@undefineds.co%2fxpod`)).status).toBe(404);
});
it('rejects a manifest registry override before spawning npm', async () => {
  const { artifact, url, token, root } = await fixture(false, { publishConfig: { registry: 'https://must-not-publish.invalid' } });
  await expect(publishArtifact(artifact, url, token, root)).rejects.toThrow('publishConfig overrides');
  expect(fs.existsSync(path.join(root, 'publish.npmrc'))).toBe(false);
  expect((await fetch(`${url}/@undefineds.co%2fxpod`)).status).toBe(404);
});
it('strips inherited npm credentials and registry overrides while isolating both npmrc files', () => {
  const saved = { ...process.env };
  try {
    process.env.NPM_TOKEN = 'real-token-must-not-pass';
    process.env.NODE_AUTH_TOKEN = 'real-token-must-not-pass';
    process.env.npm_config_registry = 'https://must-not-publish.invalid';
    process.env.NPM_CONFIG_GLOBALCONFIG = '/not-safe';
    const env = isolatedEnvironment('/fixture/user', '/fixture/global');
    expect(env.NPM_TOKEN).toBeUndefined(); expect(env.NODE_AUTH_TOKEN).toBeUndefined();
    expect(env.npm_config_registry).toBeUndefined();
    expect(env.NPM_CONFIG_GLOBALCONFIG).toBe('/fixture/global');
    expect(env.NPM_CONFIG_USERCONFIG).toBe('/fixture/user');
  } finally { process.env = saved; }
});

it('refuses nonloopback publication before invoking npm', async () => {
  const { artifact, token, root } = await fixture(false);
  await expect(publishArtifact(artifact, 'https://registry.npmjs.org', token, root)).rejects.toThrow('loopback');
});
it('cleans isolated npm configuration and project anchor when publication fails', async () => {
  const { artifact, url, token, root } = await fixture(false);
  await expect(publishArtifact(artifact, url, token + '-wrong', root)).rejects.toThrow('child failed');
  for (const name of ['publish.npmrc', 'publish-global.npmrc', 'package.json']) expect(fs.existsSync(path.join(root, name))).toBe(false);
});
it('rejects off-origin tarballs and modified attachment bytes', async () => {
  const { artifact, url, token } = await fixture(false);
  const version = { ...artifact.manifest, dist: { tarball: 'https://external.invalid/xpod.tgz', integrity: artifact.integrity, shasum: 'wrong' } };
  const payload = { name: artifact.manifest.name, versions: { [artifact.manifest.version]: version }, _attachments: { 'xpod.tgz': { data: artifact.bytes.toString('base64'), length: artifact.bytes.length } } };
  const send = () => fetch(`${url}/@undefineds.co%2fxpod`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
  expect((await send()).status).toBe(400);
  version.dist.tarball = `${url}/@undefineds.co/xpod/-/xpod.tgz`;
  payload._attachments['xpod.tgz'].data = Buffer.from('changed').toString('base64');
  expect((await send()).status).toBe(400);
  expect((await fetch(`${url}/@undefineds.co%2fxpod`)).status).toBe(404);
});

it('does not remove a pre-existing file if isolated setup fails', async () => {
  const { artifact, url, token, root } = await fixture(false);
  const existing = path.join(root, 'package.json');
  fs.writeFileSync(existing, 'must remain unchanged');
  await expect(publishArtifact(artifact, url, token, root)).rejects.toThrow();
  expect(fs.readFileSync(existing, 'utf8')).toBe('must remain unchanged');
  expect(fs.existsSync(path.join(root, 'publish.npmrc'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'publish-global.npmrc'))).toBe(false);
});

it('prevents publication PUT from using inherited outbound proxies while preserving consumer configuration', () => {
  const saved = { ...process.env };
  try {
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'PROXY', 'proxy', 'http_proxy', 'https_proxy', 'all_proxy']) process.env[key] = 'http://outside.invalid';
    const publisher = isolatedEnvironment('/fixture/user', '/fixture/global', true);
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'PROXY', 'proxy', 'http_proxy', 'https_proxy', 'all_proxy']) expect(publisher[key]).toBeUndefined();
    expect(publisher.NO_PROXY).toBe('127.0.0.1,localhost');
    expect(publisher.no_proxy).toBe('127.0.0.1,localhost');
    expect(isolatedEnvironment('/fixture/user', '/fixture/global').HTTP_PROXY).toBe('http://outside.invalid');
  } finally { process.env = saved; }
});

it('rejects release artifacts missing native platform optional dependencies before publication', async () => {
  await expect(fixture(false, { optionalDependencies: undefined })).rejects.toThrow('platform optional dependencies');
});
it.each(['0.4.8', '^0.4.9'])('rejects native platform version %s when it is not the exact artifact version', async (version) => {
  await expect(fixture(false, { optionalDependencies: applyPlatformOptionalDependencies({}, version).optionalDependencies })).rejects.toThrow('platform optional dependencies');
});
it('accepts exact platform versions for release candidates', async () => {
  const version = '0.4.9-rc.123';
  const { artifact } = await fixture(false, { version, optionalDependencies: applyPlatformOptionalDependencies({}, version).optionalDependencies });
  expect(artifact.manifest.version).toBe(version);
});
