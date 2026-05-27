import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpHandler, HttpRequest, HttpResponse } from '@solid/community-server';
import { AutoDetectIdentityProviderHandler } from '../../../src/identity/oidc/AutoDetectIdentityProviderHandler';

describe('AutoDetectIdentityProviderHandler', () => {
  let mockResponse: HttpResponse;
  let source: HttpHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResponse = {
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as HttpResponse;
    source = {
      canHandle: vi.fn().mockResolvedValue(undefined),
      handle: vi.fn().mockResolvedValue(undefined),
    } as unknown as HttpHandler;
  });

  const createRequest = (url: string): HttpRequest =>
    ({ url, method: 'GET' } as unknown as HttpRequest);

  it('keeps local account routes enabled when an external issuer is configured', async () => {
    const handler = new AutoDetectIdentityProviderHandler({
      oidcIssuer: 'https://id.undefineds.co/',
      source,
    });
    const input = { request: createRequest('/.account/'), response: mockResponse };

    await expect(handler.canHandle(input)).resolves.toBeUndefined();
    await handler.handle(input);

    expect(source.canHandle).toHaveBeenCalledWith(input);
    expect(source.handle).toHaveBeenCalledWith(input);
    expect(mockResponse.writeHead).not.toHaveBeenCalled();
  });

  it('delegates consent routes to the source handler in Local SP mode', async () => {
    const handler = new AutoDetectIdentityProviderHandler({
      oidcIssuer: 'https://id.undefineds.co/',
      source,
    });
    const input = { request: createRequest('/.account/oidc/consent/'), response: mockResponse };

    await expect(handler.canHandle(input)).resolves.toBeUndefined();
    await handler.handle(input);

    expect(source.canHandle).toHaveBeenCalledWith(input);
    expect(source.handle).toHaveBeenCalledWith(input);
  });

  it('still rejects non-identity routes', async () => {
    const handler = new AutoDetectIdentityProviderHandler({
      oidcIssuer: 'https://id.undefineds.co/',
      source,
    });

    await expect(handler.canHandle({
      request: createRequest('/alice/data.ttl'),
      response: mockResponse,
    })).rejects.toThrow('Not an IdP request');
    expect(source.canHandle).not.toHaveBeenCalled();
  });

  it('fails clearly when no source handler is configured', async () => {
    const handler = new AutoDetectIdentityProviderHandler({
      oidcIssuer: 'https://id.undefineds.co/',
    });

    await expect(handler.canHandle({
      request: createRequest('/.account/'),
      response: mockResponse,
    })).rejects.toThrow('No source IdentityProviderHandler configured');
  });
});
