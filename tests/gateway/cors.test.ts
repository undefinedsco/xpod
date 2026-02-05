import { describe, it, expect } from 'vitest';
import http from 'http';

const GATEWAY_URL = 'http://localhost:3000';
const TEST_ORIGIN = 'http://localhost:5173';

// Helper to make HTTP requests
function request(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
  } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: options.method || 'GET',
        headers: options.headers,
      },
      (res) => {
        resolve({ status: res.statusCode!, headers: res.headers });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe.skip('Gateway CORS Integration Tests (requires running xpod)', () => {
  describe('OPTIONS preflight', () => {
    it('should return 204 with CORS headers for /.oidc/reg', async () => {
      const res = await request(`${GATEWAY_URL}/.oidc/reg`, {
        method: 'OPTIONS',
        headers: {
          'Origin': TEST_ORIGIN,
          'Access-Control-Request-Method': 'POST',
        },
      });

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-allow-methods']).toContain('POST');
    });

    it('should return 204 with CORS headers for /test/profile/card', async () => {
      const res = await request(`${GATEWAY_URL}/test/profile/card`, {
        method: 'OPTIONS',
        headers: {
          'Origin': TEST_ORIGIN,
          'Access-Control-Request-Method': 'GET',
        },
      });

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('should return 204 with CORS headers for /service/status', async () => {
      const res = await request(`${GATEWAY_URL}/service/status`, {
        method: 'OPTIONS',
        headers: {
          'Origin': TEST_ORIGIN,
          'Access-Control-Request-Method': 'GET',
        },
      });

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
    });
  });

  describe('Actual requests with Origin header', () => {
    it('should include CORS headers on GET /test/', async () => {
      const res = await request(`${GATEWAY_URL}/test/`, {
        method: 'GET',
        headers: {
          'Origin': TEST_ORIGIN,
          'Accept': 'text/turtle',
        },
      });

      expect(res.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('should include CORS headers on GET /.oidc/.well-known/openid-configuration', async () => {
      const res = await request(`${GATEWAY_URL}/.oidc/.well-known/openid-configuration`, {
        method: 'GET',
        headers: {
          'Origin': TEST_ORIGIN,
        },
      });

      expect(res.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
    });

    it('should include CORS headers on GET /service/status', async () => {
      const res = await request(`${GATEWAY_URL}/service/status`, {
        method: 'GET',
        headers: {
          'Origin': TEST_ORIGIN,
        },
      });

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
    });
  });

  describe('Requests without Origin header', () => {
    it('should not include CORS headers when no Origin', async () => {
      const res = await request(`${GATEWAY_URL}/test/`, {
        method: 'GET',
        headers: {
          'Accept': 'text/turtle',
        },
      });

      // No CORS headers when no Origin
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('CORS header values', () => {
    it('should expose required Solid headers', async () => {
      const res = await request(`${GATEWAY_URL}/test/`, {
        method: 'OPTIONS',
        headers: {
          'Origin': TEST_ORIGIN,
          'Access-Control-Request-Method': 'GET',
        },
      });

      const exposedHeaders = res.headers['access-control-expose-headers'] as string;
      expect(exposedHeaders).toContain('ETag');
      expect(exposedHeaders).toContain('Link');
      expect(exposedHeaders).toContain('Location');
      expect(exposedHeaders).toContain('WAC-Allow');
      expect(exposedHeaders).toContain('X-Request-Id');
    });

    it('should allow required Solid request headers', async () => {
      const res = await request(`${GATEWAY_URL}/test/`, {
        method: 'OPTIONS',
        headers: {
          'Origin': TEST_ORIGIN,
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'Authorization, Content-Type, DPoP',
        },
      });

      const allowedHeaders = res.headers['access-control-allow-headers'] as string;
      expect(allowedHeaders).toContain('Authorization');
      expect(allowedHeaders).toContain('Content-Type');
      expect(allowedHeaders).toContain('DPoP');
    });
  });
});
