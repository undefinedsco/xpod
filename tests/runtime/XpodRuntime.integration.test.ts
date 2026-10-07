import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import dns from 'node:dns';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startXpodRuntime, type XpodRuntimeHandle } from '../../src/runtime/XpodRuntime';
import { localServiceUrl } from '../../src/runtime/bootstrap';
import { createGatewayAdminProxyHeaders } from '../../src/runtime/GatewayAdminProxyAuth';
import { resolveTestRuntimeTransport } from '../helpers/runtimeTransport';
import { startTestRuntime } from '../helpers/testRuntime';
import { setupAccount, type AccountSetup } from '../integration/helpers/solidAccount';
import { createTestDir } from '../utils/sqlite';
import { createSolidLocalRouteFetch } from '../../packages/solid-sdk/src/local-route-fetch';
import { FAKE_QLEVER_LOCAL_RUNTIME_COMMAND } from '../helpers/qleverRuntime';

function listen(server: http.Server): Promise<{ origin: string }> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('mock server did not bind to a TCP port'));
        return;
      }
      resolve({ origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

const isolatedLocalEnv = {
  XPOD_SECRET_CELL_KEY_ID: 'runtime-test-cell',
  XPOD_SECRET_CELL_KEY: Buffer.alloc(32, 13).toString('base64'),
  XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: FAKE_QLEVER_LOCAL_RUNTIME_COMMAND,
};

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}


describe('XpodRuntime Local first-run Cloud registration', () => {
  let runtime: XpodRuntimeHandle;
  let cloudServer: http.Server;
  let cloudOrigin = '';
  let setupPath = '';
  const cloudRequests: Array<{ method?: string; url?: string; body?: string }> = [];
  const managedProvisionCode = `${Buffer.from(JSON.stringify({
    nodeId: 'auto-node',
    signalApiUrl: 'https://api.undefineds.co/',
    routeAccessToken: 'route-token-issued-by-mock-cloud',
    routeAccessTokenExp: Math.floor(Date.now() / 1000) + 3_600,
  })).toString('base64url')}.test-signature`;

  beforeAll(async () => {
    cloudServer = http.createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        cloudRequests.push({ method: request.method, url: request.url, body });
        response.setHeader('content-type', 'application/json');

        if (request.method === 'POST' && request.url === '/provision/nodes') {
          const parsed = body ? JSON.parse(body) as { nodeId?: string } : {};
          response.statusCode = 201;
          response.end(JSON.stringify({
            nodeId: parsed.nodeId ?? 'auto-node',
            nodeToken: 'node-token-issued-by-mock-cloud',
            serviceToken: 'svc-issued-by-mock-cloud',
            provisionCode: managedProvisionCode,
            publicUrl: 'https://auto-node.undefineds.test/',
            spDomain: 'auto-node.undefineds.test',
          }));
          return;
        }

        if (request.method === 'GET' && request.url?.startsWith('/api/v1/ddns/')) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: 'not found' }));
          return;
        }

        if (request.method === 'POST' && request.url === '/api/v1/ddns/allocate') {
          response.statusCode = 200;
          response.end(JSON.stringify({
            success: true,
            subdomain: 'auto-node',
            domain: 'undefineds.test',
            fqdn: 'auto-node.undefineds.test',
            createdAt: new Date().toISOString(),
          }));
          return;
        }

        response.statusCode = 200;
        response.end(JSON.stringify({ ok: true }));
      });
    });
    cloudOrigin = (await listen(cloudServer)).origin;

    const runtimeRoot = createTestDir('xpod-runtime-auto-provision');
    setupPath = path.join(runtimeRoot, '.xpod-cloud-registration.json');
    runtime = await startTestRuntime(startXpodRuntime, {
      mode: 'local',
      transport: resolveTestRuntimeTransport('port'),
      runtimeRoot,
      logLevel: 'warn',
      env: {
        ...isolatedLocalEnv,
        SOLID_OIDC_ISSUER: cloudOrigin,
        XPOD_LOCAL_SETUP_PATH: setupPath,
        XPOD_PROVIDER_ID: 'local-auto',
        XPOD_NODE_ID: 'auto-node',
        CSS_ALLOWED_HOSTS: 'localhost,127.0.0.1',
      },
    });
  }, 90_000);

  afterAll(async () => {
    await runtime?.stop();
    await close(cloudServer);
  });

  it('reaches its bound listener when localhost name resolution stalls', async () => {
    const originalLookup = dns.lookup;
    const delayed: Array<ReturnType<typeof setTimeout>> = [];
    let localLookups = 0;
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation(((hostname: string, options: unknown, callback: unknown) => {
      const resolve = () => Reflect.apply(originalLookup, dns, [hostname, options, callback]);
      if (hostname === 'localhost') {
        localLookups += 1;
        delayed.push(setTimeout(resolve, 10_000));
      } else {
        resolve();
      }
    }) as typeof dns.lookup);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await runtime.fetch(new Request(new URL('/provision/status', runtime.baseUrl)), { signal: controller.signal });
      expect(response.status).toBe(200);
      expect(response.url).toBe(new URL('/provision/status', runtime.baseUrl).href);
      await expect(response.json()).resolves.toMatchObject({ registered: true });
      expect(localLookups).toBe(0);
    } finally {
      clearTimeout(deadline);
      delayed.forEach(clearTimeout);
      lookup.mockRestore();
    }
  });

  it('persists Cloud-issued credentials and enables Local provision routes in the same process', async () => {
    const registration = cloudRequests.find((entry) => entry.method === 'POST' && entry.url === '/provision/nodes');
    expect(registration).toBeTruthy();
    expect(JSON.parse(registration!.body || '{}')).toMatchObject({
      nodeId: 'auto-node',
      domainMode: 'managed',
    });

    expect(JSON.parse(fs.readFileSync(setupPath, 'utf8'))['local-auto']).toMatchObject({
      nodeId: 'auto-node',
      nodeToken: 'node-token-issued-by-mock-cloud',
      serviceToken: 'svc-issued-by-mock-cloud',
      provisionCode: managedProvisionCode,
      publicUrl: 'https://auto-node.undefineds.test/',
      spDomain: 'auto-node.undefineds.test',
      cloudApiUrl: `${cloudOrigin}/`,
    });

    const statusResponse = await runtime.fetch('/provision/status');
    expect(statusResponse.status).toBe(200);
    const status = await statusResponse.json() as {
      registered?: boolean;
      nodeId?: string;
      publicUrl?: string;
      spDomain?: string;
    };
    expect(status).toMatchObject({
      registered: true,
      nodeId: 'auto-node',
      publicUrl: 'https://auto-node.undefineds.test/',
      spDomain: 'auto-node.undefineds.test',
    });

    const createResponse = await runtime.fetch('/provision/pods', {
      method: 'POST',
      headers: {
        authorization: 'Bearer svc-issued-by-mock-cloud',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        podName: 'autoalice',
        webId: `${cloudOrigin}/autoalice/profile/card#me`,
      }),
    });
    expect(createResponse.status).toBe(201);
    // Managed Local: the Cloud-issued WebID owns the Pod and this node hosts its storage.
    await expect(createResponse.json()).resolves.toMatchObject({
      success: true,
      webId: `${cloudOrigin}/autoalice/profile/card#me`,
      // The node keeps hosting security: storage is served under the registered public URL.
      podUrl: 'https://auto-node.undefineds.test/autoalice/',
    });
  });

  it('reads a Cloud-owned Pod storage through the local Gateway route', async () => {
    const canonicalPod = new URL('https://auto-node.undefineds.test/autoalice/');
    const listenerUrl = localServiceUrl('127.0.0.1', runtime.ports.gateway!);
    const localPod = new URL('/autoalice/', listenerUrl);
    const networkTargets: string[] = [];
    const routedFetch = createSolidLocalRouteFetch({
      fetch: async(input, init) => {
        networkTargets.push(input instanceof Request ? input.url : String(input));
        return fetch(input, init);
      },
      routes: () => [{
        canonicalBaseUrl: canonicalPod.href,
        localBaseUrl: localPod.href,
      }],
    });
    const getResponse = await routedFetch(canonicalPod, { headers: { accept: 'text/turtle' } });
    expect(getResponse.status).toBe(200);
    // The Cloud owns the profile card, so what this node serves is the Pod storage itself.
    await expect(getResponse.text()).resolves.toContain('http://www.w3.org/ns/pim/space#Storage');
    expect(networkTargets).toEqual([ localPod.href ]);
    expect(new URL(networkTargets[0]!).origin).toBe(listenerUrl);
  });


});

