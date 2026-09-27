/**
 * The live acceptance's owner-credential fetch.
 *
 * It exists because the API holds no owner key (decision 7), so the caller has to bring one. What it
 * must NOT do is bypass the transport: a managed local node addresses the API and its Pod through
 * canonical URLs that only the runtime's route transport resolves, and a bare `fetch` sends those to
 * the node's public entry - which is how the 0.4.16 candidate turned a registration into
 * "The socket connection was closed unexpectedly".
 */

import { describe, expect, it, vi } from 'vitest';

import { createOwnerCredentialFetch } from '../../scripts/accept-live-gateway-login-chat';

describe('live gateway acceptance credential fetch', () => {
  it('sends the caller credential through the runtime transport', async () => {
    const transport = vi.fn(async () => new Response('{}', { status: 201 }));
    const fetchWithCredential = createOwnerCredentialFetch(
      { clientId: 'client-id', clientSecret: 'client-secret' },
      transport as unknown as typeof fetch,
    );

    const response = await fetchWithCredential('https://node.example/api/ai/gateway/keys', {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: JSON.stringify({ name: 'probe' }),
    });

    expect(response.status).toBe(201);
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://node.example/api/ai/gateway/keys');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(
      `Bearer sk-${Buffer.from('client-id:client-secret', 'utf8').toString('base64')}`,
    );
    expect(headers.get('accept')).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ name: 'probe' }));
  });

  it('never falls back to the global fetch when a transport is given', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    try {
      const transport = vi.fn(async () => new Response('{}', { status: 200 }));
      const fetchWithCredential = createOwnerCredentialFetch(
        { clientId: 'client-id', clientSecret: 'client-secret' },
        transport as unknown as typeof fetch,
      );

      await fetchWithCredential('https://node.example/api/ai/gateway/keys');

      expect(transport).toHaveBeenCalledTimes(1);
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      globalFetch.mockRestore();
    }
  });
});
