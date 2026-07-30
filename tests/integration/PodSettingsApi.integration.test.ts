import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiServer } from '../../src/api/ApiServer';
import { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';
import { registerPodSettingsRoutes } from '../../src/api/handlers/PodSettingsHandler';
import type { Authenticator } from '../../src/api/auth/Authenticator';

const WEB_ID = 'https://pod.example/alice/profile/card#me';

describe('Pod settings API integration', () => {
  let server: ApiServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('isolates status lookup to the authenticated WebID through the real API server auth path', async () => {
    const podLookupRepository = {
      findByWebId: vi.fn(async (webId: string) => ({
        podId: `pod-for-${new URL(webId).pathname.split('/')[1]}`,
        accountId: 'acc-alice',
        baseUrl: 'https://pod.example/alice/',
        storageUrl: 'https://pod.example/alice/',
        webId,
      })),
    };
    const usageRepo = {
      getPodUsage: vi.fn(async () => ({
        podId: 'pod-alice',
        accountId: 'acc-alice',
        storageBytes: 2048,
        ingressBytes: 0,
        egressBytes: 0,
        storageLimitBytes: null,
        bandwidthLimitBps: null,
        computeSeconds: 0,
        tokensUsed: 0,
      })),
    };
    const authenticator: Authenticator = {
      canAuthenticate: () => true,
      authenticate: async (request) => ({
        success: request.headers.authorization === 'Bearer alice-token',
        context: { type: 'solid', webId: WEB_ID },
      }),
    };
    server = new ApiServer({
      port: 0,
      authMiddleware: new AuthMiddleware({ authenticator }),
    });
    registerPodSettingsRoutes(server, {
      podLookupRepository,
      usageRepo,
      aiConnectionStatusReader: {
        read: vi.fn(async () => ({ status: 'unsupported', reason: 'not_configured' })),
      },
    });
    await server.start();

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('ApiServer did not bind a TCP port');
    }
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/pod/settings/status?webId=https%3A%2F%2Fpod.example%2Fbob%2Fprofile%2Fcard%23me`,
      { headers: { authorization: 'Bearer alice-token' } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      identity: { webId: WEB_ID, podUrl: 'https://pod.example/alice/' },
      storage: { status: 'available' },
    });
    expect(podLookupRepository.findByWebId).toHaveBeenCalledWith(WEB_ID);
    expect(JSON.stringify(podLookupRepository.findByWebId.mock.calls)).not.toContain('bob');
  });
});
