import { describe, expect, it, vi } from 'vitest';

import {
  createSessionRequestCredential,
  needsPodAuthorization,
  withRequestPodAuthorization as withAuthorization,
} from './session-request-credential';
import type { AiClientCredentialsCapability } from '@undefineds.co/extension-sdk/web';

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const withRequestPodAuthorization = (transport: typeof fetch, authorization: (() => Promise<string | undefined>) | undefined, retry: typeof fetch = transport) =>
  withAuthorization(transport, authorization, retry, 'https://xpod.example');

const API_KEY = `sk-${btoa('alice-client-1:secret-value')}`;

function capability(overrides: Partial<AiClientCredentialsCapability> = {}): AiClientCredentialsCapability {
  return {
    create: vi.fn(async() => ({ apiKey: API_KEY, resource: 'https://pod.example/.account/credential/1' })),
    list: vi.fn(async() => []),
    revoke: vi.fn(async() => undefined),
    ...overrides,
  } as AiClientCredentialsCapability;
}

describe('createSessionRequestCredential', () => {
  it('creates the credential once and returns an sk authorization', async() => {
    const credentials = capability();
    const credential = createSessionRequestCredential({ capability: credentials, webId: WEB_ID });

    await expect(credential.authorization()).resolves.toBe(`Bearer ${API_KEY}`);
    await expect(credential.authorization()).resolves.toBe(`Bearer ${API_KEY}`);

    expect(credentials.create).toHaveBeenCalledTimes(1);
    expect(credentials.create).toHaveBeenCalledWith({ name: 'Xpod 会话凭据', webId: WEB_ID });
    expect(credential.clientId()).toBe('alice-client-1');
  });

  it('creates the credential once when several requests start together', async() => {
    let resolveCreate: ((value: { apiKey: string; resource: string }) => void) | undefined;
    const credentials = capability({
      create: vi.fn(() => new Promise<{ apiKey: string; resource: string }>((resolve) => {
        resolveCreate = resolve;
      })),
    });
    const credential = createSessionRequestCredential({ capability: credentials, webId: WEB_ID });

    const first = credential.authorization();
    const second = credential.authorization();
    resolveCreate?.({ apiKey: API_KEY, resource: 'https://pod.example/.account/credential/1' });

    await expect(Promise.all([ first, second ])).resolves.toEqual([ `Bearer ${API_KEY}`, `Bearer ${API_KEY}` ]);
    expect(credentials.create).toHaveBeenCalledTimes(1);
  });

  it('shares lazy capability discovery and issuance across concurrent requests', async () => {
    const credentials = capability();
    let resolve!: (value: AiClientCredentialsCapability) => void;
    const resolveCapability = vi.fn(() => new Promise<AiClientCredentialsCapability>(done => { resolve = done; }));
    const credential = createSessionRequestCredential({ resolveCapability, webId: WEB_ID });
    const first = credential.authorization();
    const second = credential.apiKey();
    expect(resolveCapability).toHaveBeenCalledTimes(1);
    expect(credentials.create).not.toHaveBeenCalled();
    resolve(credentials);
    await expect(Promise.all([first, second])).resolves.toEqual([`Bearer ${API_KEY}`, API_KEY]);
    expect(credentials.create).toHaveBeenCalledTimes(1);
    await credential.release();
    expect(credentials.revoke).toHaveBeenCalledTimes(1);
  });

  it('retries unavailable capability discovery on a later request', async () => {
    const credentials = capability();
    const resolveCapability = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(credentials);
    const credential = createSessionRequestCredential({ resolveCapability, webId: WEB_ID });
    await expect(credential.authorization()).resolves.toBeUndefined();
    await expect(credential.authorization()).resolves.toBe(`Bearer ${API_KEY}`);
    expect(resolveCapability).toHaveBeenCalledTimes(2);
  });

  it('does not issue after the session ends during lazy discovery', async () => {
    const credentials = capability();
    let resolve!: (value: AiClientCredentialsCapability) => void;
    const credential = createSessionRequestCredential({ webId: WEB_ID,
      resolveCapability: () => new Promise(done => { resolve = done; }),
    });
    const pending = credential.authorization();
    await credential.release();
    resolve(credentials);
    await expect(pending).resolves.toBeUndefined();
    expect(credentials.create).not.toHaveBeenCalled();
    expect(credentials.revoke).not.toHaveBeenCalled();
  });

  it('uses the lazily resolved issuer to revoke late issuance after logout', async () => {
    let resolveCreate!: (value: { apiKey: string; resource: string }) => void;
    let started!: () => void;
    const creationStarted = new Promise<void>(resolve => { started = resolve; });
    const credentials = capability({ create: vi.fn(() => new Promise(resolve => { resolveCreate = resolve; started(); })) });
    const credential = createSessionRequestCredential({ webId: WEB_ID, resolveCapability: async () => credentials });
    const pending = credential.authorization();
    await creationStarted;
    await credential.release();
    resolveCreate({ apiKey: API_KEY, resource: 'https://pod.example/.account/credential/1' });
    await expect(pending).resolves.toBeUndefined();
    expect(credentials.revoke).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'alice-client-1', webId: WEB_ID }));
  });

  it('hands out the raw wrapper only while the session is live', async() => {
    const credentials = capability();
    const credential = createSessionRequestCredential({ capability: credentials, webId: WEB_ID });

    await expect(credential.apiKey()).resolves.toBe(API_KEY);
    await credential.release();
    await expect(credential.apiKey()).resolves.toBeUndefined();
  });

  it('revokes the credential on release and stops handing it out', async() => {
    const credentials = capability();
    const credential = createSessionRequestCredential({ capability: credentials, webId: WEB_ID });
    await credential.authorization();

    await credential.release();

    expect(credentials.revoke).toHaveBeenCalledWith({
      clientId: 'alice-client-1',
      resource: 'https://pod.example/.account/credential/1',
      webId: WEB_ID,
    });
    await expect(credential.authorization()).resolves.toBeUndefined();
    expect(credential.clientId()).toBeUndefined();
  });

  it('revokes a credential that was created after the session ended', async() => {
    let resolveCreate: ((value: { apiKey: string; resource: string }) => void) | undefined;
    const credentials = capability({
      create: vi.fn(() => new Promise<{ apiKey: string; resource: string }>((resolve) => {
        resolveCreate = resolve;
      })),
    });
    const credential = createSessionRequestCredential({ capability: credentials, webId: WEB_ID });

    const pending = credential.authorization();
    await credential.release();
    resolveCreate?.({ apiKey: API_KEY, resource: 'https://pod.example/.account/credential/1' });

    await expect(pending).resolves.toBeUndefined();
    expect(credentials.revoke).toHaveBeenCalledTimes(1);
    expect(credentials.revoke).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'alice-client-1' }));
  });

  it('hands out nothing when the session cannot create credentials', async() => {
    const credential = createSessionRequestCredential({ webId: WEB_ID });
    await expect(credential.authorization()).resolves.toBeUndefined();
    await expect(credential.release()).resolves.toBeUndefined();

    const anonymous = createSessionRequestCredential({ capability: capability() });
    await expect(anonymous.authorization()).resolves.toBeUndefined();
  });

  it('releases a credential whose id cannot be read without failing', async() => {
    const credentials = capability({
      create: vi.fn(async() => ({ apiKey: 'sk-not-base64', resource: 'https://pod.example/.account/credential/2' })),
    });
    const credential = createSessionRequestCredential({ capability: credentials, webId: WEB_ID });
    await credential.authorization();

    await expect(credential.release()).resolves.toBeUndefined();
    expect(credentials.revoke).toHaveBeenCalledWith(expect.objectContaining({ clientId: '' }));
  });
});

