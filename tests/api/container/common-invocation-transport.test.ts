import { asValue } from 'awilix';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiGatewayService } from '../../../src/api/ai-gateway/AiGatewayService';
import { createApiContainer } from '../../../src/api/container';

const publicOrigin = 'https://unrouted-node.example';
const owner = 'https://id.example/profile/card#me';

afterEach(() => { vi.unstubAllEnvs(); });

describe('runtime AI Gateway transport binding', () => {
  it('keeps remotely issued configurations and token claims canonical despite an internal Gateway binding', async () => {
    vi.stubEnv('XPOD_API_KEY', '');
    vi.stubEnv('XPOD_MAIN_PORT', '34567');
    const container = createApiContainer({
      edition: 'local', port: 3001, host: '127.0.0.1', authMode: 'acp',
      databaseUrl: 'sqlite::memory:', corsOrigins: ['*'],
      publicUrl: publicOrigin, solidBaseUrl: publicOrigin, cssTokenEndpoint: `${publicOrigin}/.oidc/token`,
    });
    container.register({ aiGatewayService: asValue({ listModels: async () => [{ id: 'selected-model' }] } as unknown as AiGatewayService) });
    try {
      const issuer = container.resolve('aiConnectionInvocationKeyIssuer')!;
      const context = { auth: { type: 'solid' as const, webId: owner, accountId: 'owner' } };
      const config = await issuer.issue(context);
      expect(config.baseUrl).toBe(`${publicOrigin}/v1`);
      const client = await issuer.issueClientConfiguration(context);
      expect(client.baseUrl).toBe(`${publicOrigin}/v1`);
      expect(config.model).toBe('selected-model');
      const claims = container.resolve('invocationTokenCodec')!.decode(config.apiKey);
      expect(claims?.audience).toBe(publicOrigin);
      expect(claims?.issuer).toBe(publicOrigin);
    } finally {
      await container.dispose();
    }
  });

  it('keeps the runtime-mapped canonical origin in socket mode', async () => {
    vi.stubEnv('XPOD_API_KEY', '');
    vi.stubEnv('XPOD_MAIN_PORT', '');
    const container = createApiContainer({
      edition: 'local', port: 3001, host: '127.0.0.1', authMode: 'acp',
      databaseUrl: 'sqlite::memory:', corsOrigins: ['*'],
      publicUrl: publicOrigin, solidBaseUrl: publicOrigin, cssTokenEndpoint: `${publicOrigin}/.oidc/token`,
    });
    try {
      const config = await container.resolve('aiConnectionInvocationKeyIssuer')!.issueClientConfiguration({
        auth: { type: 'solid', webId: owner, accountId: 'owner' },
      });
      expect(config.baseUrl).toBe(`${publicOrigin}/v1`);
    } finally {
      await container.dispose();
    }
  });
});
