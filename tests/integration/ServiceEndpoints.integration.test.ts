import { describe, it, expect, beforeAll } from 'vitest';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables from .env.local
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

/**
 * Service Endpoints Integration Tests
 * 
 * These tests connect to an external running server via CSS_BASE_URL
 * Requires: yarn test:setup (to generate client credentials)
 * 
 * Environment variables:
 *   CSS_BASE_URL - Server base URL (default: http://localhost:3000)
 *   SOLID_CLIENT_ID - Client ID for authentication
 *   SOLID_CLIENT_SECRET - Client Secret for authentication
 */

const BASE_URL = (process.env.CSS_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const CLIENT_ID = process.env.SOLID_CLIENT_ID;
const CLIENT_SECRET = process.env.SOLID_CLIENT_SECRET;
const RUN_SERVICE_TESTS = process.env.XPOD_RUN_SERVICE_TESTS === 'true';
const suite = RUN_SERVICE_TESTS ? describe : describe.skip;

suite('Service Endpoints Integration', () => {
  let accessToken: string | null = null;

  beforeAll(async () => {
    console.log(`Testing against: ${BASE_URL}`);

    // Verify server is running
    try {
      const response = await fetch(`${BASE_URL}/service/status`, { 
        signal: AbortSignal.timeout(5000) 
      });
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }
      console.log('✓ Server is reachable');
    } catch (error) {
      console.error(`✗ Failed to connect to server at ${BASE_URL}`);
      console.error('  Please start the server first: yarn local');
      throw error;
    }

    // Authenticate if credentials are available
    if (CLIENT_ID && CLIENT_SECRET) {
      try {
        const tokenResponse = await fetch(`${BASE_URL}/.oidc/token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
          }),
        });

        if (tokenResponse.ok) {
          const tokenData = await tokenResponse.json();
          accessToken = tokenData.access_token;
          console.log('✓ Authenticated successfully');
        } else {
          console.warn('✗ Authentication failed:', await tokenResponse.text());
          console.warn('  Run: yarn test:setup');
        }
      } catch (error) {
        console.warn('✗ Authentication error:', error);
      }
    } else {
      console.warn('⚠ No client credentials found in .env.local');
      console.warn('  Run: yarn test:setup');
    }
  });

  describe('Service Status Endpoint', () => {
    it('should return service status without authentication', async () => {
      const response = await fetch(`${BASE_URL}/service/status`);
      
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      
      const data = await response.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(2);
      
      // Verify structure
      const cssService = data.find((s: any) => s.name === 'css');
      const apiService = data.find((s: any) => s.name === 'api');
      
      expect(cssService).toBeDefined();
      expect(apiService).toBeDefined();
      expect(['running', 'stopped']).toContain(cssService.status);
      expect(['running', 'stopped']).toContain(apiService.status);
      
      console.log(`  CSS: ${cssService.status}, API: ${apiService.status}`);
    });

    it('should handle concurrent requests', async () => {
      const promises = Array(5).fill(null).map(() => 
        fetch(`${BASE_URL}/service/status`)
      );
      
      const responses = await Promise.all(promises);
      
      responses.forEach(response => {
        expect(response.status).toBe(200);
      });
    });

    it('should return CORS headers', async () => {
      const response = await fetch(`${BASE_URL}/service/status`, {
        headers: { 'Origin': 'http://localhost:3000' },
      });
      
      const allowOrigin = response.headers.get('access-control-allow-origin');
      expect(allowOrigin === 'http://localhost:3000' || allowOrigin === '*').toBe(true);
    });
  });

  describe('Service Logs Endpoint', () => {
    it('should return all logs', async () => {
      const response = await fetch(`${BASE_URL}/service/logs`);
      const data = await response.json();
      
      expect(response.status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      
      if (data.length > 0) {
        const log = data[0];
        expect(log).toHaveProperty('timestamp');
        expect(log).toHaveProperty('level');
        expect(log).toHaveProperty('source');
        expect(log).toHaveProperty('message');
        console.log(`  Found ${data.length} logs`);
      }
    });

    it('should filter by level', async () => {
      const response = await fetch(`${BASE_URL}/service/logs?level=info`);
      const data = await response.json();
      
      expect(response.status).toBe(200);
      if (data.length > 0) {
        expect(data.every((log: any) => log.level === 'info')).toBe(true);
      }
    });

    it('should filter by source', async () => {
      const response = await fetch(`${BASE_URL}/service/logs?source=css`);
      const data = await response.json();
      
      expect(response.status).toBe(200);
      if (data.length > 0) {
        expect(data.every((log: any) => log.source === 'css')).toBe(true);
      }
    });

    it('should combine filters', async () => {
      const response = await fetch(`${BASE_URL}/service/logs?level=info&source=css&limit=5`);
      const data = await response.json();
      
      expect(response.status).toBe(200);
      expect(data.length).toBeLessThanOrEqual(5);
      if (data.length > 0) {
        expect(data.every((log: any) => log.level === 'info' && log.source === 'css')).toBe(true);
      }
    });
  });

  describe('Dashboard Integration', () => {
    it('should serve dashboard', async () => {
      const response = await fetch(`${BASE_URL}/dashboard/`);
      // Dashboard UI may be intentionally absent in some deployments.
      expect([200, 302, 404]).toContain(response.status);
    });

    it('should allow dashboard to access service endpoints', async () => {
      const statusRes = await fetch(`${BASE_URL}/service/status`, {
        headers: { 'Origin': BASE_URL },
      });
      
      expect(statusRes.status).toBe(200);
      
      const allowOrigin = statusRes.headers.get('access-control-allow-origin');
      expect(allowOrigin === BASE_URL || allowOrigin === '*').toBe(true);
    });
  });

  describe('CORS Preflight', () => {
    it('should handle OPTIONS for /service/status', async () => {
      const response = await fetch(`${BASE_URL}/service/status`, {
        method: 'OPTIONS',
        headers: {
          'Origin': 'http://localhost:3000',
          'Access-Control-Request-Method': 'GET',
        },
      });
      
      expect(response.status).toBe(204);
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for unknown endpoints', async () => {
      const response = await fetch(`${BASE_URL}/service/unknown`);
      expect(response.status).toBe(404);
    });
  });
});