describe('XpodRuntime', () => {
  let runtime: XpodRuntimeHandle;
  let account: AccountSetup | null;

  beforeAll(async () => {
    runtime = await startTestRuntime(startXpodRuntime, {
      mode: 'local',
      open: true,
      transport: resolveTestRuntimeTransport('port'),
      runtimeRoot: createTestDir('xpod-runtime'),
      logLevel: 'warn',
      env: isolatedLocalEnv,
    });

    account = await setupAccount(runtime.baseUrl.replace(/\/$/, ''), 'xpod-open');
  }, 90_000);

  afterAll(async () => {
    await runtime?.stop();
  });

  it('starts the whole xpod stack in process', async () => {
    const response = await runtime.fetch('/service/status');

    expect(response.ok).toBe(true);

    const services = await response.json() as Array<{ name: string; status: string }>;
    expect(Array.isArray(services)).toBe(true);
    expect(services.some((item) => item.name === 'css' && item.status === 'running')).toBe(true);
    expect(services.some((item) => item.name === 'api' && item.status === 'running')).toBe(true);
  });

  it('opens api routes without authorization headers', async () => {
    const response = await runtime.fetch('/v1/nodes');

    expect(response.status).toBe(501);
  });

  it('opens css writes without authorization headers', async () => {
    expect(account).toBeTruthy();

    const targetUrl = new URL('runtime-open-test.txt', account!.podUrl).href;
    const putResponse = await runtime.fetch(targetUrl, {
      method: 'PUT',
      headers: {
        'content-type': 'text/plain',
      },
      body: 'hello from runtime',
    });

    expect([ 201, 204 ]).toContain(putResponse.status);

    const getResponse = await runtime.fetch(targetUrl);
    expect(getResponse.status).toBe(200);
    await expect(getResponse.text()).resolves.toContain('hello from runtime');
  });
});

