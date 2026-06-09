import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, HttpResponse } from '@solid/community-server';
import { AutoDetectOidcHandler } from '../../../src/identity/oidc/AutoDetectOidcHandler';

describe('AutoDetectOidcHandler', () => {
  let mockResponse: HttpResponse;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResponse = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn(),
    } as unknown as HttpResponse;
  });

  const createRequest = (url: string): HttpRequest =>
    ({ url, method: 'GET' } as unknown as HttpRequest);

  it('passes local JWKS through to the CSS OIDC handler in Local SP mode', async () => {
    const handler = new AutoDetectOidcHandler({
      oidcIssuer: 'https://id.undefineds.co/',
    });

    await expect(handler.canHandle({
      request: createRequest('/.oidc/jwks'),
      response: mockResponse,
    })).rejects.toThrow('OIDC route handled by local CSS OIDC handler');

    expect(mockResponse.setHeader).not.toHaveBeenCalled();
    expect(mockResponse.end).not.toHaveBeenCalled();
  });

  it('passes local token and discovery routes through to the CSS OIDC handler', async () => {
    const handler = new AutoDetectOidcHandler({
      oidcIssuer: 'https://id.undefineds.co/',
    });

    await expect(handler.canHandle({
      request: createRequest('/.oidc/token'),
      response: mockResponse,
    })).rejects.toThrow('OIDC route handled by local CSS OIDC handler');
    await expect(handler.canHandle({
      request: createRequest('/.well-known/openid-configuration'),
      response: mockResponse,
    })).rejects.toThrow('OIDC route handled by local CSS OIDC handler');
  });

  it('still rejects non-OIDC requests', async () => {
    const handler = new AutoDetectOidcHandler({
      oidcIssuer: 'https://id.undefineds.co/',
    });

    await expect(handler.canHandle({
      request: createRequest('/alice/data.ttl'),
      response: mockResponse,
    })).rejects.toThrow('Not an OIDC request');
  });
});
