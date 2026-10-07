import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';

import { resolveOwnerPodBaseUrl } from '../../../src/api/ai-gateway/pod/PodBaseUrlResolver';
import { InvocationTokenAuthenticator } from '../../../src/api/ai-gateway/auth/InvocationTokenAuthenticator';
import { AesInvocationTokenCodec } from '../../../src/api/ai-gateway/auth/InvocationTokenCodec';

const WEB_ID = 'https://id.example/alice/profile/card#me';

function requestWith(token: string, url: string, method = 'GET'): IncomingMessage {
  return {
    url,
    method,
    headers: {
      authorization: `Bearer ${token}`,
    },
  } as IncomingMessage;
}

describe('InvocationTokenAuthenticator', () => {
  it('authenticates short-lived invocation tokens only for client configuration routes', async () => {
    const codec = new AesInvocationTokenCodec({
      active: { kid: 'active', secret: 'invocation-secret' },
    });
    const token = codec.encode({
      deployment: 'cloud',
      audience: 'https://xpod.example',
      issuer: 'https://xpod.example',
      webId: WEB_ID,
      scopes: ['client-config:read', 'client-config:write'],
      issuedAt: new Date('2026-08-04T00:00:00.000Z'),
      expiresAt: new Date('2026-08-04T00:10:00.000Z'),
    });
    const authenticator = new InvocationTokenAuthenticator({
      codec,
      deployment: 'cloud',
      audience: 'https://xpod.example',
      now: () => new Date('2026-08-04T00:01:00.000Z'),
    });

    expect(authenticator.canAuthenticate(requestWith(token, '/api/ai/client-configuration/codex'))).toBe(true);
    expect(authenticator.canAuthenticate(requestWith(token, '/v1/models'))).toBe(false);

    await expect(authenticator.authenticate(requestWith(token, '/api/ai/client-configuration/codex')))
      .resolves
      .toMatchObject({
        success: true,
        context: {
          type: 'solid',
          webId: WEB_ID,
          accountId: WEB_ID,
          internalInvocation: true,
          scopes: ['client-config:read', 'client-config:write'],
        },
      });
  });

  it('trusts only the signed Pod scope and rejects a same-owner selection outside it', async () => {
    const podUrl = 'https://local.example/owned/';
    const codec = new AesInvocationTokenCodec({ active: { kid: 'active', secret: 'fixture-secret' } });
    const token = codec.encode({
      deployment: 'local', audience: 'https://local.example', issuer: 'https://local.example',
      webId: WEB_ID, podUrl, scopes: ['client-config:read'],
      issuedAt: new Date('2026-08-04T00:00:00Z'), expiresAt: new Date('2026-08-04T00:10:00Z'),
    });
    const authenticator = new InvocationTokenAuthenticator({ codec, deployment: 'local', audience: 'https://local.example', now: () => new Date('2026-08-04T00:01:00Z') });
    const req = requestWith(token, '/api/ai/client-configuration/codex');
    req.headers['x-xpod-pod-url'] = 'https://local.example/other/';
    const result = await authenticator.authenticate(req);
    expect(result.context).toMatchObject({ authorizedPodUrl: podUrl });
    expect(result.context).not.toHaveProperty('requestedPodUrl');
    if (result.context?.type !== 'solid') throw new Error('Expected authenticated Solid context');
    await expect(resolveOwnerPodBaseUrl(WEB_ID, async (_owner, selected) => selected, {
      ...result.context, requestedPodUrl: 'https://local.example/other/',
    })).rejects.toThrow('service_access_missing');
  });

  it('rejects inference scopes and never authenticates inference routes', async () => {
    const codec = new AesInvocationTokenCodec({
      active: { kid: 'active', secret: 'invocation-secret' },
    });
    const token = codec.encode({
      deployment: 'cloud',
      audience: 'https://xpod.example',
      issuer: 'https://xpod.example',
      webId: WEB_ID,
      scopes: ['models:read', 'inference:write'],
      issuedAt: new Date('2026-08-04T00:00:00.000Z'),
      expiresAt: new Date('2026-08-04T00:10:00.000Z'),
    });
    const authenticator = new InvocationTokenAuthenticator({
      codec,
      deployment: 'cloud',
      audience: 'https://xpod.example',
      now: () => new Date('2026-08-04T00:01:00.000Z'),
    });

    expect(authenticator.canAuthenticate(requestWith(token, '/v1/models'))).toBe(false);
    expect(authenticator.canAuthenticate(requestWith(token, '/v1/responses', 'POST'))).toBe(false);
    await expect(authenticator.authenticate(requestWith(token, '/api/ai/client-configuration/codex', 'POST')))
      .resolves
      .toMatchObject({
        success: false,
        error: 'Invalid invocation token',
        statusCode: 401,
      });
  });
});
