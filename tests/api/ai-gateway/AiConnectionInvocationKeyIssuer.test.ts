import { describe, expect, it } from 'vitest';
import { AiConnectionInvocationKeyIssuer } from '../../../src/api/ai-gateway/auth/AiConnectionInvocationKeyIssuer';
import { GatewayApiKeyAuthenticator, type GatewayAccessKeyRecord } from '../../../src/api/ai-gateway/auth/GatewayApiKeyAuthenticator';

describe('AiConnectionInvocationKeyIssuer', () => {
  it('issues a short-lived minimal-scope key authenticating as the current WebID without storing plaintext', async () => {
    const records = new Map<string, GatewayAccessKeyRecord>();
    const repository = {
      create: async (record: GatewayAccessKeyRecord) => {
        records.set(record.id, record);
        return record;
      },
      findById: async (id: string) => records.get(id),
      listByOwner: async () => [...records.values()],
      revoke: async () => undefined,
      touchLastUsed: async () => undefined,
    };
    const now = new Date('2026-07-24T00:00:00.000Z');
    const issuer = new AiConnectionInvocationKeyIssuer({
      repository,
      deployment: 'local',
      baseUrl: 'http://127.0.0.1:3000/v1',
      ttlMs: 5 * 60_000,
      now: () => now,
    });

    const connection = await issuer.issue({
      auth: {
        type: 'solid',
        webId: 'https://pod.example/alice/profile/card#me',
      },
    });

    expect(connection.baseUrl).toBe('http://127.0.0.1:3000/v1');
    expect(connection.gatewayKey).toMatch(/^xpod_gw_v1_local_/);
    expect(records.size).toBe(1);
    const record = [...records.values()][0];
    expect(record.owner).toBe('https://pod.example/alice/profile/card#me');
    expect(record.scopes).toEqual(['models:read', 'inference:write']);
    expect(record.expiresAt?.toISOString()).toBe('2026-07-24T00:05:00.000Z');
    expect(JSON.stringify(record)).not.toContain(connection.gatewayKey);

    const authenticator = new GatewayApiKeyAuthenticator({
      repository,
      deployment: 'local',
      now: () => now,
    });
    const authenticated = await authenticator.authenticate({
      headers: { authorization: `Bearer ${connection.gatewayKey}` },
    } as any);
    expect(authenticated).toMatchObject({
      success: true,
      context: {
        type: 'solid',
        webId: 'https://pod.example/alice/profile/card#me',
        viaGatewayApiKey: true,
        scopes: ['models:read', 'inference:write'],
      },
    });
  });

  it('fails closed without a trusted authenticated Solid WebID', async () => {
    const issuer = new AiConnectionInvocationKeyIssuer({
      repository: {
        create: async (record) => record,
        findById: async () => undefined,
        listByOwner: async () => [],
        revoke: async () => undefined,
        touchLastUsed: async () => undefined,
      },
      deployment: 'cloud',
      baseUrl: 'https://api.example/v1',
    });

    await expect(issuer.issue({ userId: 'anonymous' })).rejects.toThrow(/authenticated Solid WebID/);
  });
});
