import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';

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