describe('XpodRuntime admin proxy authorization lifecycle', () => {
  let runtime: XpodRuntimeHandle;
  let previousAdminToken: string | undefined;
  const cssRunnerStarts: Array<{ shorthand: Record<string, string | number | boolean> }> = [];

  beforeAll(async () => {
    previousAdminToken = process.env.XPOD_ADMIN_TOKEN;
    delete process.env.XPOD_ADMIN_TOKEN;

    const runtimeRoot = createTestDir('xpod-runtime-admin-proxy-auth');
    const envFile = path.join(runtimeRoot, '.env.local');
    fs.writeFileSync(envFile, 'CSS_BASE_URL=http://localhost:3000/\n', 'utf8');

    runtime = await startTestRuntime(startXpodRuntime, {
      mode: 'local',
      open: true,
      transport: resolveTestRuntimeTransport('port'),
      runtimeRoot,
      envFile,
      logLevel: 'warn',
      env: {
        ...isolatedLocalEnv,
        XPOD_SECRET_CELL_KEY_ID: 'admin-proxy-test-cell',
        XPOD_SECRET_CELL_KEY: Buffer.alloc(32, 7).toString('base64'),
      },
      cssRunner: {
        name: 'admin-proxy-auth-css-stub',
        start: async(options) => {
          cssRunnerStarts.push({ shorthand: options.shorthand });
          const server = http.createServer((_request, response) => {
            response.statusCode = 404;
            response.end('not found');
          });
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(Number(options.shorthand.port), '127.0.0.1', () => resolve());
          });
          return {
            stop: async(): Promise<void> => {
              await close(server);
            },
          } as any;
        },
      },
      gatewayClientRemoteAddressResolver: (req) => String(req.headers['x-test-remote-address'] ?? req.socket.remoteAddress ?? ''),
    });
  }, 90_000);

  afterAll(async () => {
    await runtime?.stop();
    if (previousAdminToken === undefined) {
      delete process.env.XPOD_ADMIN_TOKEN;
    } else {
      process.env.XPOD_ADMIN_TOKEN = previousAdminToken;
    }
  });

  it('does not grant admin capabilities or mutations to an external original client through the real gateway runner', async () => {
    // Admin reads are loopback-or-token only, so an external original client
    // cannot obtain the capability report at all; mutations stay forbidden too.
    const status = await readAdminStatus('203.0.113.25', {}, 403);
    expect(status.error).toBe('Forbidden');
    expect(status).not.toHaveProperty('capabilities');

    const mutation = await writeAdminConfig('203.0.113.25');
    expect(mutation.status).toBe(403);
  });

  it('passes the runtime-scoped gateway auth secret to the CSS runner', async () => {
    // A retried start runs the runner again, so the assertion is about the start that survived.
    const start = cssRunnerStarts.at(-1);
    expect(start).toBeDefined();
    expect(start!.shorthand.gatewayAdminProxyAuthSecret).toEqual(expect.any(String));
    expect(start!.shorthand.gatewayAdminProxyAuthSecret).not.toBe('admin-proxy-test-secret');
  });

  it('allows a loopback original client through the real gateway runner', async () => {
    const status = await readAdminStatus('127.0.0.1');
    expect(status.capabilities.services.lifecycle.restart.supported).toBe(true);
    expect(status.capabilities.services.configuration.write.supported).toBe(true);

    const mutation = await writeAdminConfig('127.0.0.1');
    expect(mutation.status).toBe(200);
  });

  it('rejects forged gateway markers supplied by an external client', async () => {
    const forgedMarker = createGatewayAdminProxyHeaders({
      secret: 'forged-client-secret',
      method: 'PUT',
      url: '/api/admin/config',
      originalClientLoopback: true,
    }) as Record<string, string>;

    const mutation = await writeAdminConfig('203.0.113.25', {
      ...forgedMarker,
      'x-forwarded-for': '127.0.0.1',
      'x-forwarded-host': 'localhost',
    });
    expect(mutation.status).toBe(403);
  });

  it('allows an external original client with XPOD_ADMIN_TOKEN through the real gateway runner', async () => {
    process.env.XPOD_ADMIN_TOKEN = 'runtime-admin-token';
    const status = await readAdminStatus('203.0.113.25', { 'x-xpod-admin-token': 'runtime-admin-token' });
    expect(status.capabilities.services.lifecycle.restart.supported).toBe(true);
    expect(status.capabilities.services.configuration.write.supported).toBe(true);

    const mutation = await writeAdminConfig('203.0.113.25', { 'x-xpod-admin-token': 'runtime-admin-token' });
    expect(mutation.status).toBe(200);
  });

  async function readAdminStatus(remoteAddress: string, headers: Record<string, string> = {}, expectedStatus = 200): Promise<any> {
    const response = await runtime.fetch('/api/admin/status', {
      headers: {
        ...headers,
        'x-test-remote-address': remoteAddress,
      },
    });
    expect(response.status).toBe(expectedStatus);
    return response.json();
  }

  async function writeAdminConfig(remoteAddress: string, headers: Record<string, string> = {}): Promise<Response> {
    return runtime.fetch('/api/admin/config', {
      method: 'PUT',
      headers: {
        ...headers,
        'content-type': 'application/json',
        'x-test-remote-address': remoteAddress,
      },
      body: JSON.stringify({ env: { CSS_LOGGING_LEVEL: 'debug' } }),
    });
  }
});

