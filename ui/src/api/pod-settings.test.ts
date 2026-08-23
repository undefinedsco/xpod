import { describe, expect, test, vi } from 'vitest';
import { fetchPodSettingsStatus } from './pod-settings';

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const POD_URL = 'https://pod.example/alice/';
const mock = vi.fn;

describe('Pod settings API client', () => {
  test('requests status from the current Pod origin without sending caller-controlled identity parameters', async () => {
    const calls: Array<{ url: string; method: string; body?: BodyInit | null }> = [];
    const authenticatedFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body });
      return new Response(JSON.stringify({
        identity: { webId: WEB_ID },
        storage: { status: 'unsupported', reason: 'usage_not_available' },
        aiConnection: { status: 'unsupported', reason: 'not_configured' },
        generatedAt: '2026-07-31T00:00:00.000Z',
      }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const status = await fetchPodSettingsStatus({
      webId: WEB_ID,
      podUrl: POD_URL,
      authenticatedFetch,
    });

    expect(status.identity.webId).toBe(WEB_ID);
    expect(calls).toEqual([
      {
        url: 'https://pod.example/api/pod/settings/status',
        method: 'GET',
        body: undefined,
      },
    ]);
  });

  test('rejects cross-WebID responses and sanitizes raw server failures', async () => {
    const mismatchedFetch = mock(async () => new Response(JSON.stringify({
      identity: { webId: 'https://pod.example/bob/profile/card#me' },
      storage: { status: 'unsupported' },
      aiConnection: { status: 'unsupported' },
    }), { headers: { 'content-type': 'application/json' } })) as typeof fetch;

    await expect(fetchPodSettingsStatus({
      webId: WEB_ID,
      podUrl: POD_URL,
      authenticatedFetch: mismatchedFetch,
    })).rejects.toThrow('Pod settings response does not match the current Solid session.');

    const leakingFetch = mock(async () => new Response('token=secret stack trace', {
      status: 500,
      headers: { 'content-type': 'text/plain' },
    })) as typeof fetch;

    await expect(fetchPodSettingsStatus({
      webId: WEB_ID,
      podUrl: POD_URL,
      authenticatedFetch: leakingFetch,
    })).rejects.toThrow('Pod settings request failed. Please try again.');
  });
});
