import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DisabledIdentityProviderHandler } from '../../../src/identity/oidc/DisabledIdentityProviderHandler';
import type { HttpResponse } from '@solid/community-server';
import type { IncomingMessage } from 'node:http';

describe('DisabledIdentityProviderHandler', () => {
  let handler: DisabledIdentityProviderHandler;
  let mockResponse: HttpResponse;

  beforeEach(() => {
    vi.clearAllMocks();

    mockResponse = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn(),
    } as unknown as HttpResponse;
  });

  describe('canHandle', () => {
    const createRequest = (url: string, method = 'GET'): IncomingMessage =>
      ({ url, method } as IncomingMessage);

    it('should reject /idp/ paths', async () => {
      handler = new DisabledIdentityProviderHandler({});

      const request = createRequest('/idp/login/');
      await expect(handler.canHandle({ request, response: mockResponse })).rejects.toThrow('external IdP');
    });

    it('should reject /account/ paths', async () => {
      handler = new DisabledIdentityProviderHandler({});

      const request = createRequest('/account/create');
      await expect(handler.canHandle({ request, response: mockResponse })).rejects.toThrow('external IdP');
    });

    it('should reject /login paths', async () => {
      handler = new DisabledIdentityProviderHandler({});

      const request = createRequest('/login');
      await expect(handler.canHandle({ request, response: mockResponse })).rejects.toThrow('external IdP');
    });

    it('should reject /logout paths', async () => {
      handler = new DisabledIdentityProviderHandler({});

      const request = createRequest('/logout');
      await expect(handler.canHandle({ request, response: mockResponse })).rejects.toThrow('external IdP');
    });

    it('should reject /register paths', async () => {
      handler = new DisabledIdentityProviderHandler({});

      const request = createRequest('/register');
      await expect(handler.canHandle({ request, response: mockResponse })).rejects.toThrow('external IdP');
    });

    it('should reject /.account/ paths', async () => {
      handler = new DisabledIdentityProviderHandler({});

      const request = createRequest('/.account/');
      await expect(handler.canHandle({ request, response: mockResponse })).rejects.toThrow('external IdP');
    });

    it('should reject non-identity paths', async () => {
      handler = new DisabledIdentityProviderHandler({});

      const request = createRequest('/alice/data.ttl');
      await expect(handler.canHandle({ request, response: mockResponse })).rejects.toThrow('Not an identity');
    });

    it('should include custom message in rejection', async () => {
      handler = new DisabledIdentityProviderHandler({
        message: 'Custom: use id.example.com'
      });

      const request = createRequest('/login');
      await expect(handler.canHandle({ request, response: mockResponse })).rejects.toThrow('Custom: use id.example.com');
    });
  });

  describe('handle', () => {
    const createRequest = (url: string): IncomingMessage =>
      ({ url } as IncomingMessage);

    it('should return 501 with error message', async () => {
      handler = new DisabledIdentityProviderHandler({
        message: 'Test message'
      });

      const request = createRequest('/login');
      await handler.handle({ request, response: mockResponse });

      expect(mockResponse.statusCode).toBe(501);
      expect(mockResponse.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');

      const responseBody = (mockResponse.end as jest.Mock).mock.calls[0][0];
      const parsed = JSON.parse(responseBody);
      expect(parsed.error).toBe('not_implemented');
      expect(parsed.message).toBe('Test message');
      expect(parsed.hint).toContain('Storage Provider');
    });
  });

  describe('edge cases', () => {
    const createRequest = (url: string, method = 'GET'): IncomingMessage =>
      ({ url, method } as IncomingMessage);

    it('should handle full URLs', async () => {
      handler = new DisabledIdentityProviderHandler({});

      const request = createRequest('https://node1.pods.example.com/login');
      await expect(handler.canHandle({ request, response: mockResponse })).rejects.toThrow('external IdP');
    });

    it('should handle URLs with query strings', async () => {
      handler = new DisabledIdentityProviderHandler({});

      const request = createRequest('/login?redirect=/alice/');
      await expect(handler.canHandle({ request, response: mockResponse })).rejects.toThrow('external IdP');
    });

    it('should handle POST requests', async () => {
      handler = new DisabledIdentityProviderHandler({});

      const request = createRequest('/account/create', 'POST');
      await expect(handler.canHandle({ request, response: mockResponse })).rejects.toThrow('external IdP');
    });
  });
});
