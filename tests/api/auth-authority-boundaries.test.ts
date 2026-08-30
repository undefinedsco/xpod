import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiServer } from '../../src/api/ApiServer';
import { createApiContainer, type ApiContainerConfig } from '../../src/api/container';
import { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';

describe('API auth authority boundaries', () => {
  let server: ApiServer | undefined;
  let container: ReturnType<typeof createApiContainer> | undefined;

  afterEach(async () => {
    await server?.stop();
    await container?.dispose();
    server = undefined;
    container = undefined;
  });

  it('the production API authenticator rejects CSS Account tokens before protected handlers run', async () => {
    const routeHandler = vi.fn();
    const config: ApiContainerConfig = {
      edition: 'local',
      port: 0,
      host: '127.0.0.1',
      authMode: 'acp',
      databaseUrl: ':memory:',
      corsOrigins: ['*'],
      cssTokenEndpoint: 'https://issuer.example/.oidc/token',
      gatewayLocatorSecret: 'auth-boundary-test-locator-secret',
    };
    container = createApiContainer(config);
    const productionAuthenticator = container.resolve('authenticator');

    expect(productionAuthenticator.canAuthenticate({
      headers: { authorization: 'CSS-Account-Token acct-token' },
    } as IncomingMessage)).toBe(false);

    server = new ApiServer({
      port: 0,
      authMiddleware: new AuthMiddleware({
        authenticator: productionAuthenticator,
      }),
    });
    server.get('/api/ai/config', async (_request, response) => {
      routeHandler();
      response.statusCode = 200;
      response.end('ok');
    });
    await server.start();

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('ApiServer did not bind a TCP port');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/api/ai/config`, {
      headers: { Authorization: 'CSS-Account-Token acct-token' },
    });

    expect(response.status).toBe(401);
    expect(routeHandler).not.toHaveBeenCalled();
  });
});
