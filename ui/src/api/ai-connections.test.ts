import { describe, expect, it, vi } from 'vitest';
import { createServiceAccessGatewayFetch, createXpodAiClientConfigurationBridge, createXpodAiConnectionsClient } from './ai-connections';

const test = it;
const mock = vi.fn;

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const POD_URL = 'https://pod.example/alice/';

function serviceAccessPayload(overrides: Partial<{
  token: string;
  expiresAt: string;
}> = {}) {
  return {
    appletId: 'co.undefineds.ai-connections',
    service: {
      webId: 'https://pod.example/service/profile/card#me',
      label: 'Xpod AI Connection',
    },
    resources: [
      {
        id: 'providerCredentials',
        url: 'https://pod.example/alice/settings/credentials.ttl',
        mediaType: 'text/turtle',
        access: { read: true, append: true, write: true },
      },
    ],
    invocation: {
      baseUrl: 'https://pod.example',
      token: overrides.token ?? 'xpod_inv_v1.owner-bound-short-token',
      expiresAt: overrides.expiresAt ?? '2099-01-01T00:10:00.000Z',
    },
  };
}

describe('Xpod AI Connection API client', () => {
  test('forwards the supplied Gateway model catalog while rewriting only the local endpoint', async () => {
    const authenticatedFetch = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ aiClientConfiguration: { invocation: serviceAccessPayload().invocation } }));
    const invocationFetch = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ planId: 'plan', client: 'codex', changes: [] }));
    const bridge = createXpodAiClientConfigurationBridge({ podUrl: POD_URL, controlPlaneOrigin: 'http://localhost:3000', authenticatedFetch, invocationFetch });
    const activeModels = [{ id: 'kimi-k2.5', displayName: 'Kimi K2.5' }, { id: 'deepseek-v4-pro' }];
    await bridge.plan({ client: 'codex', endpoint: 'https://pod.example/v1', activeModels });
    expect(JSON.parse(String(invocationFetch.mock.calls[0]?.[1]?.body))).toEqual({ endpoint: 'http://localhost:3000', activeModels });
    expect(invocationFetch).toHaveBeenCalledTimes(1);
  });

  test.each(['inspect', 'plan', 'apply', 'restore'] as const)('routes local client configuration %s to the control plane while preserving canonical authorization', async (operation) => {
    const authenticatedFetch = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ aiClientConfiguration: { invocation: serviceAccessPayload().invocation } }));
    const invocationFetch = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ status: 'configured', applied: true, planId: 'plan', client: 'codex', changes: [] }));
    const bridge = createXpodAiClientConfigurationBridge({
      podUrl: POD_URL, controlPlaneOrigin: 'http://localhost:3000', authenticatedFetch, invocationFetch,
    });
    if (operation === 'inspect' || operation === 'restore') await bridge[operation]('codex');
    else if (operation === 'plan') await bridge.plan({ client: 'codex', endpoint: 'https://pod.example/v1' });
    else await bridge.apply({ client: 'codex', planId: 'plan', apiKey: 'client-key' });

    expect(authenticatedFetch).toHaveBeenCalledWith('https://pod.example/api/applets/service-access/ai-connections', expect.any(Object));
    expect(String(invocationFetch.mock.calls[0]?.[0])).toBe(`http://localhost:3000/api/ai/client-configuration/codex${operation === 'inspect' ? '' : `/${operation}`}`);
  });

  test.each([
    'http://127.0.0.1:49152',
    'http://localhost:43210',
    'http://[::1]:54321',
  ])('uses the running local Gateway origin %s in a configuration plan', async (controlPlaneOrigin) => {
    const authenticatedFetch = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ aiClientConfiguration: { invocation: serviceAccessPayload().invocation } }));
    const invocationFetch = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ planId: 'plan', client: 'codex', changes: [] }));
    const bridge = createXpodAiClientConfigurationBridge({ podUrl: POD_URL, controlPlaneOrigin, authenticatedFetch, invocationFetch });

    await bridge.plan({ client: 'codex', endpoint: 'https://pod.example/v1' });

    expect(String(invocationFetch.mock.calls[0]?.[0])).toBe(`${controlPlaneOrigin}/api/ai/client-configuration/codex/plan`);
    expect(JSON.parse(String(invocationFetch.mock.calls[0]?.[1]?.body))).toEqual({ endpoint: controlPlaneOrigin });
  });

  test('preserves the caller gateway endpoint in a configuration plan without a local control plane', async () => {
    const authenticatedFetch = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ aiClientConfiguration: { invocation: serviceAccessPayload().invocation } }));
    const invocationFetch = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ planId: 'plan', client: 'codex', changes: [] }));
    const bridge = createXpodAiClientConfigurationBridge({ podUrl: POD_URL, authenticatedFetch, invocationFetch });

    await bridge.plan({ client: 'codex', endpoint: 'https://pod.example/v1' });

    expect(JSON.parse(String(invocationFetch.mock.calls[0]?.[1]?.body))).toEqual({ endpoint: 'https://pod.example/v1' });
  });

  test('defaults client configuration and service access to the Pod origin without an override', async () => {
    const authenticatedFetch = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ aiClientConfiguration: { invocation: serviceAccessPayload().invocation } }));
    const invocationFetch = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ status: 'notConfigured' }));
    const bridge = createXpodAiClientConfigurationBridge({ podUrl: POD_URL, authenticatedFetch, invocationFetch });

    await bridge.inspect('codex');

    expect(authenticatedFetch).toHaveBeenCalledWith('https://pod.example/api/applets/service-access/ai-connections', expect.any(Object));
    expect(invocationFetch).toHaveBeenCalledWith('https://pod.example/api/ai/client-configuration/codex', expect.any(Object));
  });

  test('refreshes a rejected local invocation once and uses the fresh token for the retry', async () => {
    let grants = 0;
    const authenticatedFetch = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ aiClientConfiguration: { invocation: serviceAccessPayload({ token: `token-${++grants}` }).invocation } }));
    const invocationFetch = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ status: 'configured' }))
      .mockResolvedValueOnce(Response.json({ error: 'authorization_expired' }, { status: 401 }));
    const bridge = createXpodAiClientConfigurationBridge({ podUrl: POD_URL, controlPlaneOrigin: 'http://localhost:3000', authenticatedFetch, invocationFetch });

    await bridge.inspect('codex');

    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    expect(invocationFetch).toHaveBeenCalledTimes(2);
    expect(invocationFetch.mock.calls.map(([url, init]) => [String(url), new Headers(init?.headers).get('authorization')])).toEqual([
      ['http://localhost:3000/api/ai/client-configuration/codex', 'Bearer token-1'],
      ['http://localhost:3000/api/ai/client-configuration/codex', 'Bearer token-2'],
    ]);
  });

  test('reuses the caller Solid session for interactive Provider management', async () => {
    const calls: string[] = [];
    const invocationFetch = mock(async () => {
      throw new Error('interactive management must not use an invocation token');
    }) as typeof fetch;
    const authenticatedFetch = mock(async (input: RequestInfo | URL) => {
      calls.push(new URL(String(input)).pathname);
      return new Response(JSON.stringify({ data: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const client = createXpodAiConnectionsClient({
      webId: WEB_ID,
      podUrl: POD_URL,
      authenticatedFetch,
    });

    await client.listProviders();

    expect(calls).toEqual(['/api/ai/providers']);
    expect(invocationFetch).not.toHaveBeenCalled();
  });
  test('never attaches an invocation Bearer to cross-origin or non-AI requests', async () => {
    const solidCalls: Array<{ url: string; authorization: string | null }> = [];
    const invocationFetch = mock(async () => new Response('{}')) as typeof fetch;
    const authenticatedFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      solidCalls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return new Response('{}');
    }) as typeof fetch;
    const gatewayFetch = createServiceAccessGatewayFetch({
      podUrl: POD_URL,
      authenticatedFetch,
      invocationFetch,
    });

    await gatewayFetch('https://evil.example/api/ai/providers');
    await gatewayFetch('https://pod.example/alice/private.ttl');
    await gatewayFetch('https://evil.example/api/applets/service-access/ai-connections');

    expect(invocationFetch).not.toHaveBeenCalled();
    expect(solidCalls).toEqual([
      { url: 'https://evil.example/api/ai/providers', authorization: null },
      { url: 'https://pod.example/alice/private.ttl', authorization: null },
      { url: 'https://evil.example/api/applets/service-access/ai-connections', authorization: null },
    ]);
  });

  test('keeps the service-access invocation cached across ordinary Solid requests', async () => {
    let serviceAccessCalls = 0;
    const invocationFetch = mock(async () => new Response(JSON.stringify({ data: [] }), {
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const authenticatedFetch = mock(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/applets/service-access/ai-connections')) {
        serviceAccessCalls += 1;
        return new Response(JSON.stringify(serviceAccessPayload()), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ invocation: { token: 'untrusted' } }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const gatewayFetch = createServiceAccessGatewayFetch({ podUrl: POD_URL, authenticatedFetch, invocationFetch });

    await gatewayFetch('https://pod.example/api/ai/providers');
    await gatewayFetch('https://pod.example/alice/private.json');
    await gatewayFetch('https://pod.example/api/ai/providers');

    expect(serviceAccessCalls).toBe(1);
    expect(invocationFetch).toHaveBeenCalledTimes(2);
    expect(new Headers(invocationFetch.mock.calls[1]?.[1]?.headers).get('authorization'))
      .toBe('Bearer xpod_inv_v1.owner-bound-short-token');
  });

  test('uses Solid DPoP only to mint service access and preserves the invocation Bearer on management calls', async () => {
    const solidCalls: string[] = [];
    const invocationCalls: Array<{ url: string; authorization: string | null }> = [];
    const authenticatedFetch = mock(async (input: RequestInfo | URL) => {
      solidCalls.push(String(input));
      return new Response(JSON.stringify(serviceAccessPayload()), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const invocationFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      invocationCalls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return new Response(JSON.stringify({ data: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const gatewayFetch = createServiceAccessGatewayFetch({
      podUrl: POD_URL,
      authenticatedFetch,
      invocationFetch,
    });

    await gatewayFetch('https://pod.example/api/ai/connections/providers');

    expect(solidCalls).toEqual(['https://pod.example/api/applets/service-access/ai-connections']);
    expect(invocationCalls).toEqual([{
      url: 'https://pod.example/api/ai/connections/providers',
      authorization: 'Bearer xpod_inv_v1.owner-bound-short-token',
    }]);
  });

  test('accepts the API key invocation shape used by a restored Xpod account session', async () => {
    const invocationFetch = mock(async () => new Response(JSON.stringify({ data: [] }), {
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const authenticatedFetch = mock(async () => new Response(JSON.stringify({
      ...serviceAccessPayload(),
      invocation: {
        baseUrl: 'https://pod.example',
        apiKey: 'restored-client-credentials',
      },
    }), {
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const gatewayFetch = createServiceAccessGatewayFetch({
      podUrl: POD_URL,
      authenticatedFetch,
      invocationFetch,
    });

    await gatewayFetch('https://pod.example/api/ai/providers');

    expect(new Headers(invocationFetch.mock.calls[0]?.[1]?.headers).get('authorization'))
      .toBe('Bearer restored-client-credentials');
  });

  test('sanitizes non-JSON server failures before the shared client sees them', async () => {
    const authenticatedFetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/applets/service-access/ai-connections')) {
        return new Response(JSON.stringify(serviceAccessPayload()), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('<html>secret stack trace sk-live</html>', {
        status: 500,
        headers: { 'content-type': 'text/html' },
      });
    }) as typeof fetch;

    const client = createXpodAiConnectionsClient({
      webId: WEB_ID,
      podUrl: POD_URL,
      authenticatedFetch,
    });

    await expect(client.listProviders()).rejects.toThrow('AI Connection request failed. Please try again.');
  });

  test('normalizes structured GatewayError JSON to the shared client safe-code shape', async () => {
    const authenticatedFetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/applets/service-access/ai-connections')) {
        return new Response(JSON.stringify(serviceAccessPayload()), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        error: {
          code: 'not_configured',
          message: 'raw provider detail sk-live',
          status: 404,
        },
      }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const client = createXpodAiConnectionsClient({
      webId: WEB_ID,
      podUrl: POD_URL,
      authenticatedFetch,
    });

    await expect(client.quota('openai')).rejects.toThrow('OpenAI connection is not configured.');
  });

  test('maps legacy missing Gateway API Key plaintext errors to a safe user-facing message', async () => {
    const authenticatedFetch = mock(async () => new Response(JSON.stringify({
      error: 'Gateway API Key plaintext is not available',
    }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    const client = createXpodAiConnectionsClient({
      webId: WEB_ID,
      podUrl: POD_URL,
      authenticatedFetch,
    });

    await expect(client.revealGatewayKey('ai/gateway/access-keys.ttl#lost'))
      .rejects.toThrow('Pod 中未找到此 API Key 的原文，无法复制配置。请创建新的 Key，更新客户端后再删除旧 Key。');
  });

  test('uses the caller Solid session for Provider operations and interactive model reads', async () => {
    const managementCalls: Array<{ url: string; method: string; authorization: string | null; body?: string }> = [];
    const authenticatedFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      managementCalls.push({
        url,
        method,
        authorization: new Headers(init?.headers).get('authorization'),
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      const json = (value: unknown) => new Response(JSON.stringify(value), {
        headers: { 'content-type': 'application/json' },
      });
      if (url.endsWith('/api/ai/providers')) {
        return json({ data: [{ provider: 'openai', status: 'disconnected', connect: { modes: ['browserAssistedApiKey'], configured: true } }] });
      }
      if (url.endsWith('/v1/models')) {
        return json({ data: [{ id: 'openai/gpt-5', provider: 'openai', object: 'model' }] });
      }
      if (url.endsWith('/api/ai/gateway/providers/openai/connect/begin')) {
        return json({ provider: 'openai', mode: 'browserAssistedApiKey', status: 'pending', attemptId: 'attempt_1', state: 's', signature: 'sig' });
      }
      if (url.includes('/api/ai/gateway/providers/openai/connect/status/attempt_1')) {
        return json({ provider: 'openai', mode: 'browserAssistedApiKey', status: 'pending', attemptId: 'attempt_1' });
      }
      if (url.endsWith('/api/ai/gateway/providers/openai/connect/poll')) {
        return json({ provider: 'openai', mode: 'deviceCodeOAuth', status: 'authorization_pending', attemptId: 'attempt_1' });
      }
      if (url.endsWith('/api/ai/gateway/providers/openai/connect/complete-api-key')) {
        return json({ provider: 'openai', mode: 'browserAssistedApiKey', status: 'completed', credentialId: 'cred_1' });
      }
      if (url.endsWith('/api/ai/gateway/providers/openai/connect') && method === 'DELETE') {
        return json({ record: { id: 'cred_1', credentialIri: 'https://pod.example/alice/settings/credentials.ttl#cloud-openai', webId: WEB_ID, provider: 'openai', authMode: 'apiKey', status: 'revoked' } });
      }
      if (url.endsWith('/api/ai/gateway/providers/openai/quota/status')) {
        return json({ credential: 'cred_1', status: 'unsupported', windows: [], observedAt: '2026-07-30T00:00:00.000Z', expiresAt: '2026-07-30T00:05:00.000Z', source: 'openai:no-credential-quota-api' });
      }
      if (url.endsWith('/api/ai/gateway/providers/openai/quota/refresh')) {
        return json({ credential: 'cred_1', status: 'unsupported', windows: [], observedAt: '2026-07-30T00:00:00.000Z', expiresAt: '2026-07-30T00:05:00.000Z', source: 'openai:no-credential-quota-api' });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }) as typeof fetch;
    const client = createXpodAiConnectionsClient({
      webId: WEB_ID,
      podUrl: POD_URL,
      authenticatedFetch,
    });

    await client.listProviders();
    await client.listModels();
    const attempt = await client.beginConnect('openai', 'browserAssistedApiKey');
    await client.connectStatus('openai', attempt);
    await client.pollDevice('openai', attempt);
    await client.completeApiKey('openai', attempt, 'sk-test-secret', 'Alice');
    await client.disconnect('openai');
    await client.quota('openai');
    await client.quota('openai', true);

    expect(managementCalls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
      ['GET', '/api/ai/providers'],
      ['GET', '/v1/models'],
      ['POST', '/api/ai/gateway/providers/openai/connect/begin'],
      ['GET', '/api/ai/gateway/providers/openai/connect/status/attempt_1'],
      ['POST', '/api/ai/gateway/providers/openai/connect/poll'],
      ['POST', '/api/ai/gateway/providers/openai/connect/complete-api-key'],
      ['DELETE', '/api/ai/gateway/providers/openai/connect'],
      ['GET', '/api/ai/gateway/providers/openai/quota/status'],
      ['POST', '/api/ai/gateway/providers/openai/quota/refresh'],
    ]);
    expect(managementCalls.every((call) => call.authorization === null)).toBe(true);
  });

  test('does not hide a Solid-session 401 behind an invocation retry', async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const authenticatedFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get('authorization');
      calls.push({ url, authorization });
      return new Response(JSON.stringify({ error: 'authorization_expired' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const client = createXpodAiConnectionsClient({
      webId: WEB_ID,
      podUrl: POD_URL,
      authenticatedFetch,
    });

    await expect(client.listProviders()).rejects.toThrow();

    expect(calls.map((call) => [new URL(call.url).pathname, call.authorization])).toEqual([
      ['/api/ai/providers', null],
    ]);
  });

  test('does not retry non-401 management failures', async () => {
    const calls: string[] = [];
    const authenticatedFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${new Headers(init?.headers).get('authorization') ?? 'none'} ${new URL(url).pathname}`);
      if (url.endsWith('/api/applets/service-access/ai-connections')) {
        return new Response(JSON.stringify(serviceAccessPayload()), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const client = createXpodAiConnectionsClient({
      webId: WEB_ID,
      podUrl: POD_URL,
      authenticatedFetch,
    });

    await expect(client.listProviders()).rejects.toThrow();

    expect(calls).toEqual([
      'none /api/ai/providers',
    ]);
  });

});
