import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AiConnectionsInvocationKeyIssuer } from '../../../src/api/ai-gateway/auth/AiConnectionsInvocationKeyIssuer';
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
const AI_CONNECTIONS_INVOCATION_SCOPES = SCOPES;
const AUDIENCE = 'https://pod.example';

function requestWith(token: string): any {
  return { headers: { authorization: `Bearer ${token}` } };
}

describe('AiConnectionsInvocationKeyIssuer', () => {
  it('single-flights concurrent issuance, reuses within the safety window, and never writes a repository record', async () => {
    const repository = new InMemoryGatewayAccessKeyRepository();
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
    await expect(repository.listByOwner(WEB_ID)).resolves.toEqual([]);
  });

  it('rotates before expiry and authenticates as the current WebID with minimal scopes', async () => {
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

    const repository = new InMemoryGatewayAccessKeyRepository();
    const authenticator = new GatewayApiKeyAuthenticator({
      repository,
      invocationTokenCodec: codec,
      deployment: 'local',
      invocationTokenAudience: 'http://127.0.0.1:3000',
      now: () => now,
    });
    const authenticated = await authenticator.authenticate(requestWith(rotated.apiKey));
    expect(authenticated).toMatchObject({
      success: true,
      context: {
        type: 'solid',
        webId: WEB_ID,
        accountId: WEB_ID,
        viaGatewayApiKey: true,
        internalInvocation: true,
        scopes: AI_CONNECTIONS_INVOCATION_SCOPES,
      },
    });
    expect(canManageGatewayKeys(authenticated.context)).toBe(false);
    await expect(repository.listByOwner(WEB_ID)).resolves.toEqual([]);
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
      invocationTokenAudience: AUDIENCE,
      now: () => now,
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
    const missingScope = codec.encode({
      deployment: 'local',
      audience: AUDIENCE,
      issuer: AUDIENCE,
      webId: WEB_ID,
      scopes: ['models:read'],
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 5 * 60_000),
    });
    const wrongDeployment = codec.encode({
      deployment: 'cloud',
      audience: AUDIENCE,
      issuer: AUDIENCE,
      webId: WEB_ID,
      scopes: SCOPES,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 5 * 60_000),
    });
    const futureIssued = codec.encode({
      deployment: 'local',
      audience: AUDIENCE,
      issuer: AUDIENCE,
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
      audience: AUDIENCE,
      issuer: AUDIENCE,
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

  it('rejects same-deployment invocation tokens for a different audience, tampered audience, and legacy tokens without audience', async () => {
    const now = new Date('2026-07-24T00:00:00.000Z');
    const codec = new AesInvocationTokenCodec({
      active: { kid: 'active', secret: 'shared-secret' },
    });
    const authenticator = new GatewayApiKeyAuthenticator({
      repository: new InMemoryGatewayAccessKeyRepository(),
      invocationTokenCodec: codec,
      deployment: 'cloud',
      invocationTokenAudience: 'https://api.example',
      now: () => now,
    });
    const wrongAudience = codec.encode({
      deployment: 'cloud',
      audience: 'https://other.example',
      issuer: 'https://other.example',
      webId: WEB_ID,
      scopes: SCOPES,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const valid = codec.encode({
      deployment: 'cloud',
      audience: 'https://api.example',
      issuer: 'https://api.example',
      webId: WEB_ID,
      scopes: SCOPES,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const wrongIssuer = codec.encode({
      deployment: 'cloud',
      audience: 'https://api.example',
      issuer: 'https://issuer.example',
      webId: WEB_ID,
      scopes: SCOPES,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const tampered = `${valid.slice(0, -1)}${valid.endsWith('A') ? 'B' : 'A'}`;
    const legacyNoAudience = encodeLegacyInvocationTokenWithoutAudience({
      kid: 'active',
      secret: 'shared-secret',
      claims: {
        v: 1,
        kid: 'active',
        deployment: 'cloud',
        webId: WEB_ID,
        scopes: SCOPES,
        iat: now.getTime(),
        exp: now.getTime() + 60_000,
        jti: 'legacy_legacy_legacy_legacy',
      },
    });

    for (const token of [wrongAudience, wrongIssuer, tampered, legacyNoAudience]) {
      await expect(authenticator.authenticate(requestWith(token))).resolves.toMatchObject({
        success: false,
        category: 'invalid_credentials',
        statusCode: 401,
      });
    }
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

function encodeLegacyInvocationTokenWithoutAudience(input: {
  kid: string;
  secret: string;
  claims: Record<string, unknown>;
}): string {
  const key = createHash('sha256')
    .update('xpod:gateway:internal-invocation:v1\0', 'utf8')
    .update(input.secret, 'utf8')
    .digest()
    .subarray(0, 32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`xpod:gateway:internal-invocation:v1.${input.kid}`));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(input.claims), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    'xpod_inv_v1',
    input.kid,
    nonce.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}
