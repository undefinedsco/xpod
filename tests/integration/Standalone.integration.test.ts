import { describe, it, expect } from 'vitest';
import { Session } from '@inrupt/solid-client-authn-node';

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
      const creds = await setupAccount(STANDALONE.baseUrl, 'standalone-lite');
      expect(creds).not.toBeNull();

      const session = new Session();
      const discoveredIssuer = await discoverOidcIssuerFromWebId(creds!.webId, STANDALONE.baseUrl);
      await session.login({
        clientId: creds!.clientId,
        clientSecret: creds!.clientSecret,
        oidcIssuer: discoveredIssuer,
        tokenType: 'DPoP',
      });

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
      const creds = await setupAccount(STANDALONE.baseUrl, 'issuer-discovery');
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

async function discoverOidcIssuerFromWebId(webId: string, fallbackIssuer: string): Promise<string> {
  try {
    const profileUrl = webId.split('#')[0];
    const res = await fetch(profileUrl, {
      headers: { Accept: 'text/turtle, application/ld+json;q=0.9, application/rdf+xml;q=0.8' },
    });
    if (!res.ok) return fallbackIssuer;
    const body = await res.text();

    const fullIriMatch = body.match(/<http:\/\/www\.w3\.org\/ns\/solid\/terms#oidcIssuer>\s*<([^>]+)>/);
    const prefixedMatch = body.match(/solid:oidcIssuer\s*<([^>]+)>/);
    const raw = fullIriMatch?.[1] ?? prefixedMatch?.[1];
    if (!raw) return fallbackIssuer;

    const discovered = new URL(raw, profileUrl).toString();
    const config = await fetch(`${discovered.replace(/\/$/, '')}/.well-known/openid-configuration`);
    if (config.ok) {
      return discovered;
    }
  } catch {
    // ignore and fallback
  }
  return fallbackIssuer;
}

interface AccountSetup {
  clientId: string;
  clientSecret: string;
  webId: string;
  podUrl: string;
}

async function setupAccount(baseUrl: string, prefix: string): Promise<AccountSetup | null> {
  try {
    const timestamp = Date.now();
    const email = `${prefix}-${timestamp}@test.com`;
    const podName = `${prefix}-${timestamp}`;

    const createRes = await fetch(`${baseUrl}/.account/account/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!createRes.ok) return null;

    const { authorization: token } = await createRes.json() as { authorization: string };

    const accountRes = await fetch(`${baseUrl}/.account/`, {
      headers: { Authorization: `CSS-Account-Token ${token}` },
    });
    if (!accountRes.ok) return null;

    const accountInfo = await accountRes.json() as {
      controls?: {
        password?: { create?: string };
        account?: { pod?: string; clientCredentials?: string };
      };
    };

    const pwdUrl = accountInfo.controls?.password?.create;
    if (pwdUrl) {
      const pwdRes = await fetch(pwdUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `CSS-Account-Token ${token}`,
        },
        body: JSON.stringify({ email, password: 'test123456' }),
      });
      if (!pwdRes.ok) return null;
    }

    const podEndpoint = accountInfo.controls?.account?.pod;
    if (!podEndpoint) return null;

    const podRes = await fetch(podEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `CSS-Account-Token ${token}`,
      },
      body: JSON.stringify({ name: podName }),
    });
    if (!podRes.ok) return null;

    const podData = await podRes.json() as { webId?: string; pod?: string };
    const webId = podData.webId || `${baseUrl}/${podName}/profile/card#me`;
    const podUrl = podData.pod || `${baseUrl}/${podName}/`;

    const credsUrl = accountInfo.controls?.account?.clientCredentials;
    if (!credsUrl) return null;

    const credRes = await fetch(credsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `CSS-Account-Token ${token}`,
      },
      body: JSON.stringify({ name: 'standalone-lite-client', webId }),
    });

    if (!credRes.ok) return null;
    const creds = await credRes.json() as { id: string; secret: string };
    if (!creds.id || !creds.secret) return null;

    return {
      clientId: creds.id,
      clientSecret: creds.secret,
      webId,
      podUrl,
    };
  } catch {
    return null;
  }
}
