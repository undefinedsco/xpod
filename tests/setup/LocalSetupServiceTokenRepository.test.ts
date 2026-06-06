import { describe, expect, it } from 'vitest';
import { LocalSetupServiceTokenRepository } from '../../src/setup/LocalSetupServiceTokenRepository';

describe('LocalSetupServiceTokenRepository', () => {
  it('verifies the token supplied by local setup without persistent tables', async () => {
    const repo = new LocalSetupServiceTokenRepository({
      token: 'svc-local-secret',
      serviceType: 'local',
      serviceId: 'node-local',
      scopes: ['quota:write'],
    });

    await expect(repo.verifyToken('wrong')).resolves.toBeUndefined();

    const record = await repo.verifyToken('svc-local-secret');
    expect(record).toMatchObject({
      serviceType: 'local',
      serviceId: 'node-local',
      scopes: ['quota:write'],
    });
  });
});
