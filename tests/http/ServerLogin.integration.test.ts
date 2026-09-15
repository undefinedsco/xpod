import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: process.env.SOLID_ENV_FILE ?? '.env.server' });

const rawBaseUrl = process.env.CSS_BASE_URL ?? 'http://localhost:3000';
const baseUrl = rawBaseUrl.endsWith('/') ? rawBaseUrl : `${rawBaseUrl}/`;
const testEmail = `test-${Date.now()}@example.com`;
const testPassword = 'TestServerLogin123!';
const seedEmail = process.env.SOLID_EMAIL ?? 'test-integration@example.com';
const seedPassword = process.env.SOLID_PASSWORD ?? 'TestIntegration123!';

function joinUrl(base: string, path: string): string {
  return new URL(path, base).toString();
}

async function getOidcEndSessionEndpoint(base: string): Promise<string> {
  const discoveryResponse = await fetch(joinUrl(base, '.well-known/openid-configuration'), {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
    },
  });

  if (discoveryResponse.ok) {
    const discovery = await discoveryResponse.json() as { end_session_endpoint?: string };
    if (discovery.end_session_endpoint) {
      return discovery.end_session_endpoint;
    }
  }

  return joinUrl(base, '.oidc/session/end');
}

interface CookieResponse {
  headers?: {
    getSetCookie?: () => string[];
    get?: (name: string) => string | null;
  };
}

function parseSetCookies(response: CookieResponse): Record<string, string> {
  const cookies: Record<string, string> = {};
  const cookieStrings = typeof response.headers?.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : (() => {
        const setCookieHeader = response.headers?.get?.('set-cookie');
        return setCookieHeader ? [ setCookieHeader ] : [];
      })();

  for (const cookieStr of cookieStrings) {
    const nameValue = cookieStr.split(';', 1)[0];
    const separatorIndex = nameValue.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }
    const name = nameValue.slice(0, separatorIndex).trim();
    const value = nameValue.slice(separatorIndex + 1).trim();
    if (name) {
      cookies[name] = value;
    }
  }

  return cookies;
}

function applySetCookies(
  baseCookies: Record<string, string>,
  response: CookieResponse,
): Record<string, string> {
  const nextCookies = { ...baseCookies };
  for (const [name, value] of Object.entries(parseSetCookies(response))) {
    if (value === '' || value === 'deleted') {
      delete nextCookies[name];
      continue;
    }
    nextCookies[name] = value;
  }
  return nextCookies;
}

function buildCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function parseHtmlForm(html: string): { action: string; fields: Record<string, string> } | undefined {
  const formMatch = html.match(/<form[^>]*action="([^"]+)"[^>]*>/i);
  if (!formMatch) {
    return undefined;
  }

  const fields: Record<string, string> = {};
  const inputRegex = /<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/gi;
  for (const match of html.matchAll(inputRegex)) {
    fields[match[1]] = match[2];
  }

  return {
    action: formMatch[1],
    fields,
  };
}

// Use CSS Identity Provider API endpoints discovered from /.account/ controls
const shouldRunIntegration = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
const suite = shouldRunIntegration ? describe : describe.skip;

