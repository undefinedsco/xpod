import { IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  createGatewayApiKey,
  type GatewayDeployment,
} from '../../../src/api/ai-gateway/auth/GatewayApiKey';
import {
  GatewayApiKeyAuthenticator,
  type GatewayAccessKeyRecord,
  type GatewayAccessKeyRepository,
} from '../../../src/api/ai-gateway/auth/GatewayApiKeyAuthenticator';
import { canManageGatewayKeys } from '../../../src/api/ai-gateway/auth/GatewayPrincipal';

describe('GatewayApiKeyAuthenticator', () => {
  it('authenticates active Gateway API keys and touches usage', async () => {
    const issued = await createGatewayApiKey({
      deployment: 'local',
      keyId: 'gak_test',
      secret: 'secret',
    });
    const record: GatewayAccessKeyRecord = {
      id: issued.record.id,
      owner: 'https://pod.example/alice/profile/card#me',
      secretHash: issued.record.secretHash,
      deployment: 'local',
      scopes: ['models:read', 'inference:write'],
      createdAt: new Date('2026-08-25T00:00:00.000Z'),
    };
    const repository = memoryGatewayRepository(record);
    const authenticator = new GatewayApiKeyAuthenticator({
      repository,
      deployment: 'local',
      now: () => new Date('2026-08-25T01:00:00.000Z'),
    });

    const result = await authenticator.authenticate(bearerRequest(issued.plaintext));

    expect(result.success).toBe(true);
    if (!result.context || result.context.type !== 'solid') {
      throw new Error('Expected Gateway API key authentication to return a Solid auth context.');
    }
    expect(result.context.webId).toBe(record.owner);
    expect(result.context).toMatchObject({
      viaGatewayApiKey: true,
      gatewayRuntimeAccess: true,
      gatewayKeyId: record.id,
      scopes: ['models:read', 'inference:write'],
    });
    expect(canManageGatewayKeys(result.context)).toBe(false);
    expect(repository.touchLastUsed).toHaveBeenCalledWith(
      record.id,
      new Date('2026-08-25T01:00:00.000Z'),
      expect.objectContaining({ internalPodAccess: { reason: 'gateway-key-verifier' } }),
    );
  });

  it('rejects disabled keys', async () => {
    const issued = await createGatewayApiKey({
      deployment: 'local',
      keyId: 'gak_disabled',
      secret: 'secret',
    });
    const authenticator = new GatewayApiKeyAuthenticator({
      repository: memoryGatewayRepository({
        id: issued.record.id,
        owner: 'https://pod.example/alice/profile/card#me',
        secretHash: issued.record.secretHash,
        deployment: 'local',
        scopes: ['models:read', 'inference:write'],
        createdAt: new Date('2026-08-25T00:00:00.000Z'),
        disabledAt: new Date('2026-08-25T00:10:00.000Z'),
      }),
      deployment: 'local',
    });

    const result = await authenticator.authenticate(bearerRequest(issued.plaintext));

    expect(result).toMatchObject({
      success: false,
      statusCode: 401,
      category: 'invalid_credentials',
    });
    expect(result).not.toHaveProperty('context');
  });

  it.each([
    ['expired', 'gak_expired', { expiresAt: new Date('2026-08-24T23:59:59.000Z') }],
    ['wrong scope', 'gak_wrong_scope', { scopes: ['models:read'] }],
    ['revoked', 'gak_revoked', { revokedAt: new Date('2026-08-25T00:10:00.000Z') }],
    ['wrong deployment', 'gak_wrong_deployment', { deployment: 'cloud' as const }],
  ])('does not grant gateway runtime access to %s keys', async (_label, keyId, patch) => {
    const issued = await createGatewayApiKey({
      deployment: 'local',
      keyId,
      secret: 'secret',
    });
    const authenticator = new GatewayApiKeyAuthenticator({
      repository: memoryGatewayRepository({
        id: issued.record.id,
        owner: 'https://pod.example/alice/profile/card#me',
        secretHash: issued.record.secretHash,
        deployment: 'local',
        scopes: ['models:read', 'inference:write'],
        createdAt: new Date('2026-08-25T00:00:00.000Z'),
        ...patch,
      }),
      deployment: 'local',
      now: () => new Date('2026-08-25T01:00:00.000Z'),
    });

    const result = await authenticator.authenticate(bearerRequest(issued.plaintext));

    expect(result).toMatchObject({
      success: false,
      statusCode: 401,
      category: 'invalid_credentials',
    });
    expect(result).not.toHaveProperty('context');
  });

  it.each(['wrong secret', 'missing key'] as const)(
    'does not grant runtime access or update usage for a %s',
    async (failure) => {
      const issued = await createGatewayApiKey({
        deployment: 'local',
        keyId: 'gak_invalid',
        secret: 'secret',
      });
      const repository = memoryGatewayRepository({
        id: failure === 'missing key' ? 'gak_other' : issued.record.id,
        owner: 'https://pod.example/alice/profile/card#me',
        secretHash: issued.record.secretHash,
        deployment: 'local',
        scopes: ['models:read', 'inference:write'],
        createdAt: new Date('2026-08-25T00:00:00.000Z'),
      });
      const authenticator = new GatewayApiKeyAuthenticator({ repository, deployment: 'local' });
      const bearer = failure === 'wrong secret' ? `${issued.plaintext}tampered` : issued.plaintext;

      const result = await authenticator.authenticate(bearerRequest(bearer));

      expect(result).toMatchObject({ success: false, statusCode: 401, category: 'invalid_credentials' });
      expect(result).not.toHaveProperty('context');
      expect(repository.touchLastUsed).not.toHaveBeenCalled();
    },
  );
});

function memoryGatewayRepository(record: GatewayAccessKeyRecord): GatewayAccessKeyRepository {
  return {
    createKeyId: vi.fn((_owner: string, _deployment: GatewayDeployment) => record.id),
    create: vi.fn(async () => record),
    findById: vi.fn(async (id: string) => id === record.id ? record : undefined),
    listByOwner: vi.fn(async () => [record]),
    setEnabled: vi.fn(async () => record),
    revoke: vi.fn(async () => record),
    delete: vi.fn(async () => true),
    revealPlaintext: vi.fn(async () => undefined),
    touchLastUsed: vi.fn(async () => {}),
  };
}

function bearerRequest(token: string): IncomingMessage {
  return {
    headers: {
      authorization: `Bearer ${token}`,
    },
  } as IncomingMessage;
}
