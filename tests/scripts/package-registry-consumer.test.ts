import { afterEach, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import type { Server } from 'node:http';

const require = createRequire(import.meta.url);
const { createRegistry } = require('../../scripts/check-package-registry-consumer.cjs');
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function fixture() {
  const artifact = { manifest: { name: '@undefineds.co/xpod', version: '0.4.8', dependencies: { local: '1.0.0' }, optionalDependencies: { native: '0.4.8' }, bundledDependencies: ['local'] }, bytes: Buffer.from('exact tarball bytes'), integrity: 'sha512-example' };
  const server: Server = createRegistry(artifact);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return { artifact, url: `http://127.0.0.1:${address.port}` };
}
it('serves the exact artifact and its original bundle contract through registry metadata', async () => {
  const { artifact, url } = await fixture();
  const metadata = await (await fetch(`${url}/@undefineds.co%2fxpod`)).json();
  expect(metadata.versions['0.4.8']).toMatchObject(artifact.manifest);
  expect(metadata.versions['0.4.8'].dist.integrity).toBe(artifact.integrity);
  const response = await fetch(metadata.versions['0.4.8'].dist.tarball);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(artifact.bytes);
});
it('redirects only dependency paths to the public registry without forwarding query secrets', async () => {
  const { url } = await fixture();
  const response = await fetch(`${url}/react?token=do-not-forward`, { redirect: 'manual' });
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe('https://registry.npmjs.org/react');
});
it('refuses publishing or mutation methods', async () => {
  const { url } = await fixture();
  expect((await fetch(`${url}/@undefineds.co%2fxpod`, { method: 'PUT', body: '{}' })).status).toBe(405);
});
it('rejects malformed encoded paths', async () => {
  const { url } = await fixture();
  expect((await fetch(`${url}/%ZZ`)).status).toBe(400);
});
