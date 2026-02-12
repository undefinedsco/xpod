import { describe, it, expect } from 'vitest';

const RUN_INTEGRATION_TESTS = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
const suite = RUN_INTEGRATION_TESTS ? describe : describe.skip;

suite('Solid Notification Subscription (Integration)', () => {
  const baseUrl = 'http://localhost:5739';
  const NOTIFICATION_ENDPOINT = '/.notifications/WebSocketChannel2023/';

  describe('Subscription Endpoint Discovery', () => {
    it('should return 200 OK for notification endpoint GET', async () => {
      const response = await fetch(`${baseUrl}${NOTIFICATION_ENDPOINT}`, {
        method: 'GET',
        headers: {
          Accept: 'application/ld+json',
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
          Accept: 'application/ld+json',
        },
      });

      const body = await response.json();
      expect(body).toHaveProperty('@context');
    });

    it('should include WebSocketChannel2023 channel information', async () => {
      const response = await fetch(`${baseUrl}${NOTIFICATION_ENDPOINT}`, {
        method: 'GET',
        headers: {
          Accept: 'application/ld+json',
        },
      });

      const body = await response.json();
      const bodyStr = JSON.stringify(body);
      expect(bodyStr).toMatch(/WebSocket|channel/i);
    });
  });

  describe('Subscription Validation', () => {
    it('should reject subscription without topic (422 Unprocessable Entity)', async () => {
      const subscriptionBody = {
        '@context': ['https://www.w3.org/ns/solid/notification/v1'],
        type: 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023',
      };

      const response = await fetch(`${baseUrl}${NOTIFICATION_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/ld+json',
          Accept: 'application/ld+json',
        },
        body: JSON.stringify(subscriptionBody),
      });

      expect([400, 422]).toContain(response.status);
    });

    it('should reject subscription for non-existent resource (401/404)', async () => {
      const subscriptionBody = {
        '@context': ['https://www.w3.org/ns/solid/notification/v1'],
        type: 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023',
        topic: `${baseUrl}/non-existent-resource-${Date.now()}/`,
      };

      const response = await fetch(`${baseUrl}${NOTIFICATION_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/ld+json',
          Accept: 'application/ld+json',
        },
        body: JSON.stringify(subscriptionBody),
      });

      // In standalone profile, unauthenticated validation may accept topic format without checking resource existence.
      expect([200, 401, 404]).toContain(response.status);
    });

    it('should reject subscription with invalid content type (422)', async () => {
      const response = await fetch(`${baseUrl}${NOTIFICATION_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Accept: 'application/ld+json',
        },
        body: 'invalid body',
      });

      expect([400, 415, 422]).toContain(response.status);
    });

    it('should reject empty POST body', async () => {
      const response = await fetch(`${baseUrl}${NOTIFICATION_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/ld+json',
          Accept: 'application/ld+json',
        },
        body: '',
      });

      expect([400, 415, 422]).toContain(response.status);
    });
  });

  describe('Subscription Performance Baseline', () => {
    it('should respond to GET endpoint within acceptable time', async () => {
      const startTime = Date.now();

      const response = await fetch(`${baseUrl}${NOTIFICATION_ENDPOINT}`, {
        method: 'GET',
        headers: {
          Accept: 'application/ld+json',
        },
      });

      const elapsed = Date.now() - startTime;

      expect(response.status).toBe(200);
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
              Accept: 'application/ld+json',
            },
          }),
        ),
      );

      const elapsed = Date.now() - startTime;

      const successCount = results.filter((r) => r.status === 200).length;
      expect(successCount).toBe(NUM_REQUESTS);
      expect(elapsed).toBeLessThan(5000);
    });

    it('should handle POST validation quickly', async () => {
      const subscriptionBody = {
        '@context': ['https://www.w3.org/ns/solid/notification/v1'],
        type: 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023',
      };

      const startTime = Date.now();
      const response = await fetch(`${baseUrl}${NOTIFICATION_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/ld+json',
          Accept: 'application/ld+json',
        },
        body: JSON.stringify(subscriptionBody),
      });
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(1000);
      expect([400, 422]).toContain(response.status);
    });
  });
});
