import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthMiddleware, type AuthenticatedRequest } from '../../src/api/middleware/AuthMiddleware';
import type { Authenticator } from '../../src/api/auth/Authenticator';

function createRequest(): AuthenticatedRequest {
  const req = new PassThrough() as unknown as AuthenticatedRequest;
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
});
