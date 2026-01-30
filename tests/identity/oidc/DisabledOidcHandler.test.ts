import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DisabledOidcHandler } from '../../../src/identity/oidc/DisabledOidcHandler';
import type { HttpResponse } from '@solid/community-server';
import type { IncomingMessage } from 'node:http';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('DisabledOidcHandler', () => {
  let handler: DisabledOidcHandler;
  let mockResponse: HttpResponse;
  let responseData: string;

  beforeEach(() => {
    vi.clearAllMocks();
    responseData = '';

    // Simple mock response
    mockResponse = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn((data: string) => {
        responseData = data;
      }),
    } as unknown as HttpResponse;
  });

  describe('canHandle', () => {
    const createRequest = (url: string): IncomingMessage =>
      ({ url } as IncomingMessage);

    it('should accept /.oidc/jwks requests', async () => {
      handler = new DisabledOidcHandler({
        externalJwksUrl: 'https://id.example.com/.oidc/jwks'
      });

      const request = createRequest('/.oidc/jwks');
      await expect(handler.canHandle({ request, response: mockResponse })).resolves.toBeUndefined();
    });

    it('should reject other OIDC paths', async () => {
      handler = new DisabledOidcHandler({
        externalJwksUrl: 'https://id.example.com/.oidc/jwks'
      });

      const request = createRequest('/.oidc/auth');
      await expect(handler.canHandle({ request, response: mockResponse })).rejects.toThrow('External IdP mode');
    });

    it('should reject openid-configuration', async () => {
      handler = new DisabledOidcHandler({
        externalJwksUrl: 'https://id.example.com/.oidc/jwks'
      });

      const request = createRequest('/.well-known/openid-configuration');
      await expect(handler.canHandle({ request, response: mockResponse })).rejects.toThrow('External IdP mode');
    });

    it('should reject non-OIDC paths', async () => {
      handler = new DisabledOidcHandler({});

      const request = createRequest('/alice/data.ttl');
      await expect(handler.canHandle({ request, response: mockResponse })).rejects.toThrow('Not an OIDC request');
    });

    it('should reject all OIDC in fullyDisabled mode', async () => {
      handler = new DisabledOidcHandler({
        fullyDisabled: true,
        message: 'OIDC completely disabled'
      });

      const request = createRequest('/.oidc/jwks');
      await expect(handler.canHandle({ request, response: mockResponse })).rejects.toThrow('OIDC completely disabled');
    });

    it('should throw if JWKS URL not configured', async () => {
      handler = new DisabledOidcHandler({});

      const request = createRequest('/.oidc/jwks');
      await expect(handler.canHandle({ request, response: mockResponse })).rejects.toThrow('JWKS proxy not configured');
    });
  });

  describe('handle', () => {
    const mockJwks = {
      keys: [
        { kty: 'RSA', kid: 'key1', use: 'sig' },
        { kty: 'RSA', kid: 'key2', use: 'sig' }
      ]
    };

    const createRequest = (url: string): IncomingMessage =>
      ({ url } as IncomingMessage);

    beforeEach(() => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(mockJwks)
      });
    });

    it('should proxy JWKS successfully', async () => {
      handler = new DisabledOidcHandler({
        externalJwksUrl: 'https://id.example.com/.oidc/jwks',
        cacheMs: 60000
      });

      const request = createRequest('/.oidc/jwks');
      await handler.canHandle({ request, response: mockResponse });
      await handler.handle({ request, response: mockResponse });

      expect(mockResponse.statusCode).toBe(200);
      expect(mockResponse.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
      expect(mockResponse.setHeader).toHaveBeenCalledWith('Cache-Control', 'public, max-age=60');

      const parsedData = JSON.parse(responseData);
      expect(parsedData.keys).toHaveLength(2);
      expect(parsedData.keys[0].kid).toBe('key1');
    });

    it('should cache JWKS responses', async () => {
      handler = new DisabledOidcHandler({
        externalJwksUrl: 'https://id.example.com/.oidc/jwks',
        cacheMs: 60000
      });

      const request = createRequest('/.oidc/jwks');

      // First request
      await handler.canHandle({ request, response: mockResponse });
      await handler.handle({ request, response: mockResponse });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second request should use cache
      await handler.handle({ request, response: mockResponse });
      expect(mockFetch).toHaveBeenCalledTimes(1); // Still 1, not 2
    });

    it('should refetch after cache expires', async () => {
      handler = new DisabledOidcHandler({
        externalJwksUrl: 'https://id.example.com/.oidc/jwks',
        cacheMs: 0 // Immediate expiration
      });

      const request = createRequest('/.oidc/jwks');

      await handler.canHandle({ request, response: mockResponse });
      await handler.handle({ request, response: mockResponse });
      await handler.handle({ request, response: mockResponse });

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should throw on fetch failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found'
      });

      handler = new DisabledOidcHandler({
        externalJwksUrl: 'https://id.example.com/.oidc/jwks'
      });

      const request = createRequest('/.oidc/jwks');
      await handler.canHandle({ request, response: mockResponse });
      await expect(handler.handle({ request, response: mockResponse })).rejects.toThrow('Failed to proxy JWKS');
    });

    it('should throw on invalid JWKS format', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ invalid: true })
      });

      handler = new DisabledOidcHandler({
        externalJwksUrl: 'https://id.example.com/.oidc/jwks'
      });

      const request = createRequest('/.oidc/jwks');
      await handler.canHandle({ request, response: mockResponse });
      await expect(handler.handle({ request, response: mockResponse })).rejects.toThrow();
    });
  });

  describe('edge cases', () => {
    const createRequest = (url: string): IncomingMessage =>
      ({ url } as IncomingMessage);

    it('should handle full URLs in request', async () => {
      handler = new DisabledOidcHandler({
        externalJwksUrl: 'https://id.example.com/.oidc/jwks'
      });

      const request = createRequest('https://node1.pods.example.com/.oidc/jwks');

      await expect(handler.canHandle({ request, response: mockResponse })).resolves.toBeUndefined();
    });

    it('should accept /.oidc/jwks.json variant', async () => {
      handler = new DisabledOidcHandler({
        externalJwksUrl: 'https://id.example.com/.oidc/jwks'
      });

      const request = createRequest('/.oidc/jwks.json');
      await expect(handler.canHandle({ request, response: mockResponse })).resolves.toBeUndefined();
    });

    it('should use correct Accept header when fetching', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ keys: [] })
      });

      handler = new DisabledOidcHandler({
        externalJwksUrl: 'https://id.example.com/.oidc/jwks'
      });

      const request = createRequest('/.oidc/jwks');
      await handler.canHandle({ request, response: mockResponse });
      await handler.handle({ request, response: mockResponse });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://id.example.com/.oidc/jwks',
        expect.objectContaining({
          headers: expect.objectContaining({
            Accept: 'application/json'
          })
        })
      );
    });
  });
});
