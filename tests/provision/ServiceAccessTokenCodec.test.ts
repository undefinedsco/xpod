import { describe, expect, it } from 'vitest';
import { createServiceAccessToken, verifyServiceAccessToken } from '../../src/provision/ServiceAccessTokenCodec';

describe('ServiceAccessTokenCodec', () => {
  it('creates a short-lived service access token verified by the long-lived service token', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const token = createServiceAccessToken({
      serviceToken: 'svc-long-lived-secret',
      subject: 'node-1',
      scopes: ['pod:provision'],
      ttlSeconds: 900,
      now: () => now,
    });

    expect(token).toMatch(/^sat-/);

    const result = verifyServiceAccessToken(token, {
      serviceToken: 'svc-long-lived-secret',
      requiredScope: 'pod:provision',
      now: () => now + 899_000,
    });

    expect(result.valid).toBe(true);
    expect(result.payload).toMatchObject({
      typ: 'xpod-service-access',
      sub: 'node-1',
      scopes: ['pod:provision'],
      exp: Math.floor(now / 1000) + 900,
    });
  });

  it('rejects expired or wrong-secret access tokens', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const token = createServiceAccessToken({
      serviceToken: 'svc-long-lived-secret',
      subject: 'node-1',
      scopes: ['pod:provision'],
      ttlSeconds: 60,
      now: () => now,
    });

    expect(verifyServiceAccessToken(token, {
      serviceToken: 'svc-long-lived-secret',
      now: () => now + 61_000,
    }).valid).toBe(false);
    expect(verifyServiceAccessToken(token, {
      serviceToken: 'svc-other-secret',
      now: () => now,
    }).valid).toBe(false);
  });
});
