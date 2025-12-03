import { beforeAll, describe, it, expect } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { Session } from '@inrupt/solid-client-authn-node';

loadEnv({ path: process.env.SOLID_ENV_FILE ?? '.env.local' });

const baseUrl = process.env.XPOD_SERVER_BASE_URL ?? 'http://localhost:3000/';
const clientId = process.env.SOLID_CLIENT_ID;
const clientSecret = process.env.SOLID_CLIENT_SECRET;
const oidcIssuer = process.env.SOLID_OIDC_ISSUER ?? baseUrl;
const tokenType = process.env.SOLID_TOKEN_TYPE === 'Bearer' ? 'Bearer' : 'DPoP';

function joinUrl(base: string, path: string): string {
  return new URL(path, base).toString();
}

const shouldRunIntegration = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true' && clientId && clientSecret;
const suite = shouldRunIntegration ? describe : describe.skip;

suite('API Authentication', () => {
  let session: Session;
  let authFetch: typeof fetch;

  beforeAll(async () => {
    // Check if server is running
    try {
      const health = await fetch(baseUrl, { method: 'HEAD' });
      if (!health.ok && ![401, 404, 405].includes(health.status)) {
        throw new Error(`Server responded with status ${health.status}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Server not reachable at ${baseUrl}. Start with "yarn local" or "yarn server" first. Error: ${message}`);
    }

    // Setup authenticated fetch via OIDC
    session = new Session();
    await session.login({
      clientId: clientId!,
      clientSecret: clientSecret!,
      oidcIssuer,
      tokenType,
    });
    authFetch = session.fetch.bind(session);
  });

  describe('Authentication', () => {
    it('rejects unauthorized write requests', async () => {
      // Try to write without credentials - should fail
      const response = await fetch(joinUrl(baseUrl, 'test/unauthorized-write-test.txt'), {
        method: 'PUT',
        headers: {
          'Content-Type': 'text/plain',
        },
        body: 'This should fail',
      });

      // Should require authentication for write operations
      expect([401, 403]).toContain(response.status);
    });

    it('accepts requests with valid credentials', async () => {
      const response = await authFetch(joinUrl(baseUrl, '.account/'), {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      // Should be accessible with valid credentials
      expect([200, 404]).toContain(response.status); // 404 if account doesn't exist yet
    });

    it('can create resources with valid credentials', async () => {
      const testResource = joinUrl(baseUrl, 'test/api-auth-test/test-resource.txt');

      // Create a test resource
      const putResponse = await authFetch(testResource, {
        method: 'PUT',
        headers: {
          'Content-Type': 'text/plain',
        },
        body: 'Test content from API auth test',
      });

      expect([200, 201, 204]).toContain(putResponse.status);

      // Verify resource exists
      const getResponse = await authFetch(testResource, {
        method: 'GET',
        headers: {
          'Accept': 'text/plain',
        },
      });

      expect(getResponse.status).toBe(200);
      const content = await getResponse.text();
      expect(content).toContain('Test content from API auth test');

      // Cleanup - delete the test resource
      await authFetch(testResource, {
        method: 'DELETE',
      }).catch(() => {}); // Ignore cleanup errors
    });

    it('can list resources with valid credentials', async () => {
      const response = await authFetch(joinUrl(baseUrl, 'test/'), {
        method: 'GET',
        headers: {
          'Accept': 'text/turtle, application/ld+json, application/json',
        },
      });

      if (response.status === 200) {
        const contentType = response.headers.get('content-type') || '';
        expect(contentType).toMatch(/(turtle|json|rdf)/i);

        // Should return some RDF/JSON-LD content
        const content = await response.text();
        expect(content.length).toBeGreaterThan(0);
      } else {
        // Container might not exist yet, which is also valid
        expect([404]).toContain(response.status);
      }
    });
  });

  describe('Database Storage Integration', () => {
    it('verifies database connection through server', async () => {
      // Try to access any authenticated endpoint to verify the database-backed auth works
      const response = await authFetch(joinUrl(baseUrl, 'test/'), {
        method: 'HEAD',
      });

      // If the server is using DrizzleAccountLoginStorage and it's working,
      // we should get a proper response (not 500 database error)
      expect([200, 401, 404]).toContain(response.status);

      // Should not be a server error
      expect(response.status).not.toBe(500);
    });

    it('handles authentication through database layer', async () => {
      // This tests that the token validation goes through the database
      // Multiple requests should work consistently (no connection pool issues)
      const requests = await Promise.all([
        authFetch(joinUrl(baseUrl, 'test/'), { method: 'HEAD' }),
        authFetch(joinUrl(baseUrl, 'test/'), { method: 'HEAD' }),
        authFetch(joinUrl(baseUrl, 'test/'), { method: 'HEAD' }),
      ]);

      // All should return consistent results
      const statuses = requests.map(r => r.status);
      const uniqueStatuses = new Set(statuses);

      // Should not have server errors
      expect(statuses.every(status => status !== 500)).toBe(true);

      // Should have consistent behavior
      expect(uniqueStatuses.size).toBe(1);
    });
  });
});