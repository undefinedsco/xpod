import { describe, expect, it } from 'vitest';
import { AiConnectionsInvocationKeyIssuer } from '../../../src/api/ai-gateway/auth/AiConnectionsInvocationKeyIssuer';
import { AesInvocationTokenCodec } from '../../../src/api/ai-gateway/auth/InvocationTokenCodec';
import { canManageGatewayKeys } from '../../../src/api/ai-gateway/auth/GatewayPrincipal';

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const SCOPES = ['models:read', 'inference:write'];
const AI_CONNECTIONS_INVOCATION_SCOPES = SCOPES;
const AUDIENCE = 'https://pod.example';

describe('AiConnectionsInvocationKeyIssuer', () => {
  it('single-flights concurrent issuance and reuses within the safety window', async () => {
    let now = new Date('2026-07-24T00:00:00.000Z');
    const codec = new AesInvocationTokenCodec({
      active: { kid: 'active', secret: 'invocation-secret' },
    });
    const issuer = new AiConnectionsInvocationKeyIssuer({
      codec,
      deployment: 'local',
      baseUrl: 'http://127.0.0.1:3000/v1',
      audience: 'http://127.0.0.1:3000',
      now: () => now,
    });
    const context = { auth: { type: 'solid' as const, webId: WEB_ID } };

    const concurrent = await Promise.all(Array.from({ length: 20 }, () => issuer.issue(context)));
    expect(new Set(concurrent.map((entry) => entry.apiKey)).size).toBe(1);
    expect(new Set(concurrent.map((entry) => entry.expiresAt)).size).toBe(1);
    now = new Date('2026-07-24T00:04:20.000Z');
    expect((await issuer.issue(context)).apiKey).toBe(concurrent[0].apiKey);
  });

  it('binds signed Pod scope and isolates the cache between Pods of the same owner', async () => {
    const codec = new AesInvocationTokenCodec({ active: { kid: 'active', secret: 'pod-bound-invocation-secret' } });
    const issuer = new AiConnectionsInvocationKeyIssuer({ codec, deployment: 'local', baseUrl: 'https://gateway.example/v1' });
    const podA = 'https://storage.example/alice-a/';
    const podB = 'https://storage.example/alice-b/';
    const context = (authorizedPodUrl: string) => ({ auth: { type: 'solid' as const, webId: WEB_ID, authorizedPodUrl } });
    const first = await issuer.issue(context(podA));
    expect(codec.decode(first.apiKey)?.podUrl).toBe(podA);
    expect((await issuer.issue(context(podA))).apiKey).toBe(first.apiKey);
    const other = await issuer.issue(context(podB));
    expect(other.apiKey).not.toBe(first.apiKey);
    expect(codec.decode(other.apiKey)?.podUrl).toBe(podB);
    // The signed fact never comes from the untrusted hint alone.
    const unbound = await issuer.issue({ auth: { type: 'solid', webId: WEB_ID, requestedPodUrl: podA } });
    expect(codec.decode(unbound.apiKey)?.podUrl).toBeUndefined();
  });

  it('rotates before expiry and decodes as the current WebID with minimal scopes', async () => {
    let now = new Date('2026-07-24T00:00:00.000Z');
    const codec = new AesInvocationTokenCodec({
      active: { kid: 'active', secret: 'invocation-secret' },
    });
    const issuer = new AiConnectionsInvocationKeyIssuer({
      codec,
      deployment: 'local',
      baseUrl: 'http://127.0.0.1:3000/v1',
      audience: 'http://127.0.0.1:3000',
      ttlMs: 5 * 60_000,
      reuseSafetyMarginMs: 30_000,
      now: () => now,
    });
    const context = { auth: { type: 'solid' as const, webId: WEB_ID } };
    const first = await issuer.issue(context);

    now = new Date('2026-07-24T00:04:31.000Z');
    const rotated = await issuer.issue(context);
    expect(rotated.apiKey).not.toBe(first.apiKey);
    expect(rotated.expiresAt).toBe('2026-07-24T00:09:31.000Z');

    const claims = codec.decode(rotated.apiKey);
    expect(claims).toMatchObject({
      webId: WEB_ID,
      audience: 'http://127.0.0.1:3000',
      scopes: AI_CONNECTIONS_INVOCATION_SCOPES,
    });
    // Invocation principals never manage persistent credentials.
    expect(canManageGatewayKeys({
      type: 'solid',
      webId: WEB_ID,
      accountId: WEB_ID,
      internalInvocation: true,
      scopes: claims?.scopes ?? [],
      tokenType: 'Bearer',
    } as any)).toBe(false);
  });

  it('fails closed for untrusted, chained, and non-canonical Solid identities', async () => {
    const codec = new AesInvocationTokenCodec({
      active: { kid: 'active', secret: 'invocation-secret' },
    });
    const issuer = new AiConnectionsInvocationKeyIssuer({
      codec,
      deployment: 'cloud',
      baseUrl: 'https://api.example/v1',
      audience: 'https://api.example',
    });

    await expect(issuer.issue({ userId: 'anonymous' })).rejects.toThrow(/authenticated Solid WebID/);
    await expect(issuer.issue({
      auth: { type: 'solid', webId: WEB_ID, viaGatewayApiKey: true },
    })).rejects.toThrow(/authenticated Solid WebID/);
    await expect(issuer.issue({
      auth: { type: 'solid', webId: 'HTTPS://pod.example:443/alice/../alice/profile/card#me' },
    })).rejects.toThrow(/canonical/);
  });

  it('carries the owner active Gateway model into the invocation config', async () => {
    const codec = new AesInvocationTokenCodec({ active: { kid: 'active', secret: 'invocation-secret' } });
    const issuer = new AiConnectionsInvocationKeyIssuer({
      codec,
      deployment: 'local',
      baseUrl: 'http://127.0.0.1:3000/v1',
      audience: 'http://127.0.0.1:3000',
      resolveModel: async ({ webId }) => webId === WEB_ID ? 'deepseek-v4-pro' : undefined,
    });
    const issued = await issuer.issue({ auth: { type: 'solid', webId: WEB_ID } });
    expect(issued.model).toBe('deepseek-v4-pro');
  });

  it('still issues the key without a model when model lookup fails', async () => {
    const codec = new AesInvocationTokenCodec({ active: { kid: 'active', secret: 'invocation-secret' } });
    const issuer = new AiConnectionsInvocationKeyIssuer({
      codec,
      deployment: 'local',
      baseUrl: 'http://127.0.0.1:3000/v1',
      audience: 'http://127.0.0.1:3000',
      resolveModel: async () => { throw new Error('catalog unavailable'); },
    });
    const issued = await issuer.issue({ auth: { type: 'solid', webId: WEB_ID } });
    expect(issued.apiKey).toMatch(/^xpod_inv_v1\./);
    expect(issued.model).toBeUndefined();
  });
});

