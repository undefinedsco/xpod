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
});