describe('XpodRuntime standalone profile authorization', () => {
  let runtime: XpodRuntimeHandle;

  beforeAll(async () => {
    runtime = await startTestRuntime(startXpodRuntime, {
      mode: 'local',
      transport: resolveTestRuntimeTransport('port'),
      runtimeRoot: createTestDir('xpod-runtime-standalone-profile'),
      logLevel: 'warn',
      env: {
        ...isolatedLocalEnv,
        SOLID_OIDC_ISSUER: 'http://localhost:5600/',
      },
    });
  }, 90_000);

  afterAll(async () => {
    await runtime?.stop();
  });

  it('serves an account-created public profile card with storage without authorization headers', async () => {
    const createdAccount = await setupAccount(runtime.baseUrl.replace(/\/$/, ''), 'profile-standalone');

    expect(createdAccount).toBeTruthy();

    await expectPublicProfileCard(runtime, createdAccount!.webId, createdAccount!.podUrl);
  });

});

describe('XpodRuntime seeded profile authorization', () => {
  let runtime: XpodRuntimeHandle;
  let runtimeRoot: string;

  beforeAll(async () => {
    runtimeRoot = createTestDir('xpod-runtime-seeded-profile');
    const seedConfig = path.join(runtimeRoot, 'seed.json');
    fs.writeFileSync(seedConfig, JSON.stringify([
      { email: 'seeded-profile-a@example.test', password: 'test123456', pods: [{ name: 'seeded-profile-a' }] },
      { email: 'seeded-profile-b@example.test', password: 'test123456', pods: [{ name: 'seeded-profile-b' }] },
    ]));

    runtime = await startTestRuntime(startXpodRuntime, {
      mode: 'local',
      transport: resolveTestRuntimeTransport('port'),
      runtimeRoot,
      logLevel: 'warn',
      seedConfig,
      env: {
        ...isolatedLocalEnv,
        SOLID_OIDC_ISSUER: 'http://localhost:5600/',
      },
    });
  }, 90_000);

  afterAll(async () => {
    await runtime?.stop();
  });

  it.each([
    ['first', 'seeded-profile-a'],
    ['second', 'seeded-profile-b'],
  ] as const)('serves the %s seeded public profile card with storage without authorization headers', async (_label, podName) => {
    const podUrl = new URL(`${podName}/`, runtime.baseUrl).toString();
    const webId = new URL('profile/card#me', podUrl).toString();

    await expectPublicProfileCard(runtime, webId, podUrl);
  });
});

