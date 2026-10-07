import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthMiddleware, type AuthenticatedRequest } from '../../src/api/middleware/AuthMiddleware';
import type { Authenticator } from '../../src/api/auth/Authenticator';

function createRequest(): AuthenticatedRequest {
  const req = new PassThrough() as PassThrough & AuthenticatedRequest;
  req.method = 'GET';
  req.url = '/v1/secure';
  req.headers = { authorization: 'Bearer redacted-input' };
  req.end();
  return req;
}

function createResponse(): any {
  return {
    statusCode: 0,
    setHeader: vi.fn(),
    end: vi.fn(),
  };
}

describe('AuthMiddleware logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not write auth secrets or access tokens to stdout', async () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const authenticator: Authenticator = {
      canAuthenticate: () => true,
      authenticate: async () => ({
        success: true,
        context: {
          type: 'solid',
          webId: 'https://id.example/alice/profile/card#me',
          accountId: 'https://id.example/alice/profile/card#me',
          clientId: 'client-id',
          clientSecret: 'super-secret-client-secret',
          accessToken: 'super-secret-access-token',
          tokenType: 'Bearer',
        } as any,
      }),
    };

    const middleware = new AuthMiddleware({ authenticator });

    await expect(middleware.process(createRequest(), createResponse())).resolves.toBe(true);

    expect(stdout).not.toHaveBeenCalled();
  });

  it('returns 401 for invalid credentials and 503 for authentication infrastructure failures', async () => {
    const invalidResponse = createResponse();
    const invalid = new AuthMiddleware({
      authenticator: {
        canAuthenticate: () => true,
        authenticate: async () => ({
          success: false,
          error: 'Invalid gateway API key',
          category: 'invalid_credentials',
          statusCode: 401,
        }),
      },
    });

    await expect(invalid.process(createRequest(), invalidResponse)).resolves.toBe(false);
    expect(invalidResponse.statusCode).toBe(401);
    expect(JSON.parse(invalidResponse.end.mock.calls[0][0])).toEqual({
      error: 'Unauthorized',
      message: 'Invalid gateway API key',
    });

    const cause = new Error('pod token endpoint down');
    const unavailableResponse = createResponse();
    const unavailable = new AuthMiddleware({
      authenticator: {
        canAuthenticate: () => true,
        authenticate: async () => ({
          success: false,
          error: 'Gateway API key authentication unavailable',
          category: 'service_unavailable',
          statusCode: 503,
          cause,
        }),
      },
    });

    await expect(unavailable.process(createRequest(), unavailableResponse)).resolves.toBe(false);
    expect(unavailableResponse.statusCode).toBe(503);
    expect(JSON.parse(unavailableResponse.end.mock.calls[0][0])).toEqual({
      error: 'Service Unavailable',
      message: 'Authentication service unavailable',
    });
    expect(unavailableResponse.end.mock.calls[0][0]).not.toContain('pod token endpoint down');
  });
  it('carries only an untrusted hint without mutating the authenticator context', async () => {
    const context = { type: 'solid' as const, webId: 'https://identity.example/alice/profile/card#me' };
    const middleware = new AuthMiddleware({ authenticator: {
      canAuthenticate: () => true, authenticate: async () => ({ success: true, context }),
    } });
    const request = createRequest();
    request.headers['x-xpod-pod-url'] = 'https://storage.example/alice/';
    expect(await middleware.process(request, createResponse())).toBe(true);
    expect(request.auth).toEqual({ ...context, requestedPodUrl: 'https://storage.example/alice/' });
    expect(context).not.toHaveProperty('requestedPodUrl');
    expect(request.auth).not.toHaveProperty('authorizedPodUrl');
  });

  it.each([
    { selection: ['https://storage.example/alice/', 'https://storage.example/bob/'] },
    { selection: 'https://storage.example/alice/#me' },
    { selection: 'https://storage.example/../alice/' },
    { selection: 'ftp://storage.example/alice/' },
  ])('rejects invalid selection headers without exposing them', async ({ selection }) => {
    const middleware = new AuthMiddleware({ authenticator: {
      canAuthenticate: () => true,
      authenticate: async () => ({ success: true, context: { type: 'solid', webId: 'https://identity.example/alice/profile/card#me' } }),
    } });
    const request = createRequest();
    request.headers['x-xpod-pod-url'] = selection;
    const response = createResponse();
    expect(await middleware.process(request, response)).toBe(false);
    expect(response.statusCode).toBe(400);
    expect(response.end.mock.calls[0][0]).not.toContain('storage.example');
  });

  it('requests a new scoped invocation for legacy constrained credentials when selecting a Pod', async () => {
    const middleware = new AuthMiddleware({ authenticator: {
      canAuthenticate: () => true,
      authenticate: async () => ({ success: true, context: {
        type: 'solid', webId: 'https://identity.example/alice/profile/card#me', internalInvocation: true,
      } }),
    } });
    const request = createRequest();
    request.headers['x-xpod-pod-url'] = 'https://storage.example/alice/';
    const response = createResponse();
    expect(await middleware.process(request, response)).toBe(false);
    expect(response.statusCode).toBe(401);
    expect(request.auth).toBeUndefined();
    const legacyWithoutHint = createRequest();
    expect(await middleware.process(legacyWithoutHint, createResponse())).toBe(true);
  });

});
