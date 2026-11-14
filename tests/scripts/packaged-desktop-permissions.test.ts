import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { JSHandle } from '@playwright/test';
import { universalAccess } from '@inrupt/solid-client';
import { createSolidPermissionCapability } from '../../packages/extension-sdk/src/solid-permissions';
import type { MountedBrowserAiConnections } from '../helpers/browserXpodRuntime';
import type { Page } from '@playwright/test';
import { expect, it } from 'vitest';
import { acceptMountedPodPermissions, inspectFreshMountedTargets, MountedPermissionError,
  observeOwnedPodTraffic } from '../../scripts/helpers/packaged-desktop-permissions';

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

it('the REAL acceptMountedPodPermissions refuses a foreign or unbound client BEFORE any request', async () => {
  const binding = { webId: 'https://cloud.example/card#me', podUrl: 'https://local.example/b/' };
  const run = async (client: Record<string, unknown>) => {
    let requests = 0;
    const mounted = { controller: { client: { ...client,
      getServiceAccess: async () => { requests += 1; return {}; } }, authorizeService: async () => undefined },
      host: { solid: { permissions: { revokeAgentAccess: async () => ({ status: 'missing' }) } } } };
    const handle = {
      // Executes the helper's ACTUAL evaluate callbacks against a real controller.
      evaluate: async (fn: (arg: any, input?: any) => unknown, input?: unknown) => fn(mounted, input),
      dispose: async () => undefined,
    } as unknown as JSHandle<MountedBrowserAiConnections>;
    // captureBrowserAiConnections resolves the mounted handle via waitForFunction.
    const page = { waitForFunction: async () => handle } as unknown as Page;
    let error: unknown;
    try { await acceptMountedPodPermissions(page, binding); } catch (cause) { error = cause; }
    return { error: error as MountedPermissionError | undefined, requests };
  };
  // Same origin, same webId, different Pod root -> refused, no request issued.
  const foreign = await run({ webId: binding.webId, apiBase: 'https://local.example', podBaseUrl: 'https://local.example/a/' });
  expect(foreign.error?.condition).toBe('service-access');
  expect(foreign.error?.detail).toBe('foreign-pod');
  expect(foreign.requests).toBe(0);
  // No binding at all -> refused, no request issued.
  const unbound = await run({ webId: binding.webId, apiBase: 'https://local.example' });
  expect(unbound.error?.detail).toBe('unbound-client');
  expect(unbound.requests).toBe(0);
  // Trailing-slash variance on the SAME root must reach the real GET.
  const same = await run({ webId: binding.webId, apiBase: 'https://local.example',
    podBaseUrl: binding.podUrl.replace(/\/$/u, '') });
  expect(same.requests).toBe(1);
  // The stub GET returns an empty object, so the REAL parser rejects the
  // descriptor and the closed token names a descriptor category — proving the
  // guard let the request through and the parse path produced its own detail.
  expect(same.error?.condition).toBe('service-access');
  expect(same.error?.detail).toBe('applet-id');
});

it('the REAL helper yields DISTINCT closed detail tokens for GET-403 vs an invalid descriptor', async () => {
  const binding = { webId: 'https://cloud.example/card#me', podUrl: 'https://local.example/b/' };
  const run = async (getServiceAccess: () => Promise<unknown>) => {
    const mounted = { controller: { client: { webId: binding.webId,
      apiBase: 'https://local.example', podBaseUrl: binding.podUrl, getServiceAccess },
      authorizeService: async () => undefined },
      host: { solid: { permissions: { revokeAgentAccess: async () => ({ status: 'missing' }) } } } };
    const handle = { evaluate: async (fn: (arg: any, input?: any) => unknown, input?: unknown) => fn(mounted, input),
      dispose: async () => undefined } as unknown as JSHandle<MountedBrowserAiConnections>;
    const page = { waitForFunction: async () => handle } as unknown as Page;
    try { await acceptMountedPodPermissions(page, binding); return undefined; }
    catch (error) { return error as MountedPermissionError; }
  };
  // An HTTP failure surfaces its bounded status token.
  const forbidden = await run(async () => {
    throw Object.assign(new Error('bearer secret-token-value https://local.example/private'),
      { name: 'AiConnectionsRequestError', status: 403 });
  });
  // A descriptor the parser refuses surfaces a descriptor token, not the HTTP one.
  const descriptor = await run(async () => ({ appletId: 'wrong', service: {}, resources: [] }));
  expect(forbidden?.condition).toBe('service-access');
  expect(descriptor?.condition).toBe('service-access');
  expect(forbidden?.detail).toBe('http-403');
  expect(descriptor?.detail).toBe('applet-id');
  expect(forbidden?.detail).not.toBe(descriptor?.detail);
  // Closed tokens only: no message/body/URL/token text in what is published.
  for (const error of [forbidden, descriptor]) {
    const published = JSON.stringify({ code: 'pod-permission', detail: error?.detail });
    expect(published).not.toMatch(/secret-token-value|https?:\/\/|bearer|private/u);
  }
  // 503 is the fallback the REAL handler maps unknown/wiring/issuer failures to
  // for this exact endpoint, so it must have its own token rather than
  // collapsing into request-error.
  const unavailable = await run(async () => {
    throw Object.assign(new Error('wiring failed: bearer secret-token-value https://local.example/private'),
      { name: 'AiConnectionsRequestError', status: 503 });
  });
  expect(unavailable?.condition).toBe('service-access');
  expect(unavailable?.detail).toBe('http-503');
  expect(unavailable?.detail).not.toBe(forbidden?.detail);
  // Privacy: no message, URL or token text may reach the published token.
  expect(String(unavailable?.detail)).not.toMatch(/secret-token-value|https?:\/\/|bearer|private/u);
  // An arbitrary HTTP status still cannot invent a new token.
  const weird = await run(async () => {
    throw Object.assign(new Error('x'), { name: 'AiConnectionsRequestError', status: 418 });
  });
  expect(weird?.detail).toBe('request-error');
});

