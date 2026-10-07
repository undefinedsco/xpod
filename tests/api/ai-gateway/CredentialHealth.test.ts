import { describe, expect, it, vi } from 'vitest';
import { PodConnectedCredentialRepository } from '../../../src/api/ai-gateway/connect';
import { classifyProviderStatus } from '../../../src/api/ai-gateway/providers/ProviderRuntimeAdapter';

const webId = 'https://pod.example/alice/profile/card#me';
const credentialId = 'credentials.ttl#key';
const credentialIri = 'https://pod.example/alice/settings/credentials.ttl#key';
const occurredAt = new Date('2026-10-02T00:00:00Z');
function fixture(authMode = 'apiKey') {
  const row: Record<string, any> = {
    id: credentialId, owner: webId, provider: 'https://pod.example/alice/settings/openai.ttl#openai',
    service: 'ai', authMode, status: 'active', keyVersion: '1',
    encryptedSecret: JSON.stringify({ webId, credentialIri, provider: 'openai' }),
    metadata: { health: 'healthy', enabled: true },
  };
  const updateById = vi.fn(async (_resource, id, patch) => {
    expect(id).toBe(credentialId);
    Object.assign(row, patch);
    return row;
  });
  const repository = new PodConnectedCredentialRepository({
    podAccess: { getPodFetch: async () => fetch },
    podBaseUrlResolver: async () => 'https://pod.example/alice/',
    dbFactory: async () => ({ findById: async () => row, updateById }) as any,
  });
  const input = { webId, credentialId, credentialIri, deployment: 'local', provider: 'openai', occurredAt, expectedVersion: 1 };
  return { row, repository, updateById, input };
}

describe('Pod credential failure telemetry', () => {
  it.each([[401, 'authentication'], [402, 'quota_exhausted'], [403, 'authorization'], [429, 'rate_limited'], [503, 'upstream_unavailable']] as const)('persists safe classification for HTTP %s without changing the secret version', async (status, failureCode) => {
    const { row, repository, updateById, input } = fixture();
    const rateLimitResetAt = new Date(occurredAt.getTime() + 60_000);
    await repository.recordFailure({ ...input, status, failureCode: classifyProviderStatus(status), rateLimitResetAt });
    expect(row).toMatchObject({ lastFailureCode: failureCode, lastFailureAt: occurredAt, failCount: 1, keyVersion: '1' });
    expect(row.rateLimitResetAt).toEqual(status === 429 ? rateLimitResetAt : null);
    expect(row.metadata.health).toBe(status === 401 ? 'invalid' : 'healthy');
    expect(updateById.mock.calls[0][2]).not.toHaveProperty('encryptedSecret');
  });
  it('recognizes quota errors carried by a 429 response', () => {
    expect(classifyProviderStatus(429, 'insufficient_quota')).toBe('quota_exhausted');
  });
  it('records expired OAuth login and clears all failure facts on a later success', async () => {
    const { row, repository, input } = fixture('deviceCodeOAuth');
    await repository.recordFailure({ ...input, failureCode: 'authentication' });
    expect(row).toMatchObject({ reauthRequired: true, lastFailureCode: 'login_expired', metadata: { health: 'reauthRequired' } });
    const later = new Date(occurredAt.getTime() + 1000);
    await repository.recordSuccess({ ...input, occurredAt: later });
    expect(row).toMatchObject({ reauthRequired: false, lastFailureCode: null, lastFailureAt: null, rateLimitResetAt: null, failCount: 0, lastUsedAt: later, metadata: { health: 'healthy' } });
  });
  it('ignores stale versions and older events, and only stores known failure codes', async () => {
    const { row, repository, updateById, input } = fixture();
    await repository.recordFailure({ ...input, expectedVersion: 0, failureCode: 'authentication' });
    expect(updateById).not.toHaveBeenCalled();
    await repository.recordFailure({ ...input, failureCode: 'raw sensitive upstream body' });
    expect(row.lastFailureCode).toBe('provider_error');
    await repository.recordSuccess({ ...input, occurredAt: new Date(occurredAt.getTime() - 1000) });
    expect(row.lastFailureCode).toBe('provider_error');
    expect(updateById).toHaveBeenCalledTimes(1);
  });
});
