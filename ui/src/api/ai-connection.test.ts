import { describe, expect, it, vi } from 'vitest';
import { createXpodAiConnectionClient } from './ai-connection';

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const POD_URL = 'https://pod.example/alice/';

describe('Xpod AI Connection API client', () => {
  it('uses the browser Solid authenticated fetch directly for management and model requests', async () => {
    const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
    const authenticatedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({
        url,
        method,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      const data = url.endsWith('/v1/models')
        ? { data: [] }
        : { data: [] };
      return new Response(JSON.stringify(data), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const client = createXpodAiConnectionClient({
      webId: WEB_ID,
      podUrl: POD_URL,
      authenticatedFetch,
    });

    await client.listProviders();
    await client.listModels();

    expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
      ['GET', '/api/ai/connections/providers'],
      ['GET', '/v1/models'],
    ]);
    expect(calls.every((call) => call.authorization === null)).toBe(true);
    expect(calls.some((call) => call.url.includes('/api/applets/service-access/'))).toBe(false);
  });

  it('keeps provider connect and quota calls on the same Solid session fetch', async () => {
    const paths: string[] = [];
    const authenticatedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      paths.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      const payload = url.endsWith('/connect/begin')
        ? { provider: 'openai', mode: 'browserAssistedApiKey', status: 'pending', attemptId: 'attempt_1' }
        : { credential: 'cred_1', status: 'unsupported', windows: [], observedAt: '2026-08-04T00:00:00.000Z', expiresAt: '2026-08-04T00:05:00.000Z', source: 'openai:no-credential-quota-api' };
      return new Response(JSON.stringify(payload), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const client = createXpodAiConnectionClient({
      webId: WEB_ID,
      podUrl: POD_URL,
      authenticatedFetch,
    });

    await client.beginConnect('openai', 'browserAssistedApiKey');
    await client.quota('openai');

    expect(paths).toEqual([
      'POST /api/ai/gateway/providers/openai/connect/begin',
      'GET /api/ai/gateway/providers/openai/quota/status',
    ]);
  });

  it('sanitizes non-JSON server failures before exposing them to the applet', async () => {
    const authenticatedFetch = vi.fn(async () => new Response('<html>secret stack trace sk-live</html>', {
      status: 500,
      headers: { 'content-type': 'text/html' },
    })) as typeof fetch;
    const client = createXpodAiConnectionClient({
      webId: WEB_ID,
      podUrl: POD_URL,
      authenticatedFetch,
    });

    await expect(client.listProviders()).rejects.toThrow('AI Connection returned invalid JSON (500)');
  });
});
