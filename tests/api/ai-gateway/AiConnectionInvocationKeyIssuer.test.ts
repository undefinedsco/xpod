import { describe, expect, it, vi } from 'vitest';
import { AiConnectionInvocationKeyIssuer } from '../../../src/api/ai-gateway/auth/AiConnectionInvocationKeyIssuer';
import { GatewayApiKeyAuthenticator } from '../../../src/api/ai-gateway/auth/GatewayApiKeyAuthenticator';
import { AesInvocationTokenCodec } from '../../../src/api/ai-gateway/auth/InvocationTokenCodec';
import { InMemoryGatewayAccessKeyRepository } from './InMemoryGatewayAccessKeyRepository';
import {
  AesGatewayKeyLocatorCodec,
  createGatewayKeyLocator,
} from '../../../src/api/ai-gateway/auth/GatewayKeyLocatorCodec';
import { canManageGatewayKeys } from '../../../src/api/ai-gateway/auth/GatewayPrincipal';

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const SCOPES = ['models:read', 'inference:write'];

function requestWith(token: string): any {
  return { headers: { authorization: `Bearer ${token}` } };
}

describe('AiConnectionInvocationKeyIssuer', () => {
  it('single-flights concurrent issuance, reuses within the safety window, and never writes a repository record', async () => {
    const repository = new InMemoryGatewayAccessKeyRepository();
    let now = new Date('2026-07-24T00:00:00.000Z');
    const codec = new AesInvocationTokenCodec({
      active: { kid: 'active', secret: 'invocation-secret' },
    });
    const issuer = new AiConnectionInvocationKeyIssuer({
      codec,
      deployment: 'local',
      baseUrl: 'http://127.0.0.1:3000/v1',
      now: () => now,
    });
    const context = { auth: { type: 'solid' as const, webId: WEB_ID } };

    const concurrent = await Promise.all(Array.from({ length: 20 }, () => issuer.issue(context)));
    expect(new Set(concurrent.map((entry) => entry.gatewayKey)).size).toBe(1);
    now = new Date('2026-07-24T00:04:20.000Z');
    expect((await issuer.issue(context)).gatewayKey).toBe(concurrent[0].gatewayKey);
    await expect(repository.listByOwner(WEB_ID)).resolves.toEqual([]);
  });

  it('rotates before expiry and authenticates as the current WebID with minimal scopes', async () => {
    let now = new Date('2026-07-24T00:00:00.000Z');
    const codec = new AesInvocationTokenCodec({
      active: { kid: 'active', secret: 'invocation-secret' },
    });
    const issuer = new AiConnectionInvocationKeyIssuer({
      codec,
      deployment: 'local',
      baseUrl: 'http://127.0.0.1:3000/v1',
      ttlMs: 5 * 60_000,
      reuseSafetyMarginMs: 30_000,
      now: () => now,
    });
    const context = { auth: { type: 'solid' as const, webId: WEB_ID } };
    const first = await issuer.issue(context);

    now = new Date('2026-07-24T00:04:31.000Z');
    const rotated = await issuer.issue(context);
    expect(rotated.gatewayKey).not.toBe(first.gatewayKey);

    const repository = new InMemoryGatewayAccessKeyRepository();
    const authenticator = new GatewayApiKeyAuthenticator({
      repository,
      invocationTokenCodec: codec,
      deployment: 'local',
      now: () => now,
    });
    const authenticated = await authenticator.authenticate(requestWith(rotated.gatewayKey));
    expect(authenticated).toMatchObject({
      success: true,
      context: {
        type: 'solid',
        webId: WEB_ID,
        accountId: WEB_ID,
        viaGatewayApiKey: true,
        internalInvocation: true,
        scopes: SCOPES,
      },
    });
    expect(canManageGatewayKeys(authenticated.context)).toBe(false);
    await expect(repository.listByOwner(WEB_ID)).resolves.toEqual([]);
  });

  it('fails closed for untrusted, chained, and non-canonical Solid identities', async () => {
    const codec = new AesInvocationTokenCodec({
      active: { kid: 'active', secret: 'invocation-secret' },
    });
    const issuer = new AiConnectionInvocationKeyIssuer({
      codec,
      deployment: 'cloud',
      baseUrl: 'https://api.example/v1',
    });

    await expect(issuer.issue({ userId: 'anonymous' })).rejects.toThrow(/authenticated Solid WebID/);
    await expect(issuer.issue({
      auth: { type: 'solid', webId: WEB_ID, viaGatewayApiKey: true },
    })).rejects.toThrow(/authenticated Solid WebID/);
    await expect(issuer.issue({
      auth: { type: 'solid', webId: 'HTTPS://pod.example:443/alice/../alice/profile/card#me' },
    })).rejects.toThrow(/canonical/);
  });
});

describe('stateless invocation authentication', () => {
  it('rejects tamper, expiry, deployment mismatch, missing scopes, and locator-key interchange', async () => {
    let now = new Date('2026-07-24T00:00:00.000Z');
    const codec = new AesInvocationTokenCodec({
      active: { kid: 'active', secret: 'shared-secret' },
    });
    const repository = new InMemoryGatewayAccessKeyRepository();
    const repositoryLookup = vi.spyOn(repository, 'findById');
    const authenticator = new GatewayApiKeyAuthenticator({
      repository,
      invocationTokenCodec: codec,
      deployment: 'local',
      now: () => now,
    });
    const valid = codec.encode({
      deployment: 'local',
      webId: WEB_ID,
      scopes: SCOPES,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 5 * 60_000),
    });
    const missingScope = codec.encode({
      deployment: 'local',
      webId: WEB_ID,
      scopes: ['models:read'],
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 5 * 60_000),
    });
    const wrongDeployment = codec.encode({
      deployment: 'cloud',
      webId: WEB_ID,
      scopes: SCOPES,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 5 * 60_000),
    });
    const futureIssued = codec.encode({
      deployment: 'local',
      webId: WEB_ID,
      scopes: SCOPES,
      issuedAt: new Date(now.getTime() + 5_001),
      expiresAt: new Date(now.getTime() + 65_001),
    });
    const locatorCodec = new AesGatewayKeyLocatorCodec({
      active: { kid: 'active', secret: 'shared-secret' },
    });
    const locator = createGatewayKeyLocator(WEB_ID, 'local', locatorCodec);
    expect(codec.decode(locator)).toBeUndefined();
    expect(locatorCodec.decode(valid)).toBeUndefined();
    expect(() => codec.encode({
      deployment: 'local',
      webId: WEB_ID,
      scopes: SCOPES,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 15 * 60_000 + 1),
    })).toThrow(/TTL/);

    const attempts = [
      `${valid.slice(0, -1)}${valid.endsWith('A') ? 'B' : 'A'}`,
      missingScope,
      wrongDeployment,
      futureIssued,
    ];
    for (const token of attempts) {
      await expect(authenticator.authenticate(requestWith(token))).resolves.toMatchObject({
        success: false,
        category: 'invalid_credentials',
        statusCode: 401,
      });
    }
    now = new Date('2026-07-24T00:05:01.000Z');
    await expect(authenticator.authenticate(requestWith(valid))).resolves.toMatchObject({
      success: false,
      category: 'invalid_credentials',
      statusCode: 401,
    });
    expect(repositoryLookup).not.toHaveBeenCalled();
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
      webId: WEB_ID,
      scopes: SCOPES,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const newToken = rotatingCodec.encode({
      deployment: 'cloud',
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
