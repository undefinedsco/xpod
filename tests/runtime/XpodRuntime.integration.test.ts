import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startXpodRuntime, type XpodRuntimeHandle } from '../../src/runtime/XpodRuntime';
import { createGatewayAdminProxyHeaders } from '../../src/runtime/GatewayAdminProxyAuth';
import { resolveTestRuntimeTransport } from '../helpers/runtimeTransport';
import { setupAccount, type AccountSetup } from '../integration/helpers/solidAccount';
import { createTestDir } from '../utils/sqlite';
import { createSolidLocalRouteFetch } from '../../packages/solid-sdk/src/local-route-fetch';

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
    runtime = await startXpodRuntime({
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
  }, 60_000);

  afterAll(async () => {
    await runtime?.stop();
    await close(cloudServer);
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
        webId: 'https://id.undefineds.co/autoalice/profile/card#me',
      }),
    });
    expect(createResponse.status).toBe(201);
  });

  it('reads a Cloud-canonical Pod through the local Gateway route', async () => {
    const canonicalPod = new URL('https://auto-node.undefineds.test/autoalice/');
    const localPod = new URL('/autoalice/', runtime.baseUrl);
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
    const canonicalResource = new URL('profile/card', canonicalPod);
    const getResponse = await routedFetch(canonicalResource, {
      headers: { accept: 'text/turtle' },
    });
    expect(getResponse.status).toBe(200);
    await expect(getResponse.text()).resolves.toContain('https://id.undefineds.co/autoalice/profile/card#me');
    expect(networkTargets).toEqual([ new URL('profile/card', localPod).href ]);
    expect(new URL(networkTargets[0]!).origin).toBe(new URL(runtime.baseUrl).origin);
  });
});

describe('XpodRuntime', () => {
  let runtime: XpodRuntimeHandle;
  let account: AccountSetup | null;

  beforeAll(async () => {
    runtime = await startXpodRuntime({
      mode: 'local',
      open: true,
      transport: resolveTestRuntimeTransport('port'),
      runtimeRoot: createTestDir('xpod-runtime'),
      logLevel: 'warn',
      env: isolatedLocalEnv,
    });

    account = await setupAccount(runtime.baseUrl.replace(/\/$/, ''), 'xpod-open');
  }, 60_000);

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

    runtime = await startXpodRuntime({
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
  }, 60_000);

  afterAll(async () => {
    await runtime?.stop();
    if (previousAdminToken === undefined) {
      delete process.env.XPOD_ADMIN_TOKEN;
    } else {
      process.env.XPOD_ADMIN_TOKEN = previousAdminToken;
    }
  });

  it('does not grant admin capabilities or mutations to an external original client through the real gateway runner', async () => {
    const status = await readAdminStatus('203.0.113.25');
    expect(status.capabilities.services.lifecycle.restart.supported).toBe(false);
    expect(status.capabilities.services.configuration.write.supported).toBe(false);

    const mutation = await writeAdminConfig('203.0.113.25');
    expect(mutation.status).toBe(403);
  });

  it('passes the runtime-scoped gateway auth secret to the CSS runner', async () => {
    expect(cssRunnerStarts).toHaveLength(1);
    expect(cssRunnerStarts[0].shorthand.gatewayAdminProxyAuthSecret).toEqual(expect.any(String));
    expect(cssRunnerStarts[0].shorthand.gatewayAdminProxyAuthSecret).not.toBe('admin-proxy-test-secret');
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

  async function readAdminStatus(remoteAddress: string, headers: Record<string, string> = {}): Promise<any> {
    const response = await runtime.fetch('/api/admin/status', {
      headers: {
        ...headers,
        'x-test-remote-address': remoteAddress,
      },
    });
    expect(response.status).toBe(200);
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
    runtime = await startXpodRuntime({
      mode: 'local',
      transport: resolveTestRuntimeTransport('port'),
      runtimeRoot: createTestDir('xpod-runtime-standalone-profile'),
      logLevel: 'warn',
      env: {
        ...isolatedLocalEnv,
        SOLID_OIDC_ISSUER: 'http://localhost:5600/',
      },
    });
  }, 60_000);

  afterAll(async () => {
    await runtime?.stop();
  });

  it('serves an account-created public profile card without authorization headers', async () => {
    const createdAccount = await setupAccount(runtime.baseUrl.replace(/\/$/, ''), 'profile-standalone');

    expect(createdAccount).toBeTruthy();

    const profileResponse = await runtime.fetch(createdAccount!.webId.split('#')[0], {
      headers: {
        accept: 'text/turtle',
      },
    });

    expect(profileResponse.status).toBe(200);
    const body = await profileResponse.text();
    expect(body).toContain(createdAccount!.webId);
    expect(body).toContain('http://www.w3.org/ns/solid/terms#oidcIssuer');

    const profileContainerResponse = await runtime.fetch(`${createdAccount!.podUrl}profile/`, {
      headers: {
        accept: 'text/turtle',
      },
    });

    expect(profileContainerResponse.status).toBe(200);
  });
});

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

    runtime = await startXpodRuntime({
      mode: 'local',
      transport: resolveTestRuntimeTransport('port'),
      runtimeRoot: createTestDir('xpod-runtime-local-sp-oidc'),
      logLevel: 'warn',
      env: {
        ...isolatedLocalEnv,
        SOLID_OIDC_ISSUER: `${cloudOrigin}/`,
      },
    });
  }, 60_000);

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
  let runtime: XpodRuntimeHandle;

  beforeAll(async () => {
    runtime = await startXpodRuntime({
      mode: 'local',
      transport: resolveTestRuntimeTransport('port'),
      runtimeRoot: createTestDir('xpod-runtime-sp-provisioning'),
      logLevel: 'warn',
      env: {
        ...isolatedLocalEnv,
        XPOD_SERVICE_TOKEN: 'test-service-token',
        SOLID_OIDC_ISSUER: 'https://id.undefineds.co/',
      },
    });
  }, 60_000);

  afterAll(async () => {
    await runtime?.stop();
  });

  it('serves a provisioned public profile card without authorization headers', async () => {
    const createResponse = await runtime.fetch('/provision/pods', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-service-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        podName: 'alice',
        webId: 'https://id.undefineds.co/alice/profile/card#me',
      }),
    });

    expect(createResponse.status).toBe(201);

    const profileResponse = await runtime.fetch('/alice/profile/card', {
      headers: {
        accept: 'text/turtle',
      },
    });

    expect(profileResponse.status).toBe(200);
    const body = await profileResponse.text();
    const storageUrl = new URL('/alice/', runtime.baseUrl).toString();
    expect(body).toContain('https://id.undefineds.co/alice/profile/card#me');
    expect(body).toContain('http://www.w3.org/ns/solid/terms#oidcIssuer');
    expect(body).toContain(runtime.baseUrl);
    expect(body).toContain('http://www.w3.org/ns/solid/terms#storage');
    expect(body).toContain(storageUrl);

    const profileContainerResponse = await runtime.fetch('/alice/profile/', {
      headers: {
        accept: 'text/turtle',
      },
    });

    expect(profileContainerResponse.status).toBe(200);
  });
});
