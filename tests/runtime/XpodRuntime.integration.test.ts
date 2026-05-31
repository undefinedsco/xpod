import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startXpodRuntime, type XpodRuntimeHandle } from '../../src/runtime/XpodRuntime';
import { resolveTestRuntimeTransport } from '../helpers/runtimeTransport';
import { setupAccount, type AccountSetup } from '../integration/helpers/solidAccount';
import { createTestDir } from '../utils/sqlite';

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
    expect(body).toContain('https://id.undefineds.co/alice/profile/card#me');
    expect(body).toContain('http://www.w3.org/ns/solid/terms#oidcIssuer');

    const profileContainerResponse = await runtime.fetch('/alice/profile/', {
      headers: {
        accept: 'text/turtle',
      },
    });

    expect(profileContainerResponse.status).toBe(200);
  });
});