async function expectPublicProfileCard(runtime: XpodRuntimeHandle, webId: string, podUrl: string): Promise<void> {
  const profileResponse = await runtime.fetch(webId.split('#')[0], {
    headers: {
      accept: 'text/turtle',
    },
  });

  expect(profileResponse.status).toBe(200);
  const body = await profileResponse.text();
  expect(body).toContain(webId);
  expect(body).toContain('http://www.w3.org/ns/solid/terms#oidcIssuer');
  expect(body).toContain('http://www.w3.org/ns/solid/terms#storage');
  expect(body).toContain(podUrl);
}

describe('XpodRuntime Local SP OIDC key material', () => {
  let runtime: XpodRuntimeHandle;
  let cloudServer: http.Server;
  let cloudOrigin = '';
  const cloudRequests: string[] = [];

  beforeAll(async () => {
    cloudServer = http.createServer((request, response) => {
      cloudRequests.push(request.url ?? '');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        keys: [{ kid: 'external-cloud-key', kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }],
      }));
    });
    cloudOrigin = (await listen(cloudServer)).origin;

    runtime = await startTestRuntime(startXpodRuntime, {
      mode: 'local',
      transport: resolveTestRuntimeTransport('port'),
      runtimeRoot: createTestDir('xpod-runtime-local-sp-oidc'),
      logLevel: 'warn',
      env: {
        ...isolatedLocalEnv,
        SOLID_OIDC_ISSUER: `${cloudOrigin}/`,
      },
    });
  }, 90_000);

  afterAll(async () => {
    await runtime?.stop();
    await close(cloudServer);
  });

  it('serves discovery and JWKS from the local SP, not the external account issuer', async () => {
    const [configResponse, jwksResponse] = await Promise.all([
      runtime.fetch('/.well-known/openid-configuration', {
        headers: { accept: 'application/json' },
      }),
      runtime.fetch('/.oidc/jwks', {
        headers: { accept: 'application/json' },
      }),
    ]);

    expect(configResponse.status).toBe(200);
    expect(jwksResponse.status).toBe(200);

    const config = await configResponse.json() as { issuer?: string; jwks_uri?: string };
    const jwks = await jwksResponse.json() as { keys?: Array<{ kid?: string }> };

    expect(config.issuer).toContain(new URL(runtime.baseUrl).host);
    expect(config.jwks_uri).toContain(new URL(runtime.baseUrl).host);
    expect(jwks.keys?.some((key) => key.kid === 'external-cloud-key')).toBe(false);
    expect(cloudRequests).not.toContain('/.well-known/openid-configuration');
    expect(cloudRequests).not.toContain('/.oidc/jwks');
  });
});

