import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startXpodRuntime, type XpodRuntimeHandle } from '../../src/runtime/XpodRuntime';
import { resolveTestRuntimeTransport } from '../helpers/runtimeTransport';
import { setupAccount, type AccountSetup } from '../integration/helpers/solidAccount';
import { createTestDir } from '../utils/sqlite';

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

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

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

describe('XpodRuntime standalone profile authorization', () => {
  let runtime: XpodRuntimeHandle;

  beforeAll(async () => {
    runtime = await startXpodRuntime({
      mode: 'local',
      transport: resolveTestRuntimeTransport('port'),
      runtimeRoot: createTestDir('xpod-runtime-standalone-profile'),
      logLevel: 'warn',
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
        oidcIssuer: `${cloudOrigin}/`,
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
    expect(cloudRequests).toEqual([]);
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
        XPOD_SERVICE_TOKEN: 'test-service-token',
        oidcIssuer: 'https://id.undefineds.co/',
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
