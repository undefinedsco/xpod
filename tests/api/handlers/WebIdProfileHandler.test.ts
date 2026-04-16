import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiServer } from '../../../src/api/ApiServer';
import { registerWebIdProfileRoutes } from '../../../src/api/handlers/WebIdProfileHandler';

describe('WebIdProfileHandler', () => {
  let mockServer: ApiServer;
  let routes: Record<string, Function> = {};
  const profileRepo = {
    get: vi.fn(),
    updateStorage: vi.fn(),
    generateProfileTurtle: vi.fn(),
    create: vi.fn(),
  };
  const podLookupRepo = {
    listByAccountId: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    routes = {};
    mockServer = {
      get: vi.fn((path, handler) => { routes[`GET ${path}`] = handler; }),
      post: vi.fn((path, handler) => { routes[`POST ${path}`] = handler; }),
    } as unknown as ApiServer;

    registerWebIdProfileRoutes(mockServer, {
      profileRepo: profileRepo as any,
      podLookupRepo: podLookupRepo as any,
    });
  });

  function createResponse(): ServerResponse {
    return {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;
  }

  it('backfills missing solid:storage from the owned pod before returning turtle', async () => {
    profileRepo.get.mockResolvedValueOnce({
      username: 'alice',
      webidUrl: 'https://id.example/alice/profile/card#me',
      storageUrl: undefined,
      storageMode: 'cloud',
      oidcIssuer: 'https://id.example',
      profileData: { 'solid:oidcIssuer': { '@id': 'https://id.example' } },
      accountId: 'acc-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    podLookupRepo.listByAccountId.mockResolvedValueOnce([
      {
        podId: 'pod-1',
        accountId: 'acc-1',
        baseUrl: 'https://node-1.nodes.example/alice',
      },
    ]);
    profileRepo.updateStorage.mockResolvedValueOnce({
      username: 'alice',
      webidUrl: 'https://id.example/alice/profile/card#me',
      storageUrl: 'https://node-1.nodes.example/alice/',
      storageMode: 'cloud',
      oidcIssuer: 'https://id.example',
      profileData: { 'solid:storage': { '@id': 'https://node-1.nodes.example/alice/' } },
      accountId: 'acc-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    });
    profileRepo.generateProfileTurtle.mockReturnValue('TURTLE');

    const response = createResponse();
    await routes['GET /:username/profile/card']({} as IncomingMessage, response, { username: 'alice' });

    expect(podLookupRepo.listByAccountId).toHaveBeenCalledWith('acc-1');
    expect(profileRepo.updateStorage).toHaveBeenCalledWith('alice', {
      storageUrl: 'https://node-1.nodes.example/alice/',
      storageMode: 'cloud',
    });
    expect(profileRepo.generateProfileTurtle).toHaveBeenCalledWith(expect.objectContaining({
      storageUrl: 'https://node-1.nodes.example/alice/',
    }));
    expect(response.statusCode).toBe(200);
  });

  it('does not backfill when multiple pods make the account ambiguous', async () => {
    profileRepo.get.mockResolvedValueOnce({
      username: 'alice',
      webidUrl: 'https://id.example/alice/profile/card#me',
      storageUrl: undefined,
      storageMode: 'cloud',
      oidcIssuer: 'https://id.example',
      profileData: { 'solid:oidcIssuer': { '@id': 'https://id.example' } },
      accountId: 'acc-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    podLookupRepo.listByAccountId.mockResolvedValueOnce([
      {
        podId: 'pod-1',
        accountId: 'acc-1',
        baseUrl: 'https://node-1.nodes.example/one/',
      },
      {
        podId: 'pod-2',
        accountId: 'acc-1',
        baseUrl: 'https://node-1.nodes.example/two/',
      },
    ]);

    const response = createResponse();
    await routes['GET /api/v1/identity/:username']({} as IncomingMessage, response, { username: 'alice' });

    expect(profileRepo.updateStorage).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(200);
    const body = JSON.parse((response.end as any).mock.calls[0][0]);
    expect(body.storageUrl).toBeUndefined();
  });
});