suite('Server Mode Login Integration', () => {
  let sessionCookies: Record<string, string> = {};
  let accountToken: string;
  let loginUrl: string;
  let passwordCreateUrl: string;
  let registeredAccountId: string;

  type Controls = { password: { login: string; create?: string } };
  const tokenHeaders = (token: string) => ({ Authorization: `CSS-Account-Token ${token}` });
  const postJson = (url: string, body: object, token?: string) => fetch(url, {
    method: 'POST', redirect: 'manual',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? tokenHeaders(token) : {}) },
    body: JSON.stringify(body),
  });
  const accountIdFromControl = (url: string): string => {
    // CSS encodes the authoritative Account ID in its account-scoped control.
    const match = /\/account\/([^/]+)\/login\/password\/$/u.exec(new URL(url).pathname);
    expect(match).not.toBeNull();
    return decodeURIComponent(match![1]);
  };
  async function getControls(headers: Record<string, string> = {}): Promise<Controls> {
    const response = await fetch(joinUrl(baseUrl, '.account/'), {
      headers: { Accept: 'application/json', ...headers },
    });
    expect(response.status).toBe(200);
    return (await response.json() as { controls: Controls }).controls;
  }
  async function assertAccountSession(headers: Record<string, string>): Promise<void> {
    const controls = await getControls(headers);
    expect(controls.password.create).toBe(passwordCreateUrl);
    expect(accountIdFromControl(controls.password.create!)).toBe(registeredAccountId);
    const protectedResponse = await fetch(controls.password.create!, {
      headers: { Accept: 'application/json', ...headers },
    });
    expect(protectedResponse.status).toBe(200);
    const account = await protectedResponse.json() as { passwordLogins: Record<string, string> };
    expect(account.passwordLogins[testEmail]).toBeTypeOf('string');
  }
  async function assertRejectedLogin(email: string, password: string): Promise<void> {
    const response = await postJson(loginUrl, { email, password });
    expect(response.status).toBe(403);
    const failure = await response.json();
    expect(failure.authorization).toBeUndefined();
    expect(failure.token).toBeUndefined();
    expect(JSON.stringify(failure)).toMatch(/invalid email\/password combination/i);
    const cookies = parseSetCookies(response);
    expect(Object.values(cookies).filter(Boolean)).toEqual([]);
    const protectedResponse = await fetch(passwordCreateUrl, {
      headers: { Accept: 'application/json', Cookie: buildCookieHeader(cookies) },
    });
    expect(protectedResponse.status).toBe(401);
  }

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
  });

  describe('Identity HTML Routes', () => {
    const htmlRoutes = [
      '.account/',
      '.account/login/',
      '.account/login/password/',
      '.account/login/password/register/',
      '.account/login/password/forgot/',
      '.account/oidc/consent/',
    ];

    it('serves HTML for identity pages', async () => {
      for (const route of htmlRoutes) {
        const response = await fetch(joinUrl(baseUrl, route), {
          method: 'GET',
          headers: { 'Accept': 'text/html' },
        });

        expect([200, 302, 401, 403]).toContain(response.status);

        if (response.status === 200) {
          const contentType = response.headers.get('content-type') ?? '';
          expect(contentType).toMatch(/text\/html/);
          const html = await response.text();
          expect(html).toMatch(/<div id=\"root\"><\/div>/);
        }
      }
    });
  });

  describe('Account Registration', () => {
    it('gets account creation controls', async () => {
      const controls = await getControls();
      loginUrl = controls.password.login;
      expect(loginUrl).toBeTypeOf('string');
      expect(controls.password.create).toBeUndefined();
      const response = await fetch(joinUrl(baseUrl, '.account/account/'), {
        headers: { Accept: 'application/json' },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toHaveProperty('controls');
    });

    it('creates a new account via JSON API', async () => {
      const created = await postJson(joinUrl(baseUrl, '.account/account/'), {});
      expect(created.status).toBe(200);
      const result = await created.json();
      expect(result.authorization).toBeTypeOf('string');
      expect(result.authorization.length).toBeGreaterThan(0);
      accountToken = result.authorization;
      const controls = await getControls(tokenHeaders(accountToken));
      expect(controls.password.create).toBeTypeOf('string');
      passwordCreateUrl = controls.password.create!;
      registeredAccountId = accountIdFromControl(passwordCreateUrl);
      const registered = await postJson(passwordCreateUrl, { email: testEmail, password: testPassword }, accountToken);
      expect(registered.status).toBe(200);
      const registration = await registered.json();
      expect(registration.resource).toBeTypeOf('string');
      await assertAccountSession(tokenHeaders(accountToken));
    });

    it('rejects duplicate email registration', async () => {
      const created = await postJson(joinUrl(baseUrl, '.account/account/'), {});
      expect(created.status).toBe(200);
      const secondAccount = await created.json();
      expect(secondAccount.authorization).toBeTypeOf('string');
      const secondHeaders = tokenHeaders(secondAccount.authorization);
      const secondControls = await getControls(secondHeaders);
      expect(secondControls.password.create).toBeTypeOf('string');
      const secondPasswordUrl = secondControls.password.create!;
      expect(accountIdFromControl(secondPasswordUrl)).not.toBe(registeredAccountId);
      const response = await postJson(secondPasswordUrl, { email: testEmail, password: testPassword }, secondAccount.authorization);
      expect(response.status).toBe(400);
      const failure = await response.json();
      expect(JSON.stringify(failure)).toMatch(/already.*login.*e-mail/i);
      expect(failure.resource).toBeUndefined();
      expect(failure.authorization).toBeUndefined();
      expect(Object.values(parseSetCookies(response)).filter(Boolean)).toEqual([]);
      const secondPasswords = await fetch(secondPasswordUrl, { headers: { Accept: 'application/json', ...secondHeaders } });
      expect(secondPasswords.status).toBe(200);
      expect((await secondPasswords.json()).passwordLogins).toEqual({});
      await assertAccountSession(tokenHeaders(accountToken));
    });
  });

  describe('Account Login', () => {
    it('gets login controls', async () => {
      const controls = await getControls();
      expect(controls.password.login).toBe(loginUrl);
      const response = await fetch(loginUrl, { headers: { Accept: 'application/json' } });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/application\/json/);
      expect(await response.json()).toHaveProperty('controls');
    });

    it('authenticates with correct credentials via JSON API', async () => {
      const response = await postJson(loginUrl, { email: testEmail, password: testPassword });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.authorization).toBeTypeOf('string');
      expect(result.authorization.length).toBeGreaterThan(0);
      accountToken = result.authorization;
      sessionCookies = parseSetCookies(response);
      expect(Object.values(sessionCookies)).toContain(accountToken);
      await assertAccountSession(tokenHeaders(accountToken));
      await assertAccountSession({ Cookie: buildCookieHeader(sessionCookies) });
    });

    it('rejects incorrect password', async () => {
      await assertRejectedLogin(testEmail, 'wrong-password');
    });

    it('rejects non-existent email', async () => {
      await assertRejectedLogin(`missing-${testEmail}`, testPassword);
    });
  });

  describe('Authenticated Sessions', () => {
    it('accesses protected resources with session', async () => {
      const anonymous = await fetch(passwordCreateUrl, { headers: { Accept: 'application/json' } });
      expect(anonymous.status).toBe(401);
      await assertAccountSession({ Cookie: buildCookieHeader(sessionCookies) });
    });

    it('maintains session across requests', async () => {
      await assertAccountSession({ Cookie: buildCookieHeader(sessionCookies) });
      await assertAccountSession(tokenHeaders(accountToken));
      await assertAccountSession({ Cookie: buildCookieHeader(sessionCookies) });
    });
  });

  describe('Account Management', () => {
    it('changes password when authenticated', async () => {
      const newPassword = 'NewTestPassword456!';
      
      // First get the change password form to extract any CSRF tokens
      const getForm = await fetch(joinUrl(baseUrl, 'idp/credentials/password/'), {
        method: 'GET',
        headers: {
          'Accept': 'text/html',
          'Cookie': buildCookieHeader(sessionCookies),
        },
      });

      if (getForm.status === 200) {
        const formData = new URLSearchParams({
          oldPassword: testPassword,
          newPassword: newPassword,
          confirmPassword: newPassword,
        });

        const response = await fetch(joinUrl(baseUrl, 'idp/credentials/password/'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'text/html',
            'Cookie': buildCookieHeader(sessionCookies),
          },
          body: formData,
        });

        // Should succeed or redirect
        expect([200, 302, 303]).toContain(response.status);
        
        // Update test password for cleanup
        if ([200, 302, 303].includes(response.status)) {
          // Verify we can login with new password
          const loginData = new URLSearchParams({
            email: testEmail,
            password: newPassword,
            login: 'login',
          });

          const loginResponse = await fetch(joinUrl(baseUrl, 'idp/auth/'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: loginData,
            redirect: 'manual',
          });

          expect([302, 303]).toContain(loginResponse.status);
        }
      }
    });
  });

  describe('Logout', () => {
    it('logs out and invalidates session', async () => {
      const endSessionEndpoint = await getOidcEndSessionEndpoint(baseUrl);
      const logoutPage = await fetch(endSessionEndpoint, {
        method: 'GET',
        headers: {
          'Cookie': buildCookieHeader(sessionCookies),
          'Accept': 'text/html',
        },
        redirect: 'manual',
      });

      expect([200, 302, 303, 401]).toContain(logoutPage.status);

      let logoutResponse = logoutPage;
      let postLogoutCookies = applySetCookies(sessionCookies, logoutPage);

      if (logoutPage.status === 200) {
        const html = await logoutPage.text();
        const logoutForm = parseHtmlForm(html);
        expect(logoutForm).toBeTruthy();

        const formData = new URLSearchParams(logoutForm?.fields ?? {});
        if (!formData.has('logout')) {
          formData.set('logout', 'yes');
        }

        logoutResponse = await fetch(logoutForm!.action, {
          method: 'POST',
          headers: {
            'Cookie': buildCookieHeader(postLogoutCookies),
            'Accept': 'text/html',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formData,
          redirect: 'manual',
        });

        expect([200, 302, 303]).toContain(logoutResponse.status);
        postLogoutCookies = applySetCookies(postLogoutCookies, logoutResponse);
      }

      const cookies = parseSetCookies(logoutResponse);
      const clearedCookies = Object.entries(cookies).some(([, value]) =>
        value === '' || value === 'deleted' || value.includes('expires')
      );

      if ([200, 302, 303].includes(logoutResponse.status) || clearedCookies) {
        // Re-open logout flow. Without a session, OIDC should render the
        // auto-submit branch that includes logout=yes.
        const postLogoutPage = await fetch(endSessionEndpoint, {
          method: 'GET',
          headers: {
            'Cookie': buildCookieHeader(postLogoutCookies),
            'Accept': 'text/html',
          },
          redirect: 'manual',
        });

        expect([200, 302, 303]).toContain(postLogoutPage.status);

        if (postLogoutPage.status === 200) {
          const html = await postLogoutPage.text();
          const logoutForm = parseHtmlForm(html);
          expect(logoutForm).toBeTruthy();
          expect(logoutForm?.fields.logout).toBe('yes');
        }
      }
    });
  });
});