describe('XpodRuntime SP provisioning authorization', () => {
  const spDomain = 'sp-provisioning.nodes.undefineds.test';
  const canonicalBaseUrl = `https://${spDomain}/`;
  const provisionCode = `${Buffer.from(JSON.stringify({
    nodeId: 'sp-provisioning',
    signalApiUrl: 'https://api.undefineds.test/',
    routeAccessToken: 'route-token-issued-by-test',
    routeAccessTokenExp: Math.floor(Date.now() / 1000) + 3_600,
  })).toString('base64url')}.test-signature`;
  let runtime: XpodRuntimeHandle;
  let cloudServer: http.Server;
  let cloudOrigin = '';

  beforeAll(async () => {
    cloudServer = http.createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET' && request.url?.startsWith('/api/v1/ddns/')) {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/v1/ddns/allocate') {
        response.statusCode = 200;
        response.end(JSON.stringify({
          success: true,
          subdomain: 'sp-provisioning',
          domain: 'nodes.undefineds.test',
          fqdn: spDomain,
          createdAt: new Date().toISOString(),
        }));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/v1/ddns/sp-provisioning') {
        response.statusCode = 200;
        response.end(JSON.stringify({
          success: true,
          subdomain: 'sp-provisioning',
          domain: 'nodes.undefineds.test',
          fqdn: spDomain,
          updatedAt: new Date().toISOString(),
        }));
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not found' }));
    });
    cloudOrigin = (await listen(cloudServer)).origin;

    runtime = await startTestRuntime(startXpodRuntime, {
      mode: 'local',
      transport: resolveTestRuntimeTransport('port'),
      runtimeRoot: createTestDir('xpod-runtime-sp-provisioning'),
      logLevel: 'warn',
      env: {
        ...isolatedLocalEnv,
        XPOD_NODE_ID: 'sp-provisioning',
        XPOD_NODE_TOKEN: 'test-node-token',
        XPOD_SERVICE_TOKEN: 'test-service-token',
        XPOD_PROVISION_CODE: provisionCode,
        XPOD_PUBLIC_URL: canonicalBaseUrl,
        XPOD_SP_DOMAIN: spDomain,
        XPOD_TUNNEL_PROVIDER: 'none',
        SOLID_OIDC_ISSUER: cloudOrigin,
      },
    });
  }, 90_000);

  afterAll(async () => {
    await runtime?.stop();
    await close(cloudServer);
  });

  it('serves the provisioned public Pod storage without authorization headers', async () => {
    // Managed Local: the Cloud-issued WebID owns the Pod; this node hosts the storage and the
    // Cloud keeps the profile card.
    const webId = new URL('/alice/profile/card#me', cloudOrigin).toString();
    const storageUrl = new URL('/alice/', canonicalBaseUrl).toString();
    const createResponse = await runtime.fetch('/provision/pods', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-service-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        podName: 'alice',
        webId,
      }),
    });

    expect(createResponse.status).toBe(201);
    await expect(createResponse.json()).resolves.toMatchObject({ success: true, webId, podUrl: storageUrl });

    const storageResponse = await runtime.fetch('/alice/', { headers: { accept: 'text/turtle' } });
    expect(storageResponse.status).toBe(200);
    await expect(storageResponse.text()).resolves.toContain('http://www.w3.org/ns/pim/space#Storage');
  });
});
