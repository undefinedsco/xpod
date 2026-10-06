import { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { AesInvocationTokenCodec } from '../../../src/api/ai-gateway/auth/InvocationTokenCodec';
import { GatewayApiKeyAuthenticator } from '../../../src/api/ai-gateway/auth/GatewayApiKeyAuthenticator';
import {
  canManageGatewayKeys,
  isInternalGatewayInvocationPrincipal,
} from '../../../src/api/ai-gateway/auth/GatewayPrincipal';

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const AUDIENCE = 'https://xpod.example';
const NOW = new Date('2026-08-25T01:00:00.000Z');

const codec = new AesInvocationTokenCodec({
  active: { kid: 'active', secret: 'invocation-token-secret' },
});

function invocationToken(patch: Partial<Parameters<AesInvocationTokenCodec['encode']>[0]> = {}): string {
  return codec.encode({
    deployment: 'local',
    audience: AUDIENCE,
    issuer: AUDIENCE,
    webId: WEB_ID,
    scopes: ['models:read', 'inference:write'],
    issuedAt: new Date('2026-08-25T00:59:00.000Z'),
    expiresAt: new Date('2026-08-25T01:04:00.000Z'),
    jti: 'invocation-jti-0001',
    ...patch,
  });
}

function authenticator(): GatewayApiKeyAuthenticator {
  return new GatewayApiKeyAuthenticator({
    deployment: 'local',
    invocationTokenCodec: codec,
    invocationTokenAudience: AUDIENCE,
    now: () => NOW,
  });
}

describe('GatewayApiKeyAuthenticator', () => {
  it('authenticates AI-Connections invocation tokens and marks them internal', async () => {
    const token = invocationToken();
    const result = await authenticator().authenticate(bearerRequest(token));

    expect(result.success).toBe(true);
    if (!result.context || result.context.type !== 'solid') {
      throw new Error('Expected invocation authentication to return a Solid auth context.');
    }
    expect(result.context.webId).toBe(WEB_ID);
    expect(result.context).toMatchObject({
      viaGatewayApiKey: true,
      internalInvocation: true,
      gatewayKeyId: 'invocation-jti-0001',
      scopes: ['models:read', 'inference:write'],
      tokenType: 'Bearer',
    });
    expect(result.context.gatewayRuntimeAccess).toBeUndefined();
    expect(isInternalGatewayInvocationPrincipal(result.context)).toBe(true);
    expect(canManageGatewayKeys(result.context)).toBe(false);
  });

  it('fingerprints the bearer it accepted', async () => {
    const token = invocationToken();
    const result = await authenticator().authenticate(bearerRequest(token));

    expect(result.context).toMatchObject({
      gatewayKeyFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect((result.context as { gatewayKeyFingerprint: string }).gatewayKeyFingerprint)
      .not.toContain(token);
  });

  it.each([
    ['expired', { issuedAt: new Date('2026-08-25T00:40:00.000Z'), expiresAt: new Date('2026-08-25T00:45:00.000Z') }],
    ['wrong scope', { scopes: ['models:read'] }],
    ['wrong deployment', { deployment: 'cloud' as const }],
    ['wrong audience', { audience: 'https://other.example' }],
  ])('rejects a %s invocation token with the invocation error code', async (_label, patch) => {
    const result = await authenticator().authenticate(bearerRequest(invocationToken(patch)));

    expect(result).toMatchObject({
      success: false,
      error: 'Invalid gateway API key',
      statusCode: 401,
      category: 'invalid_credentials',
    });
    expect(result).not.toHaveProperty('context');
  });

  it('rejects an invocation token signed with another secret', async () => {
    const other = new AesInvocationTokenCodec({
      active: { kid: 'active', secret: 'another-invocation-secret' },
    });
    const foreign = other.encode({
      deployment: 'local',
      audience: AUDIENCE,
      issuer: AUDIENCE,
      webId: WEB_ID,
      scopes: ['models:read', 'inference:write'],
      issuedAt: new Date('2026-08-25T00:59:00.000Z'),
      expiresAt: new Date('2026-08-25T01:04:00.000Z'),
    });

    const result = await authenticator().authenticate(bearerRequest(foreign));

    expect(result).toMatchObject({
      success: false,
      error: 'Invalid gateway API key',
      statusCode: 401,
      category: 'invalid_credentials',
    });
  });

  it('no longer claims or accepts retired gateway API keys', async () => {
    // Nothing issues `xpod_gw_v1_*` any more; the bearer must not be claimed here so that it
    // falls through to the client-credentials authenticator and fails closed.
    const gatewayKey = 'xpod_gw_v1_local_gak_locator_secret';
    const subject = authenticator();

    expect(subject.canAuthenticate(bearerRequest(gatewayKey))).toBe(false);
    await expect(subject.authenticate(bearerRequest(gatewayKey))).resolves.toMatchObject({
      success: false,
      statusCode: 401,
      category: 'invalid_credentials',
    });
  });

  it('only claims the invocation token prefix', () => {
    const subject = authenticator();

    expect(subject.canAuthenticate(bearerRequest(invocationToken()))).toBe(true);
    expect(subject.canAuthenticate({ headers: {} } as IncomingMessage)).toBe(false);
    expect(subject.canAuthenticate(bearerRequest('sk-Y2xpZW50OnNlY3JldA=='))).toBe(false);
  });
});

function bearerRequest(token: string): IncomingMessage {
  return {
    headers: {
      authorization: `Bearer ${token}`,
    },
  } as IncomingMessage;
}