/**
 * The bug this pins: Playwright serialises a thrown browser error with only
 * message/stack/name, so a service-access HTTP failure used to lose its class,
 * name AND numeric status and always degrade to `transport-error`. The helper
 * must classify INSIDE the page and return a data envelope.
 *
 * This crosses the REAL installed Chromium with the REAL helper path from
 * acceptMountedPodPermissions down to the failing GET — it does not copy the
 * callback and does not fake a throw mapping.
 */
it('classifies service-access HTTP failures inside the real Chromium page boundary', async () => {
  const { chromium } = await import('@playwright/test');
  const binding = { webId: 'https://id.example/card#me', podUrl: 'https://local.example/b/' };
  const hostile = 'https://id.example/private?token=abc Authorization: Bearer sk-live-9f2c1d password=hunter2';

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');

    // Install a committed fiber tree whose controller.client is the ONLY source
    // of the GET, so captureBrowserAiConnections and the real helper run for
    // real and the request happens inside this browser.
    const install = async (mode: string, status?: number) => await page.evaluate(
      ({ webId, podUrl, hostileText, kind, code }: { webId: string; podUrl: string; hostileText: string; kind: string; code?: number }) => {
        class AiConnectionsRequestError extends Error {
          readonly status: number;
          readonly payload: unknown;
          constructor(payload: unknown, httpStatus: number) {
            super(`AI Connection request failed (HTTP ${httpStatus}) ${hostileText}`);
            this.name = 'AiConnectionsRequestError';
            this.status = httpStatus;
            this.payload = payload;
          }
        }
        const client = {
          webId, apiBase: new URL(podUrl).origin, podBaseUrl: podUrl,
          getServiceAccess: async () => {
            if (kind === 'http') throw new AiConnectionsRequestError({ error: 'denied' }, code as number);
            if (kind === 'transport') { const e = new TypeError(`Failed to fetch ${hostileText}`); throw e; }
            if (kind === 'missing') return undefined;
            return { appletId: 'co.undefineds.ai-connections', service: { webId, label: 'X' }, resources: [], invocation: { apiKey: 'k' } };
          },
        };
        const host = { solid: {
          session: { getSnapshot: () => ({ status: 'authenticated', webId }), fetch: async () => { throw new Error('unused'); } },
          permissions: { revokeAgentAccess: async () => ({ status: 'missing' }) },
          pod: { status: 'ready', current: { webId, podUrl } },
        }, capabilities: {} };
        const applet = { memoizedState: { memoizedState: [host, []],
          next: { memoizedState: [{ layout: 'two-pane', controller: { client, authorizeService: async () => undefined } }, []] } } };
        const root = document.getElementById('root') as unknown as Record<string, unknown>;
        root.__reactContainer$real = { stateNode: { current: { memoizedProps: { value: {} }, child: applet } } };
      }, { webId: binding.webId, podUrl: binding.podUrl, hostileText: hostile, kind: mode, code: status });

    const run = async (mode: string, status?: number) => {
      await install(mode, status);
      let error: unknown;
      try { await acceptMountedPodPermissions(page, binding); } catch (cause) { error = cause; }
      return error as MountedPermissionError | undefined;
    };

    // Allowed statuses keep their own token instead of collapsing to transport-error.
    for (const status of [401, 403, 503]) {
      const error = await run('http', status);
      expect(error?.condition).toBe('service-access');
      expect(error?.detail).toBe(`http-${status}`);
      // Hostile text must never be published.
      expect(JSON.stringify({ d: error?.detail, m: error?.message })).not.toMatch(/sk-live|Bearer|hunter2|token=abc/u);
    }

    // A non-allowlisted status stays inside request-error.
    expect((await run('http', 418))?.detail).toBe('request-error');
    // A real transport failure stays transport-error.
    expect((await run('transport'))?.detail).toBe('transport-error');
    // Success keeps the RAW descriptor intact and reaches the REAL parser, which
    // rejects the deliberately empty resources with its own token — proving the
    // envelope's ok:true branch hands the descriptor through untouched.
    expect((await run('success'))?.detail).toBe('empty-resources');
  } finally {
    await browser.close();
  }
});
