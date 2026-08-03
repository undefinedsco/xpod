import { describe, expect, it, vi } from 'vitest';
import { createXpodAiConnectionClient } from './ai-connection';

const test = it;
const mock = vi.fn;

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const POD_URL = 'https://pod.example/alice/';

function serviceAccessPayload(overrides: Partial<{
  token: string;
  expiresAt: string;
}> = {}) {
  return {
    appletId: 'co.undefineds.ai-connection',
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
  test('exchanges Solid service access for an owner-bound invocation Bearer before management requests', async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const authenticatedFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get('authorization');
      calls.push({ url, authorization });
      if (url.endsWith('/api/applets/service-access/ai-connection')) {
        return new Response(JSON.stringify(serviceAccessPayload()), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ data: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const client = createXpodAiConnectionClient({
      webId: WEB_ID,
      podUrl: POD_URL,
      authenticatedFetch,
    });

    await client.listProviders();

    expect(calls).toEqual([
      {
        url: 'https://pod.example/api/applets/service-access/ai-connection',
        authorization: null,
      },
      {
        url: 'https://pod.example/api/ai/connections/providers',
        authorization: 'Bearer xpod_inv_v1.owner-bound-short-token',
      },
    ]);
  });

  test('sanitizes non-JSON server failures before the shared client sees them', async () => {
    const authenticatedFetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/applets/service-access/ai-connection')) {
        return new Response(JSON.stringify(serviceAccessPayload()), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('<html>secret stack trace sk-live</html>', {
        status: 500,
        headers: { 'content-type': 'text/html' },
      });
    }) as typeof fetch;

    const client = createXpodAiConnectionClient({
      webId: WEB_ID,
      podUrl: POD_URL,
      authenticatedFetch,
    });

    await expect(client.listProviders()).rejects.toThrow('AI Connection request failed. Please try again.');
  });

  test('normalizes structured GatewayError JSON to the shared client safe-code shape', async () => {
    const authenticatedFetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/applets/service-access/ai-connection')) {
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

    const client = createXpodAiConnectionClient({
      webId: WEB_ID,
      podUrl: POD_URL,
      authenticatedFetch,
    });

    await expect(client.quota('openai')).rejects.toThrow('OpenAI connection is not configured.');
  });

  test('covers provider, connect, quota, and model paths through the same invocation token', async () => {
    const managementCalls: Array<{ url: string; method: string; authorization: string | null; body?: string }> = [];
    const authenticatedFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/applets/service-access/ai-connection')) {
        return new Response(JSON.stringify(serviceAccessPayload()), {
          headers: { 'content-type': 'application/json' },
        });
      }
      managementCalls.push({
        url,
        method,
        authorization: new Headers(init?.headers).get('authorization'),
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      const json = (value: unknown) => new Response(JSON.stringify(value), {
        headers: { 'content-type': 'application/json' },
      });
      if (url.endsWith('/api/ai/connections/providers')) {
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
    const client = createXpodAiConnectionClient({
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
      ['GET', '/api/ai/connections/providers'],
      ['GET', '/v1/models'],
      ['POST', '/api/ai/gateway/providers/openai/connect/begin'],
      ['GET', '/api/ai/gateway/providers/openai/connect/status/attempt_1'],
      ['POST', '/api/ai/gateway/providers/openai/connect/poll'],
      ['POST', '/api/ai/gateway/providers/openai/connect/complete-api-key'],
      ['DELETE', '/api/ai/gateway/providers/openai/connect'],
      ['GET', '/api/ai/gateway/providers/openai/quota/status'],
      ['POST', '/api/ai/gateway/providers/openai/quota/refresh'],
    ]);
    expect(managementCalls.every((call) => call.authorization === 'Bearer xpod_inv_v1.owner-bound-short-token')).toBe(true);
    expect(JSON.stringify(managementCalls)).not.toContain('browser-solid-token');
  });

  test('refreshes cached invocation before near-expiry without retrying the management request', async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const authenticatedFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, authorization: new Headers(init?.headers).get('authorization') });
      if (url.endsWith('/api/applets/service-access/ai-connection')) {
        const issue = calls.filter((call) => call.url.endsWith('/api/applets/service-access/ai-connection')).length;
        return new Response(JSON.stringify(serviceAccessPayload({
          token: `xpod_inv_v1.token-${issue}`,
          expiresAt: issue === 1 ? '2026-07-30T00:00:20.000Z' : '2026-07-30T00:10:00.000Z',
        })), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ data: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const client = createXpodAiConnectionClient({
      webId: WEB_ID,
      podUrl: POD_URL,
      authenticatedFetch,
      now: () => new Date('2026-07-30T00:00:00.000Z'),
    });

    await client.listProviders();
    await client.listModels();

    expect(calls.map((call) => [new URL(call.url).pathname, call.authorization])).toEqual([
      ['/api/applets/service-access/ai-connection', null],
      ['/api/ai/connections/providers', 'Bearer xpod_inv_v1.token-1'],
      ['/api/applets/service-access/ai-connection', null],
      ['/v1/models', 'Bearer xpod_inv_v1.token-2'],
    ]);
  });

  test('clears invocation cache on management 401 and retries once with a fresh token', async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const authenticatedFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get('authorization');
      calls.push({ url, authorization });
      if (url.endsWith('/api/applets/service-access/ai-connection')) {
        const issue = calls.filter((call) => call.url.endsWith('/api/applets/service-access/ai-connection')).length;
        return new Response(JSON.stringify(serviceAccessPayload({
          token: `xpod_inv_v1.retry-${issue}`,
        })), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (authorization === 'Bearer xpod_inv_v1.retry-1') {
        return new Response(JSON.stringify({ error: 'Invalid gateway API key' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ data: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const client = createXpodAiConnectionClient({
      webId: WEB_ID,
      podUrl: POD_URL,
      authenticatedFetch,
    });

    await client.listProviders();

    expect(calls.map((call) => [new URL(call.url).pathname, call.authorization])).toEqual([
      ['/api/applets/service-access/ai-connection', null],
      ['/api/ai/connections/providers', 'Bearer xpod_inv_v1.retry-1'],
      ['/api/applets/service-access/ai-connection', null],
      ['/api/ai/connections/providers', 'Bearer xpod_inv_v1.retry-2'],
    ]);
  });

  test('does not retry non-401 management failures', async () => {
    const calls: string[] = [];
    const authenticatedFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${new Headers(init?.headers).get('authorization') ?? 'none'} ${new URL(url).pathname}`);
      if (url.endsWith('/api/applets/service-access/ai-connection')) {
        return new Response(JSON.stringify(serviceAccessPayload()), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const client = createXpodAiConnectionClient({
      webId: WEB_ID,
      podUrl: POD_URL,
      authenticatedFetch,
    });

    await expect(client.listProviders()).rejects.toThrow();

    expect(calls).toEqual([
      'none /api/applets/service-access/ai-connection',
      'Bearer xpod_inv_v1.owner-bound-short-token /api/ai/connections/providers',
    ]);
  });

  test('single-flights concurrent cold management calls and clears pending invocation failures', async () => {
    const calls: string[] = [];
    let failServiceAccess = true;
    const authenticatedFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${new Headers(init?.headers).get('authorization') ?? 'none'} ${new URL(url).pathname}`);
      if (url.endsWith('/api/applets/service-access/ai-connection')) {
        if (failServiceAccess) {
          return new Response(JSON.stringify({ error: 'temporary' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(serviceAccessPayload()), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ data: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const client = createXpodAiConnectionClient({
      webId: WEB_ID,
      podUrl: POD_URL,
      authenticatedFetch,
    });

    await expect(Promise.all([
      client.listProviders(),
      client.listModels(),
    ])).rejects.toThrow('AI Connection request failed. Please try again.');
    failServiceAccess = false;
    await Promise.all([
      client.listProviders(),
      client.listModels(),
    ]);

    expect(calls.filter((call) => call.endsWith('/api/applets/service-access/ai-connection'))).toHaveLength(2);
    expect(calls.filter((call) => call.includes('Bearer xpod_inv_v1.owner-bound-short-token'))).toHaveLength(2);
  });
});
