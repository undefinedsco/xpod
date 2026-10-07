import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { JSHandle } from '@playwright/test';
import { universalAccess } from '@inrupt/solid-client';
import { createSolidPermissionCapability } from '../../packages/extension-sdk/src/solid-permissions';
import type { MountedBrowserAiConnections } from '../helpers/browserXpodRuntime';
import type { Page } from '@playwright/test';
import { expect, it } from 'vitest';
import { inspectFreshMountedTargets, observeOwnedPodTraffic } from '../../scripts/helpers/packaged-desktop-permissions';

it('observes all Pod mutations on canonical and local transport without touching credentials or mocking fetch', () => {
  const page = Object.assign(new EventEmitter(), { url: () => 'http://127.0.0.1:42300/ai-connections' });
  const traffic = observeOwnedPodTraffic(page as unknown as Page, 'https://local.example/own/');
  const emit = (url: string, method: string): void => {
    page.emit('request', { url: () => url, method: () => method,
      headers: () => { throw new Error('Observer must not read credential headers'); },
      postData: () => { throw new Error('Observer must not read secret bodies'); } });
  };
  try {
    emit('https://local.example/own/target.acl', 'PATCH');
    emit('http://127.0.0.1:42300/own/target.acl', 'PUT');
    emit('http://127.0.0.1:42300/own/target.ttl', 'GET');
    emit('https://local.example/other/target.acl', 'PATCH');
    emit('https://foreign.example/own/target.acl', 'PATCH');
    emit('https://id.example/authorize?response_type=code&client_id=private', 'GET');
    expect(traffic.snapshot()).toEqual({ writes: 2, authorizationRequests: 1 });
  } finally { traffic.stop(); }
  emit('https://local.example/own/target.acl', 'PATCH');
  expect(traffic.snapshot()).toEqual({ writes: 2, authorizationRequests: 1 });
  expect(page.listenerCount('request')).toBe(0);
});

it('uses observed HTTP404 for absent targets and real installed SDK readback for existing ungranted targets', async () => {
  const acp = 'http://www.w3.org/ns/solid/acp#';
  const calls: string[] = [];
  let base = '';
  const server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    response.setHeader('content-type', 'text/turtle');
    if (request.url === '/pod/absent.ttl') { response.writeHead(404).end(); return; }
    if (request.url === '/pod/refused.ttl') { response.writeHead(403).end(); return; }
    if (request.url === '/pod/existing.ttl') {
      response.setHeader('link', `<${base}pod/existing.acl>; rel="acl"`);
      response.writeHead(200).end(); return;
    }
    if (request.url === '/pod/existing.acl') {
      response.setHeader('link', `<${acp}AccessControlResource>; rel="type"`);
      response.writeHead(200).end(request.method === 'HEAD' ? undefined
        : `<${base}pod/existing.acl> a <${acp}AccessControlResource>; <${acp}resource> <${base}pod/existing.ttl>.`);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing protocol fixture address');
  base = `http://127.0.0.1:${address.port}/`;
  const binding = { webId: 'https://cloud.example/card#me', podUrl: `${base}pod/` };
  const capability = createSolidPermissionCapability({ fetch });
  const host = { solid: { session: { getSnapshot: () => ({ status: 'authenticated', webId: binding.webId }), fetch },
    pod: { status: 'ready', current: binding }, permissions: capability } };
  const handle = { evaluate: async (fn: (host: unknown, input: unknown) => unknown, input: unknown) => fn({ host }, input) } as unknown as JSHandle<MountedBrowserAiConnections>;
  const request = { appletId: 'test', service: { webId: 'https://service.example/#me', label: 'service' },
    resources: ['absent', 'existing'].map(id => ({ id, url: `${binding.podUrl}${id}.ttl`,
      mediaType: 'text/turtle' as const, access: { read: true, write: true, append: true } })) };
  try {
    await expect(universalAccess.getAgentAccess(request.resources[0].url, request.service.webId, { fetch }))
      .rejects.toHaveProperty('response.status', 404);
    expect((await capability.inspectAgentAccess({ ...request, resources: [request.resources[0]] })).status).toBe('permissionDenied');
    expect((await capability.inspectAgentAccess({ ...request, resources: [request.resources[1]] })).status).toBe('missing');
    await expect(inspectFreshMountedTargets(handle, request, binding.podUrl)).resolves.toBeUndefined();
    await expect(inspectFreshMountedTargets(handle, { ...request, resources: [{ ...request.resources[0], url: `${binding.podUrl}refused.ttl` }] }, binding.podUrl)).rejects.toThrow('Cannot inspect');
    expect(calls.some(call => call === 'GET /pod/existing.acl')).toBe(true);
    expect(calls.filter(call => !/^(?:HEAD|GET) /u.test(call))).toEqual([]);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