describe('AesInvocationTokenCodec', () => {
  it('rejects tampered or cross-secret tokens and enforces the maximum TTL at encode time', async () => {
    const now = new Date('2026-07-24T00:00:00.000Z');
    const codec = new AesInvocationTokenCodec({
      active: { kid: 'active', secret: 'shared-secret' },
    });
    const otherCodec = new AesInvocationTokenCodec({
      active: { kid: 'active', secret: 'other-secret' },
    });
    const valid = codec.encode({
      deployment: 'local',
      audience: AUDIENCE,
      issuer: AUDIENCE,
      webId: WEB_ID,
      scopes: SCOPES,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 5 * 60_000),
    });

    expect(codec.decode(valid)?.webId).toBe(WEB_ID);
    expect(codec.decode(tamperInvocationTokenTag(valid))).toBeUndefined();
    expect(otherCodec.decode(valid)).toBeUndefined();
    expect(() => codec.encode({
      deployment: 'local',
      audience: AUDIENCE,
      issuer: AUDIENCE,
      webId: WEB_ID,
      scopes: SCOPES,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 15 * 60_000 + 1),
    })).toThrow(/TTL/);
  });

  it('accepts tokens encrypted by a previous key but issues only with the active key', async () => {
    const oldCodec = new AesInvocationTokenCodec({
      active: { kid: 'old', secret: 'old-secret' },
    });
    const rotatingCodec = new AesInvocationTokenCodec({
      active: { kid: 'new', secret: 'new-secret' },
      previous: [{ kid: 'old', secret: 'old-secret' }],
    });
    const now = new Date('2026-07-24T00:00:00.000Z');
    const oldToken = oldCodec.encode({
      deployment: 'cloud',
      audience: AUDIENCE,
      issuer: AUDIENCE,
      webId: WEB_ID,
      scopes: SCOPES,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const newToken = rotatingCodec.encode({
      deployment: 'cloud',
      audience: AUDIENCE,
      issuer: AUDIENCE,
      webId: WEB_ID,
      scopes: SCOPES,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });

    expect(oldToken).toMatch(/^xpod_inv_v1\.old\./);
    expect(newToken).toMatch(/^xpod_inv_v1\.new\./);
    expect(rotatingCodec.decode(oldToken)?.webId).toBe(WEB_ID);
    expect(oldCodec.decode(newToken)).toBeUndefined();
  });
});

function tamperInvocationTokenTag(token: string): string {
  const parts = token.split('.');
  const tag = parts.at(-1);
  if (!tag) throw new Error('Expected an invocation token authentication tag');
  parts[parts.length - 1] = `${tag.startsWith('A') ? 'B' : 'A'}${tag.slice(1)}`;
  return parts.join('.');
}
