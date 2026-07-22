import type { IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import {
  GatewayApiKeyAuthenticator,
} from '../../../src/api/ai-gateway/auth/GatewayApiKeyAuthenticator';
import { InMemoryGatewayAccessKeyRepository } from './InMemoryGatewayAccessKeyRepository';
import {
  createGatewayApiKey,
  parseGatewayApiKey,
  verifyGatewayApiKeySecret,
} from '../../../src/api/ai-gateway/auth/GatewayApiKey';
import * as gatewayApiKeyModule from '../../../src/api/ai-gateway/auth/GatewayApiKey';

const WEB_ID = 'https://id.example/alice/profile/card#me';

function requestWith(key: string): IncomingMessage {
  return {
    headers: {
      authorization: `Bearer ${key}`,
    },
  } as IncomingMessage;
}

describe('Gateway API keys', () => {
  it('uses a public format with version, deployment, opaque key id and secret only', async () => {
    const key = await createGatewayApiKey({
      deployment: 'local',
      keyId: 'gak_test_123',
    });

    expect(key.plaintext).toMatch(/^xpod_gw_v1_local_gak_test_123_[A-Za-z0-9_-]+$/);
    expect(key.plaintext).not.toContain('sk-provider-secret');
    expect(key.record.secretHash).not.toContain(key.secret);
    expect(key.record.secretHash).toMatch(/^scrypt\$/);
    expect(parseGatewayApiKey(key.plaintext)).toEqual({
      version: 'v1',
      deployment: 'local',
      keyId: 'gak_test_123',
      secret: key.secret,
    });
  });

  it('verifies secrets with encoded scrypt cost and rejects wrong length without throwing', async () => {
    const key = await createGatewayApiKey({
      deployment: 'cloud',
      keyId: 'gak_hash_123',
    });

    await expect(verifyGatewayApiKeySecret(key.secret, key.record.secretHash)).resolves.toBe(true);
    await expect(verifyGatewayApiKeySecret(`${key.secret}x`, key.record.secretHash)).resolves.toBe(false);
    await expect(verifyGatewayApiKeySecret('', key.record.secretHash)).resolves.toBe(false);
  });

  it('rejects unsupported or hostile scrypt encodings before deriving', async () => {
    const valid = await createGatewayApiKey({
      deployment: 'cloud',
      keyId: 'gak_hash_strict',
    });
    const hostileCost = valid.record.secretHash.replace('$N=16384$', '$N=1048576$');
    const malformedSalt = valid.record.secretHash.replace(/salt=[^$]+/, 'salt=%%%%');
    const malformedKey = valid.record.secretHash.replace(/key=[^$]+/, 'key=short');
    const unsupportedVersion = valid.record.secretHash.replace('$v=1$', '$v=2$');
    const unsupportedOrder = valid.record.secretHash.replace('$N=16384$r=8$', '$r=8$N=16384$');

    await expect(verifyGatewayApiKeySecret(valid.secret, hostileCost)).resolves.toBe(false);
    await expect(verifyGatewayApiKeySecret(valid.secret, malformedSalt)).resolves.toBe(false);
    await expect(verifyGatewayApiKeySecret(valid.secret, malformedKey)).resolves.toBe(false);
    await expect(verifyGatewayApiKeySecret(valid.secret, unsupportedVersion)).resolves.toBe(false);
    await expect(verifyGatewayApiKeySecret(valid.secret, unsupportedOrder)).resolves.toBe(false);
  });
});

describe('GatewayApiKeyAuthenticator', () => {
  it('authenticates active keys for the current deployment and returns a Solid-compatible context', async () => {
    const repository = new InMemoryGatewayAccessKeyRepository();
    const issued = await createGatewayApiKey({
      deployment: 'cloud',
      keyId: 'gak_active',
    });
    await repository.create({
      ...issued.record,
      owner: WEB_ID,
      scopes: ['models:read', 'inference:write'],
      createdAt: new Date('2026-07-23T00:00:00.000Z'),
    });
    const authenticator = new GatewayApiKeyAuthenticator({
      repository,
      deployment: 'cloud',
      now: () => new Date('2026-07-23T00:01:00.000Z'),
    });

    const result = await authenticator.authenticate(requestWith(issued.plaintext));

    expect(result).toMatchObject({
      success: true,
      context: {
        type: 'solid',
        webId: WEB_ID,
        accountId: WEB_ID,
        viaGatewayApiKey: true,
        gatewayKeyId: 'gak_active',
        scopes: ['models:read', 'inference:write'],
      },
    });
    await expect(repository.findById('gak_active')).resolves.toMatchObject({
      lastUsedAt: new Date('2026-07-23T00:01:00.000Z'),
    });
  });

  it('fails uniformly for bad secrets, deployment mismatch, expiry, revocation and missing scope', async () => {
    const repository = new InMemoryGatewayAccessKeyRepository();
    const active = await createGatewayApiKey({ deployment: 'cloud', keyId: 'gak_active' });
    const local = await createGatewayApiKey({ deployment: 'local', keyId: 'gak_local' });
    const expired = await createGatewayApiKey({ deployment: 'cloud', keyId: 'gak_expired' });
    const revoked = await createGatewayApiKey({ deployment: 'cloud', keyId: 'gak_revoked' });
    const noScope = await createGatewayApiKey({ deployment: 'cloud', keyId: 'gak_no_scope' });
    await repository.create({ ...active.record, owner: WEB_ID, scopes: ['models:read', 'inference:write'], createdAt: new Date() });
    await repository.create({ ...local.record, owner: WEB_ID, scopes: ['models:read', 'inference:write'], createdAt: new Date() });
    await repository.create({
      ...expired.record,
      owner: WEB_ID,
      scopes: ['models:read', 'inference:write'],
      createdAt: new Date('2026-07-22T00:00:00.000Z'),
      expiresAt: new Date('2026-07-22T01:00:00.000Z'),
    });
    await repository.create({
      ...revoked.record,
      owner: WEB_ID,
      scopes: ['models:read', 'inference:write'],
      createdAt: new Date(),
      revokedAt: new Date('2026-07-22T01:00:00.000Z'),
    });
    await repository.create({ ...noScope.record, owner: WEB_ID, scopes: ['models:read'], createdAt: new Date() });
    const authenticator = new GatewayApiKeyAuthenticator({
      repository,
      deployment: 'cloud',
      requiredScopes: ['models:read', 'inference:write'],
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    });

    const attempts = [
      active.plaintext.replace(/.$/, 'x'),
      local.plaintext,
      expired.plaintext,
      revoked.plaintext,
      noScope.plaintext,
      'xpod_gw_v1_cloud_gak_missing_missingsecret',
    ];
    for (const plaintext of attempts) {
      await expect(authenticator.authenticate(requestWith(plaintext))).resolves.toEqual({
        success: false,
        error: 'Invalid gateway API key',
      });
    }
  });

  it('lets non-gateway bearer credentials fall through to later authenticators', () => {
    const authenticator = new GatewayApiKeyAuthenticator({
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'local',
    });

    expect(authenticator.canAuthenticate(requestWith('sk-legacy-client-credential'))).toBe(false);
  });

  it('runs authenticator-owned dummy scrypt verification when the repository misses', async () => {
    const repository = new InMemoryGatewayAccessKeyRepository();
    const authenticator = new GatewayApiKeyAuthenticator({
      repository,
      deployment: 'cloud',
    });
    const spy = vi.spyOn(gatewayApiKeyModule, 'verifyGatewayApiKeySecret');

    await expect(authenticator.authenticate(requestWith('xpod_gw_v1_cloud_gak_missing_opaque-secret'))).resolves.toEqual({
      success: false,
      error: 'Invalid gateway API key',
    });

    expect(spy).toHaveBeenCalledWith('opaque-secret', expect.stringMatching(/^scrypt\$/));
  });

  it('reports infrastructure lookup errors without treating them as invalid keys', async () => {
    const issued = await createGatewayApiKey({
      deployment: 'cloud',
      keyId: 'gak_infra',
    });
    const cause = new Error('trusted token endpoint unavailable');
    const repository = {
      create: vi.fn(),
      findById: vi.fn(async () => { throw cause; }),
      listByOwner: vi.fn(),
      revoke: vi.fn(),
      touchLastUsed: vi.fn(),
    };
    const authenticator = new GatewayApiKeyAuthenticator({
      repository,
      deployment: 'cloud',
    });

    await expect(authenticator.authenticate(requestWith(issued.plaintext))).resolves.toMatchObject({
      success: false,
      error: 'Gateway API key authentication unavailable',
      cause,
    });
  });
});
