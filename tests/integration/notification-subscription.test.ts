/**
 * Solid Notification Subscription Integration Tests
 * 
 * Tests WebSocketChannel2023 subscription protocol as defined in:
 * https://solid.github.io/notifications/protocol
 * 
 * These tests verify:
 * 1. Subscription endpoint discovery
 * 2. Subscription validation
 * 3. Performance baseline
 * 
 * Note: Full notification tests with WebSocket require authentication.
 * Run with: XPOD_RUN_INTEGRATION_TESTS=true npx vitest run tests/integration/notification-subscription.test.ts
 */

import { AppRunner, App } from '@solid/community-server';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';

// Use local config to avoid Redis dependency
const configFiles = [
  path.join(process.cwd(), 'config/main.local.json'),
  path.join(process.cwd(), 'config/extensions.local.json'),
];

describe('Solid Notification Subscription', () => {
  let app: App;
  let baseUrl: string;
  
  const testDataDir = '.test-data/notification-subscription';
  const sparqlDbPath = `${testDataDir}/quadstore.sqlite`;
  const rootFilePath = `${testDataDir}/data`;
  const NOTIFICATION_ENDPOINT = '/.notifications/WebSocketChannel2023/';

  beforeAll(async () => {
    // Ensure test data directory exists
    fs.mkdirSync(testDataDir, { recursive: true });
    fs.mkdirSync(rootFilePath, { recursive: true });
    
    process.env.CSS_SPARQL_ENDPOINT = `sqlite:${sparqlDbPath}`;
    process.env.CSS_BASE_URL = 'http://localhost:4010/';
    
    app = await new AppRunner().create({
      config: configFiles,
      loaderProperties: {
        mainModulePath: process.cwd(),
        typeChecking: false,
      },
      variableBindings: {
        'urn:solid-server:default:variable:port': 4010,
        'urn:solid-server:default:variable:baseUrl': 'http://localhost:4010/',
        'urn:solid-server:default:variable:showStackTrace': true,
        'urn:solid-server:default:variable:loggingLevel': 'warn',
        'urn:solid-server:default:variable:sparqlEndpoint': `sqlite:${sparqlDbPath}`,
        'urn:solid-server:default:variable:rootFilePath': rootFilePath,
      },
    });

    await app.start();
    baseUrl = 'http://localhost:4010';
  }, 30000);

  afterAll(async () => {
    if (app) {
      await app.stop();
    }
    // Cleanup test data directory
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  }, 15000);

  describe('Subscription Endpoint Discovery', () => {
    it('should return 200 OK for notification endpoint GET', async () => {
      const response = await fetch(`${baseUrl}${NOTIFICATION_ENDPOINT}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/ld+json',
        },
      });
      
      expect(response.status).toBe(200);
      
      const contentType = response.headers.get('content-type');
      expect(contentType).toMatch(/application\/ld\+json|application\/json/);
    });

    it('should return valid JSON-LD with @context', async () => {
      const response = await fetch(`${baseUrl}${NOTIFICATION_ENDPOINT}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/ld+json',
        },
      });
      
      const body = await response.json();
      expect(body).toHaveProperty('@context');
    });

    it('should include WebSocketChannel2023 channel information', async () => {
      const response = await fetch(`${baseUrl}${NOTIFICATION_ENDPOINT}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/ld+json',
        },
      });
      
      const body = await response.json();
      const bodyStr = JSON.stringify(body);
      // Response should mention WebSocket channel
      expect(bodyStr).toMatch(/WebSocket|channel/i);
    });
  });

  describe('Subscription Validation', () => {
    it('should reject subscription without topic (422 Unprocessable Entity)', async () => {
      const subscriptionBody = {
        '@context': ['https://www.w3.org/ns/solid/notification/v1'],
        'type': 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023',
      };
      
      const response = await fetch(`${baseUrl}${NOTIFICATION_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/ld+json',
          'Accept': 'application/ld+json',
        },
        body: JSON.stringify(subscriptionBody),
      });
      
      // CSS returns 422 Unprocessable Entity for missing required fields
      expect([400, 422]).toContain(response.status);
    });

    it('should reject subscription for non-existent resource (401/404)', async () => {
      const subscriptionBody = {
        '@context': ['https://www.w3.org/ns/solid/notification/v1'],
        'type': 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023',
        'topic': `${baseUrl}/non-existent-resource-${Date.now()}/`,
      };
      
      const response = await fetch(`${baseUrl}${NOTIFICATION_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/ld+json',
          'Accept': 'application/ld+json',
        },
        body: JSON.stringify(subscriptionBody),
      });
      
      // Should return 401 (unauthorized) or 404 (not found)
      expect([401, 404]).toContain(response.status);
    });

    it('should reject subscription with invalid content type (422)', async () => {
      const response = await fetch(`${baseUrl}${NOTIFICATION_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'Accept': 'application/ld+json',
        },
        body: 'invalid body',
      });
      
      // CSS returns 422 for unparseable content
      expect([400, 415, 422]).toContain(response.status);
    });

    it('should reject empty POST body', async () => {
      const response = await fetch(`${baseUrl}${NOTIFICATION_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/ld+json',
          'Accept': 'application/ld+json',
        },
        body: '',
      });
      
      // Should return error status
      expect([400, 415, 422]).toContain(response.status);
    });
  });

  describe('Subscription Performance Baseline', () => {
    it('should respond to GET endpoint within acceptable time', async () => {
      const startTime = Date.now();
      
      const response = await fetch(`${baseUrl}${NOTIFICATION_ENDPOINT}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/ld+json',
        },
      });
      
      const elapsed = Date.now() - startTime;
      
      expect(response.status).toBe(200);
      
      // GET should be fast (< 1s)
      expect(elapsed).toBeLessThan(1000);
    });

    it('should handle multiple GET requests efficiently', async () => {
      const NUM_REQUESTS = 10;
      const startTime = Date.now();
      
      const results = await Promise.all(
        Array(NUM_REQUESTS).fill(null).map(() =>
          fetch(`${baseUrl}${NOTIFICATION_ENDPOINT}`, {
            method: 'GET',
            headers: {
              'Accept': 'application/ld+json',
            },
          })
        )
      );
      
      const elapsed = Date.now() - startTime;
      
      const successCount = results.filter(r => r.status === 200).length;
      expect(successCount).toBe(NUM_REQUESTS);
      
      // All requests should complete within 5 seconds
      expect(elapsed).toBeLessThan(5000);
      
      console.log(`${NUM_REQUESTS} parallel GET requests completed in ${elapsed}ms (avg: ${Math.round(elapsed/NUM_REQUESTS)}ms)`);
    });

    it('should handle POST validation quickly', async () => {
      const subscriptionBody = {
        '@context': ['https://www.w3.org/ns/solid/notification/v1'],
        'type': 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023',
        // Missing topic - will be rejected
      };
      
      const startTime = Date.now();
      
      const response = await fetch(`${baseUrl}${NOTIFICATION_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/ld+json',
          'Accept': 'application/ld+json',
        },
        body: JSON.stringify(subscriptionBody),
      });
      
      const elapsed = Date.now() - startTime;
      
      // Validation should be fast even for invalid requests
      expect(elapsed).toBeLessThan(1000);
      expect([400, 422]).toContain(response.status);
    });
  });
});

/**
 * Authenticated Notification Tests
 * 
 * These tests require a running server with authentication enabled.
 * Set XPOD_RUN_INTEGRATION_TESTS=true and ensure server is running.
 */
const shouldRunAuthTests = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
const authSuite = shouldRunAuthTests ? describe : describe.skip;

authSuite('Authenticated Notification Subscription', () => {
  // These tests require:
  // 1. A running xpod server with authentication
  // 2. A test user with a pod
  // 3. Proper authentication cookies/tokens
  
  it.todo('should create subscription via POST with authentication');
  it.todo('should establish WebSocket connection from subscription');
  it.todo('should receive notification when resource changes');
  it.todo('should handle subscription cleanup on WebSocket close');
});
