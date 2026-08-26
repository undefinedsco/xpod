import { describe, expect, it, vi } from 'vitest';
import {
  aiModelResource,
  aiProviderResource,
  credentialResource,
} from '@undefineds.co/models';
import { createXpodAiConnectionsClient } from './ai-connections';

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const POD_URL = 'https://pod.example/alice/';

function createMemoryDatabase() {
  const rows = new Map<unknown, Array<Record<string, unknown>>>([
    [aiProviderResource, []],
    [credentialResource, []],
    [aiModelResource, []],
  ]);
  return {
    init: vi.fn(async () => undefined),
    select: vi.fn(() => ({
      from: (resource: unknown) => ({
        execute: async () => [...(rows.get(resource) ?? [])],
      }),
    })),
    insert: vi.fn((resource: unknown) => ({
      values: (value: Record<string, unknown>) => ({
        execute: async () => {
          rows.get(resource)?.push({ ...value });
          return [{ ...value }];
        },
      }),
    })),
    updateById: vi.fn(async () => null),
    deleteById: vi.fn(async () => false),
  } as any;
}

describe('Xpod AI Connection API client', () => {
  it('uses the current user session for management requests without service-access bootstrap', async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const authenticatedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return new Response(JSON.stringify({ data: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const client = createXpodAiConnectionsClient({
      webId: WEB_ID,
      podUrl: POD_URL,
      authenticatedFetch,
      database: createMemoryDatabase(),
    });

    await client.listProviders();

    expect(calls).toEqual([]);
  });

  it('keeps provider and model calls on the same user fetch without gateway-key management', async () => {
    const managementCalls: Array<{ path: string; method: string; authorization: string | null }> = [];
    const authenticatedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      managementCalls.push({
        path: url.pathname,
        method,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      const json = (value: unknown) => new Response(JSON.stringify(value), {
        headers: { 'content-type': 'application/json' },
      });
      if (url.pathname === '/api/ai/connections/providers') {
        return json({ data: [{ provider: 'openai', status: 'disconnected', connect: { modes: ['browserAssistedApiKey'], configured: true } }] });
      }
      if (url.pathname === '/v1/models') {
        return json({ data: [{ id: 'linx-lite', owned_by: 'undefineds', object: 'model' }] });
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    }) as typeof fetch;
    const client = createXpodAiConnectionsClient({
      webId: WEB_ID,
      podUrl: POD_URL,
      authenticatedFetch,
      database: createMemoryDatabase(),
    });

    await client.listProviders();
    await client.listModels();

    expect(managementCalls).toEqual([
      { method: 'GET', path: '/v1/models', authorization: null },
    ]);
  });

  it('sanitizes non-JSON server failures before the shared client sees them', async () => {
    const authenticatedFetch = vi.fn(async () => new Response('<html>secret stack trace sk-live</html>', {
      status: 500,
      headers: { 'content-type': 'text/html' },
    })) as typeof fetch;

    const client = createXpodAiConnectionsClient({
      webId: WEB_ID,
      podUrl: POD_URL,
      authenticatedFetch,
      database: createMemoryDatabase(),
    });

    await expect(client.listModels()).rejects.toThrow('AI Connection request failed. Please try again.');
  });
});