describe('withRequestPodAuthorization', () => {
  const missing = () => Response.json({ error: 'service_access_missing' }, { status: 403 });

  it('retries the Gateway protocol error while preserving its response format', async () => {
    const first = vi.fn(async () => Response.json({ error: {
      code: 'service_access_missing', message: 'Pod access is missing',
    } }, { status: 403 }));
    const retry = vi.fn(async () => Response.json({ data: [{ id: 'selected-model' }] }));
    const credential = vi.fn(async () => 'Bearer sk-session');
    const wrapped = withRequestPodAuthorization(first, credential, retry);
    const response = await wrapped('https://xpod.example/v1/models');
    expect(await response.json()).toEqual({ data: [{ id: 'selected-model' }] });
    expect(credential).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('does not treat another Gateway protocol refusal as missing Pod access', async () => {
    const first = vi.fn(async () => Response.json({ error: {
      code: 'credential_unavailable', message: 'Upstream access unavailable',
    } }, { status: 403 }));
    const retry = vi.fn(async () => Response.json({ data: [] }));
    const credential = vi.fn(async () => 'Bearer sk-session');
    const wrapped = withRequestPodAuthorization(first, credential, retry);
    expect((await wrapped('https://xpod.example/v1/models')).status).toBe(403);
    expect(credential).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it('retries once with the session credential when the API reports missing Pod access', async() => {
    const attempts: Array<string | null> = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization');
      attempts.push(authorization);
      return authorization ? Response.json({ ok: true }) : missing();
    }) as typeof fetch;
    const wrapped = withRequestPodAuthorization(fetchImpl, async() => 'Bearer sk-session');

    const response = await wrapped('https://xpod.example/v1/chat/completions', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(attempts).toEqual([ null, 'Bearer sk-session' ]);
  });

  it('replays a consumed Request body on the retry', async() => {
    const bodies: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const authorization = new Headers(init?.headers ?? request.headers).get('authorization');
      bodies.push(await request.text());
      return authorization ? Response.json({ ok: true }) : missing();
    }) as typeof fetch;
    const wrapped = withRequestPodAuthorization(fetchImpl, async() => 'Bearer sk-session');

    const response = await wrapped(new Request('https://xpod.example/v1/chat/completions', {
      method: 'POST',
      body: 'messages',
    }));

    expect(response.status).toBe(200);
    expect(bodies).toEqual([ 'messages', 'messages' ]);
  });

  it('leaves other failures, other statuses and other bodies alone', async() => {
    const attempts: number[] = [];
    const fetchImpl = (async () => {
      attempts.push(1);
      return Response.json({ error: 'pod_owner_mismatch' }, { status: 403 });
    }) as typeof fetch;
    const wrapped = withRequestPodAuthorization(fetchImpl, async() => 'Bearer sk-session');

    const mismatched = await wrapped('https://xpod.example/api/ai/gateway/keys');
    expect(mismatched.status).toBe(403);
    expect(attempts).toHaveLength(1);

    const notJson = (async () => new Response('nope', { status: 403 })) as typeof fetch;
    await expect(withRequestPodAuthorization(notJson, async() => 'Bearer sk-session')('https://xpod.example/v1/models'))
      .resolves.toMatchObject({ status: 403 });
  });

  it('returns the original refusal when no credential can be prepared or the retry still fails', async() => {
    const noCredential = (async () => missing()) as typeof fetch;
    const withNone = withRequestPodAuthorization(noCredential, async() => undefined);
    await expect(withNone('https://xpod.example/api/ai/gateway/keys')).resolves.toMatchObject({ status: 403 });

    let calls = 0;
    const stillRefused = (async () => {
      calls += 1;
      return missing();
    }) as typeof fetch;
    const wrapped = withRequestPodAuthorization(stillRefused, async() => 'Bearer sk-session');
    await expect(wrapped('https://xpod.example/api/ai/gateway/keys')).resolves.toMatchObject({ status: 403 });
    expect(calls).toBe(2);
  });

  it('keeps the caller headers it was given', async() => {
    let seen: Record<string, string | null> = {};
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen = { authorization: headers.get('authorization'), accept: headers.get('accept') };
      return headers.get('authorization') ? Response.json({ ok: true }) : missing();
    }) as typeof fetch;
    const wrapped = withRequestPodAuthorization(fetchImpl, async() => 'Bearer sk-session');

    await wrapped('https://xpod.example/api/ai/gateway/keys', { headers: { accept: 'application/json' } });

    expect(seen).toEqual({ authorization: 'Bearer sk-session', accept: 'application/json' });
  });

  it('sends the retry over the transport that keeps the credential', async() => {
    // A session transport owns the Authorization header and overwrites whatever a caller set, so
    // replaying the request through it would replace the credential with the session's own token.
    const sessionTransport = (async () => missing()) as typeof fetch;
    const retries: Array<string | null> = [];
    const credentialTransport = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      retries.push(new Headers(init?.headers).get('authorization'));
      return Response.json({ ok: true });
    }) as typeof fetch;

    const wrapped = withRequestPodAuthorization(
      sessionTransport,
      async() => 'Bearer sk-session',
      credentialTransport,
    );

    await expect(wrapped('https://xpod.example/api/ai/gateway/keys')).resolves.toMatchObject({ status: 200 });
    expect(retries).toEqual(['Bearer sk-session']);
  });

  it('is a no-op without an authorization provider', () => {
    const fetchImpl = (async() => new Response('ok')) as typeof fetch;
    expect(withRequestPodAuthorization(fetchImpl, undefined)).toBe(fetchImpl);
  });
});

