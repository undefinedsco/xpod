import { describe, expect, it, vi } from 'vitest';
import {
  createAccountControlsClientCredentialManager,
  encodeClientCredentialsApiKey,
} from './client-credentials';

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const CLIENT_CREDENTIALS_URL = 'https://pod.example/.account/client-credentials/';

describe('account controls Client Credentials manager', () => {
  it('is unavailable when account controls do not expose a Client Credentials endpoint', () => {
    expect(createAccountControlsClientCredentialManager(undefined)).toBeUndefined();
  });

  it('lists, creates, encodes, and revokes Solid Client Credentials through account controls', async () => {
    const calls: Array<{
      url: string;
      method: string;
      accept: string | null;
      contentType: string | null;
      body?: string;
      credentials?: RequestCredentials;
    }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        accept: headers.get('accept'),
        contentType: headers.get('content-type'),
        body: typeof init?.body === 'string' ? init.body : undefined,
        credentials: init?.credentials,
      });
      if ((init?.method ?? 'GET') === 'GET') {
        return json({
          clientCredentials: {
            'https://pod.example/.account/client-credentials/existing-id/': WEB_ID,
          },
        });
      }
      if (init?.method === 'POST') {
        return json({
          id: 'created-id',
          secret: 'created-secret',
          resourceUrl: 'https://pod.example/.account/client-credentials/created-id/',
          webId: WEB_ID,
        }, { status: 201 });
      }
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    }) as typeof fetch;

    const manager = createAccountControlsClientCredentialManager(CLIENT_CREDENTIALS_URL, fetchImpl);

    await expect(manager?.list()).resolves.toEqual([{
      id: 'existing-id',
      resourceUrl: 'https://pod.example/.account/client-credentials/existing-id/',
      webId: WEB_ID,
    }]);
    const created = await manager?.create({ name: 'AI Connection · Codex', webId: WEB_ID });
    expect(created).toEqual({
      id: 'created-id',
      resourceUrl: 'https://pod.example/.account/client-credentials/created-id/',
      webId: WEB_ID,
      clientId: 'created-id',
      clientSecret: 'created-secret',
      apiKey: encodeClientCredentialsApiKey('created-id', 'created-secret'),
    });
    await manager?.revoke('https://pod.example/.account/client-credentials/created-id/');

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['GET', CLIENT_CREDENTIALS_URL],
      ['POST', CLIENT_CREDENTIALS_URL],
      ['DELETE', 'https://pod.example/.account/client-credentials/created-id/'],
    ]);
    expect(calls.every((call) => call.credentials === 'include')).toBe(true);
    expect(calls[1]?.contentType).toBe('application/json');
    expect(calls[1]?.body).toBe(JSON.stringify({
      name: 'AI Connection · Codex',
      webId: WEB_ID,
    }));
  });
});

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}
