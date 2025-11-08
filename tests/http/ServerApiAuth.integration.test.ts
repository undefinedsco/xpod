import { beforeAll, describe, it, expect } from 'vitest';
import type { Response } from 'undici';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: process.env.SOLID_ENV_FILE ?? '.env.server' });

const baseUrl = process.env.XPOD_SERVER_BASE_URL ?? 'http://localhost:3000/';
const testToken = process.env.XPOD_TEST_BEARER_TOKEN; // Bearer token for testing

function joinUrl(base: string, path: string): string {
  return new URL(path, base).toString();
}

const shouldRunIntegration = process.env.XPOD_RUN_SERVER_INTEGRATION === 'true' && testToken;
const suite = shouldRunIntegration ? describe : describe.skip;

suite('Server Mode API Authentication', () => {
  beforeAll(async () => {
    // Check if server is running
    try {
      const health = await fetch(baseUrl, { method: 'HEAD' });
      if (!health.ok && ![401, 404, 405].includes(health.status)) {
        throw new Error(`Server responded with status ${health.status}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Server not reachable at ${baseUrl}. Start with "yarn server" first. Error: ${message}`);
    }

    if (!testToken) {
      throw new Error('XPOD_TEST_BEARER_TOKEN environment variable required for API authentication tests');
    }
  });

  describe('Bearer Token Authentication', () => {
    it('rejects requests without token', async () => {
      const response = await fetch(joinUrl(baseUrl, '.account/'), {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toMatch(/Bearer/i);
    });

    it('accepts requests with valid Bearer token', async () => {
      const response = await fetch(joinUrl(baseUrl, '.account/'), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${testToken}`,
          'Accept': 'application/json',
        },
      });

      // Should be accessible with valid token
      expect([200, 404]).toContain(response.status); // 404 if account doesn't exist yet
    });

    it('can create resources with Bearer token', async () => {
      const testResource = joinUrl(baseUrl, '.account/test-resource.txt');
      
      // Create a test resource
      const putResponse = await fetch(testResource, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${testToken}`,
          'Content-Type': 'text/plain',
        },
        body: 'Test content from API auth test',
      });

      expect([200, 201, 204]).toContain(putResponse.status);

      // Verify resource exists
      const getResponse = await fetch(testResource, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${testToken}`,
          'Accept': 'text/plain',
        },
      });

      expect(getResponse.status).toBe(200);
      const content = await getResponse.text();
      expect(content).toContain('Test content from API auth test');

      // Cleanup - delete the test resource
      await fetch(testResource, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${testToken}`,
        },
      }).catch(() => {}); // Ignore cleanup errors
    });

    it('can list account resources with Bearer token', async () => {
      const response = await fetch(joinUrl(baseUrl, '.account/'), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${testToken}`,
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
        // Account might not exist yet, which is also valid
        expect([404, 401]).toContain(response.status);
      }
    });
  });

  describe('Database Login Storage Integration', () => {
    it('verifies database connection through server', async () => {
      // Try to access any authenticated endpoint to verify the database-backed auth works
      const response = await fetch(joinUrl(baseUrl, '.account/'), {
        method: 'HEAD',
        headers: {
          'Authorization': `Bearer ${testToken}`,
        },
      });

      // If the server is using DrizzleAccountLoginStorage and it's working,
      // we should get a proper response (not 500 database error)
      expect([200, 401, 404]).toContain(response.status);
      
      // Should not be a server error
      expect(response.status).not.toBe(500);
    });

    it('handles authentication through database layer', async () => {
      // This tests that the Bearer token validation goes through the database
      // Multiple requests should work consistently (no connection pool issues)
      const requests = await Promise.all([
        fetch(joinUrl(baseUrl, '.account/'), {
          method: 'HEAD',
          headers: { 'Authorization': `Bearer ${testToken}` },
        }),
        fetch(joinUrl(baseUrl, '.account/'), {
          method: 'HEAD',  
          headers: { 'Authorization': `Bearer ${testToken}` },
        }),
        fetch(joinUrl(baseUrl, '.account/'), {
          method: 'HEAD',
          headers: { 'Authorization': `Bearer ${testToken}` },
        }),
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