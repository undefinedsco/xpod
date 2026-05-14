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
    listAllPods: vi.fn(),
    findByWebId: vi.fn(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
    podLookupRepo.listAllPods.mockResolvedValue([]);
    podLookupRepo.findByWebId.mockResolvedValue(undefined);
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

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it('returns 404 for an available username when the optional profile table is unavailable', async () => {
    profileRepo.get.mockRejectedValueOnce(new Error('relation "identity_webid_profile" does not exist'));
    podLookupRepo.listAllPods.mockResolvedValueOnce([]);

    const response = createResponse();
    await routes['GET /api/v1/identity/:username']({} as IncomingMessage, response, { username: 'new-user' });

    expect(response.statusCode).toBe(404);
    expect(podLookupRepo.listAllPods).toHaveBeenCalledTimes(1);
    const body = JSON.parse((response.end as any).mock.calls[0][0]);
    expect(body.error).toBe('Profile not found');
  });

  it('treats an existing CSS pod slug as an occupied username without requiring a profile row', async () => {
    profileRepo.get.mockRejectedValueOnce(new Error('relation "identity_webid_profile" does not exist'));
    podLookupRepo.listAllPods.mockResolvedValueOnce([
      {
        podId: 'pod-1',
        accountId: 'acc-1',
        baseUrl: 'https://id.example/alice/',
      },
    ]);

    const response = createResponse();
    await routes['GET /api/v1/identity/:username']({} as IncomingMessage, response, { username: 'alice' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse((response.end as any).mock.calls[0][0]);
    expect(body).toEqual(expect.objectContaining({
      username: 'alice',
      webidUrl: 'https://id.example/alice/profile/card#me',
      storageUrl: 'https://id.example/alice/',
    }));
  });

  it('serves hosted WebID turtle from the WebID index when storage lives on another origin', async () => {
    const previousBaseUrl = process.env.CSS_BASE_URL;
    process.env.CSS_BASE_URL = 'https://id.example/';
    try {
      profileRepo.get.mockRejectedValueOnce(new Error('relation "identity_webid_profile" does not exist'));
      profileRepo.generateProfileTurtle.mockReturnValue('TURTLE');
      podLookupRepo.findByWebId.mockResolvedValueOnce({
        podId: 'pod-1',
        accountId: 'acc-1',
        baseUrl: 'https://node-1.nodes.example/alice/',
        webId: 'https://id.example/alice/profile/card#me',
      });

      const response = createResponse();
      await routes['GET /:username/profile/card']({} as IncomingMessage, response, { username: 'alice' });

      expect(response.statusCode).toBe(200);
      expect(podLookupRepo.findByWebId).toHaveBeenCalledWith('https://id.example/alice/profile/card#me');
      expect(profileRepo.generateProfileTurtle).toHaveBeenCalledWith(expect.objectContaining({
        username: 'alice',
        webidUrl: 'https://id.example/alice/profile/card#me',
        storageUrl: 'https://node-1.nodes.example/alice/',
        oidcIssuer: 'https://id.example/',
      }));
    } finally {
      if (previousBaseUrl === undefined) {
        delete process.env.CSS_BASE_URL;
      } else {
        process.env.CSS_BASE_URL = previousBaseUrl;
      }
    }
  });

  it('serves WebID turtle from the Pod index when the optional profile table is unavailable', async () => {
    profileRepo.get.mockRejectedValueOnce(new Error('relation "identity_webid_profile" does not exist'));
    profileRepo.generateProfileTurtle.mockReturnValue('TURTLE');
    podLookupRepo.listAllPods.mockResolvedValueOnce([
      {
        podId: 'pod-1',
        accountId: 'acc-1',
        baseUrl: 'https://id.example/alice/',
      },
    ]);

    const response = createResponse();
    await routes['GET /:username/profile/card']({} as IncomingMessage, response, { username: 'alice' });

    expect(response.statusCode).toBe(200);
    expect(profileRepo.generateProfileTurtle).toHaveBeenCalledWith(expect.objectContaining({
      username: 'alice',
      webidUrl: 'https://id.example/alice/profile/card#me',
      storageUrl: 'https://id.example/alice/',
    }));
  });

  it('ignores relative BASE_URL values when building hosted WebID URLs', async () => {
    const previousBaseUrl = process.env.BASE_URL;
    const previousCssBaseUrl = process.env.CSS_BASE_URL;
    process.env.BASE_URL = '/';
    delete process.env.CSS_BASE_URL;

    try {
      profileRepo.get.mockRejectedValueOnce(new Error('relation "identity_webid_profile" does not exist'));
      profileRepo.generateProfileTurtle.mockReturnValue('TURTLE');
      podLookupRepo.findByWebId.mockResolvedValueOnce({
        podId: 'pod-1',
        accountId: 'acc-1',
        baseUrl: 'https://node-1.nodes.example/alice/',
        webId: 'http://localhost:3000/alice/profile/card#me',
      });

      const response = createResponse();
      await routes['GET /:username/profile/card']({} as IncomingMessage, response, { username: 'alice' });

      expect(response.statusCode).toBe(200);
      expect(podLookupRepo.findByWebId).toHaveBeenCalledWith('http://localhost:3000/alice/profile/card#me');
      expect(profileRepo.generateProfileTurtle).toHaveBeenCalledWith(expect.objectContaining({
        username: 'alice',
        webidUrl: 'http://localhost:3000/alice/profile/card#me',
        storageUrl: 'https://node-1.nodes.example/alice/',
      }));
    } finally {
      if (previousBaseUrl === undefined) {
        delete process.env.BASE_URL;
      } else {
        process.env.BASE_URL = previousBaseUrl;
      }
      if (previousCssBaseUrl === undefined) {
        delete process.env.CSS_BASE_URL;
      } else {
        process.env.CSS_BASE_URL = previousCssBaseUrl;
      }
    }
  });

  it('serves a hosted WebID profile from the request origin when the storage root exists but account indexes are stale', async () => {
    const previousBaseUrl = process.env.CSS_BASE_URL;
    process.env.CSS_BASE_URL = 'https://internal.example/';
    try {
      profileRepo.get.mockRejectedValueOnce(new Error('relation "identity_webid_profile" does not exist'));
      profileRepo.generateProfileTurtle.mockReturnValue('TURTLE');
      podLookupRepo.findByWebId.mockResolvedValueOnce(undefined);
      podLookupRepo.listAllPods.mockResolvedValueOnce([]);
      const fetchMock = vi.fn().mockResolvedValue({ status: 401 });
      vi.stubGlobal('fetch', fetchMock);

      const response = createResponse();
      await routes['GET /:username/profile/card']({
        headers: {
          host: 'id.example',
          'x-forwarded-proto': 'https',
        },
      } as unknown as IncomingMessage, response, { username: 'alice' });

      expect(response.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith('https://id.example/alice/', expect.objectContaining({
        method: 'HEAD',
      }));
      expect(profileRepo.generateProfileTurtle).toHaveBeenCalledWith(expect.objectContaining({
        username: 'alice',
        webidUrl: 'https://id.example/alice/profile/card#me',
        storageUrl: 'https://id.example/alice/',
      }));
    } finally {
      if (previousBaseUrl === undefined) {
        delete process.env.CSS_BASE_URL;
      } else {
        process.env.CSS_BASE_URL = previousBaseUrl;
      }
    }
  });
});