describe('Gateway credential boundary', () => {
  it.each(['https://other.example/api/tasks', 'https://xpod.example/alice/data.ttl', 'https://xpod.example/.account/'])('never forwards a credential to %s', async(url) => {
    const transport = vi.fn(async() => Response.json({ error: 'service_access_missing' }, { status: 403 }));
    const credential = vi.fn(async() => 'Bearer secret');
    expect(needsPodAuthorization(url, 'https://xpod.example')).toBe(false);
    await withRequestPodAuthorization(transport, credential)(url);
    expect(credential).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('removes the first token proof when retrying a Request with a different credential', async() => {
    const first = vi.fn(async() => Response.json({ error: 'service_access_missing' }, { status: 403 }));
    const retry = vi.fn(async(_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('dpop')).toBeNull();
      expect(headers.get('authorization')).toBe('Bearer sk-session');
      return Response.json({ ok: true });
    });
    await withRequestPodAuthorization(first, async() => 'Bearer sk-session', retry)(new Request('https://xpod.example/api/tasks', { headers: { dpop: 'old-proof' } }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('fails closed without a known Gateway origin', async() => {
    const transport = vi.fn(async() => Response.json({ error: 'service_access_missing' }, { status: 403 }));
    const credential = vi.fn(async() => 'Bearer secret');
    await withAuthorization(transport, credential)('https://xpod.example/api/tasks');
    expect(credential).not.toHaveBeenCalled();
  });
});
