import { describe, it, expect } from 'vitest';
import {
  discoverOidcIssuerFromWebId,
  getConfiguredAccount,
  loginWithClientCredentials,
} from './helpers/solidAccount';

const RUN_INTEGRATION_TESTS = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
const suite = RUN_INTEGRATION_TESTS ? describe : describe.skip;

const STANDALONE_BASE = (process.env.CSS_BASE_URL || `http://localhost:${process.env.STANDALONE_PORT || '5739'}`).replace(/\/$/, '');

const STANDALONE = {
  baseUrl: STANDALONE_BASE,
} as const;

suite('Standalone Integration', () => {
  describe('Service Health', () => {
    it('service should be reachable', async () => {
      const ready = await waitForService(STANDALONE.baseUrl, 10);
      expect(ready).toBe(true);
    }, 20000);

    it('gateway status should report running services', async () => {
      const res = await fetch(`${STANDALONE.baseUrl}/service/status`);
      expect(res.status).toBe(200);
      const status = await res.json() as Array<{ name: string; status: string }>;
      expect(Array.isArray(status)).toBe(true);
      expect(status.some((item) => item.name === 'css' && item.status === 'running')).toBe(true);
    });
  });

  describe('OIDC', () => {
    it('should serve OIDC configuration', async () => {
      const res = await fetch(`${STANDALONE.baseUrl}/.well-known/openid-configuration`);
      expect(res.status).toBe(200);
      const config = await res.json() as { issuer: string };
      expect(config.issuer).toBe(STANDALONE_BASE + '/');
    });

    it('should expose JWKS endpoint', async () => {
      const res = await fetch(`${STANDALONE.baseUrl}/.oidc/jwks`);
      expect(res.status).toBe(200);
      const jwks = await res.json() as { keys?: unknown[] };
      expect(Array.isArray(jwks.keys)).toBe(true);
      expect((jwks.keys ?? []).length).toBeGreaterThan(0);
    });
  });

  describe('Account & Pod Flow', () => {
    it('should create account, login and read/write data', async () => {
      const creds = getConfiguredAccount(STANDALONE.baseUrl);
      expect(creds).not.toBeNull();

      const discoveredIssuer = await discoverOidcIssuerFromWebId(creds!.webId, STANDALONE.baseUrl);
      expect(discoveredIssuer).toBe(STANDALONE_BASE + '/');

      const session = await loginWithClientCredentials(creds! as any);
      expect(session.info.isLoggedIn).toBe(true);
      expect(session.info.webId).toBe(creds!.webId);

      const testUrl = `${creds!.podUrl}docker-lite-${Date.now()}.txt`;
      const writeRes = await session.fetch(testUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: 'Hello from docker standalone lite',
      });

      expect([200, 201]).toContain(writeRes.status);

      const readRes = await session.fetch(testUrl);
      expect(readRes.status).toBe(200);
      expect(await readRes.text()).toBe('Hello from docker standalone lite');

      await session.fetch(testUrl, { method: 'DELETE' }).catch(() => {});
      await session.logout();
    }, 60000);

    it('should reject clearly invalid token', async () => {
      const res = await fetch(`${STANDALONE.baseUrl}/test-invalid-${Date.now()}`, {
        method: 'HEAD',
        headers: {
          Authorization: 'DPoP invalid_token_here',
        },
      });
      expect([401, 404]).toContain(res.status);
    });

    it('discovery from WebID should resolve usable issuer', async () => {
      const creds = getConfiguredAccount(STANDALONE.baseUrl);
      expect(creds).not.toBeNull();
      const issuer = await discoverOidcIssuerFromWebId(creds!.webId, STANDALONE.baseUrl);
      expect(issuer).toBe(STANDALONE_BASE + '/');
    }, 30000);
  });
});

async function waitForService(url: string, maxRetries = 30): Promise<boolean> {
  const statusUrl = `${url}/service/status`;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(statusUrl, { method: 'GET' });
      if (res.status === 200) return true;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
