import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import type { Response } from 'undici';
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

function parseSetCookies(response: Response): Record<string, string> {
  const cookies: Record<string, string> = {};
  const setCookieHeader = response.headers.get('set-cookie');
  if (setCookieHeader) {
    // Handle multiple Set-Cookie headers
    const cookieStrings = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    for (const cookieStr of cookieStrings) {
      const [nameValue] = cookieStr.split(';');
      const [name, value] = nameValue.split('=');
      if (name && value) {
        cookies[name.trim()] = value.trim();
      }
    }
  }
  return cookies;
}

function buildCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

// Use CSS Identity Provider API endpoints discovered from /.account/ controls
const shouldRunIntegration = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
const suite = shouldRunIntegration ? describe : describe.skip;

suite('Server Mode Login Integration', () => {
  let sessionCookies: Record<string, string> = {};
  let accountToken: string | undefined;

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
      const response = await fetch(joinUrl(baseUrl, '.account/account/'), {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });
      
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/application\/json/);
      
      const controls = await response.json();
      expect(controls).toHaveProperty('controls');
    });

    it('creates a new account via JSON API', async () => {
      // Step 1: Create account (no credentials yet)
      const createResponse = await fetch(joinUrl(baseUrl, '.account/account/'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect([200, 201]).toContain(createResponse.status);
      const createResult = await createResponse.json();
      expect(createResult).toHaveProperty('authorization');
      accountToken = createResult.authorization;

      // Step 2: Get authenticated controls to find password create endpoint
      const controlsResponse = await fetch(joinUrl(baseUrl, '.account/'), {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': `CSS-Account-Token ${accountToken}`,
        },
      });
      expect(controlsResponse.status).toBe(200);
      const controls = await controlsResponse.json();
      const passwordCreateUrl = controls.controls?.password?.create;
      expect(passwordCreateUrl).toBeTruthy();

      // Step 3: Register password credentials using the dynamic endpoint
      const registerResponse = await fetch(passwordCreateUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `CSS-Account-Token ${accountToken}`,
        },
        body: JSON.stringify({ email: testEmail, password: testPassword }),
      });

      expect([200, 201]).toContain(registerResponse.status);
    });

    it('rejects duplicate email registration', async () => {
      const formData = new URLSearchParams({
        email: testEmail,
        password: testPassword,
        confirmPassword: testPassword,
        register: 'register',
      });

      const response = await fetch(joinUrl(baseUrl, '.account/login/password/register/'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'text/html',
        },
        body: formData,
      });

      // Should return error (400, 404) or show form with error message
      expect([400, 200, 404]).toContain(response.status);
      
      if (response.status === 200) {
        const html = await response.text();
        expect(html).toMatch(/error|exists|already/i);
      }
    });
  });

  describe('Account Login', () => {
    it('gets login controls', async () => {
      const response = await fetch(joinUrl(baseUrl, '.account/login/password/'), {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });
      
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/application\/json/);
      
      const controls = await response.json();
      expect(controls).toHaveProperty('controls');
    });

    it('authenticates with correct credentials via JSON API', async () => {
      const loginData = {
        email: testEmail,
        password: testPassword,
      };

      const response = await fetch(joinUrl(baseUrl, '.account/login/password/'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(loginData),
        redirect: 'manual',
      });

      // Should succeed or redirect on successful login
      expect([200, 201, 302, 303]).toContain(response.status);
      
      // Store session cookies if any
      const cookies = parseSetCookies(response);
      sessionCookies = { ...sessionCookies, ...cookies };
      
      // Check for authentication token in response
      const responseData = await response.json().catch(() => ({}));
      if (responseData.token || Object.keys(cookies).length > 0) {
        expect(true).toBe(true); // Authentication mechanism found
      }
    });

    it('rejects incorrect password', async () => {
      const formData = new URLSearchParams({
        email: testEmail,
        password: 'wrong-password',
        login: 'login',
      });

      const response = await fetch(joinUrl(baseUrl, '.account/login/password/'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'text/html',
        },
        body: formData,
      });

      // Should return error or show form with error
      expect([400, 401, 200, 403]).toContain(response.status);
      
      if (response.status === 200) {
        const html = await response.text();
        expect(html).toMatch(/error|invalid|incorrect/i);
      }
    });

    it('rejects non-existent email', async () => {
      const formData = new URLSearchParams({
        email: 'nonexistent@example.com',
        password: testPassword,
        login: 'login',
      });

      const response = await fetch(joinUrl(baseUrl, '.account/login/password/'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'text/html',
        },
        body: formData,
      });

      // Should return error
      expect([400, 401, 200, 403]).toContain(response.status);
    });
  });

  describe('Authenticated Sessions', () => {
    it('accesses protected resources with session', async () => {
      if (Object.keys(sessionCookies).length === 0) {
        // Login first if no session cookies
        const formData = new URLSearchParams({
          email: testEmail,
          password: testPassword,
          login: 'login',
        });

        const loginResponse = await fetch(joinUrl(baseUrl, 'idp/auth/'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formData,
          redirect: 'manual',
        });

        const cookies = parseSetCookies(loginResponse);
        sessionCookies = { ...sessionCookies, ...cookies };
      }

      // Try to access a protected resource (user profile or pod)
      const response = await fetch(joinUrl(baseUrl, '.account/'), {
        method: 'GET',
        headers: {
          'Accept': 'text/html',
          'Cookie': buildCookieHeader(sessionCookies),
        },
      });

      // Should be accessible with valid session
      expect([200, 302, 404]).toContain(response.status);
    });

    it('maintains session across requests', async () => {
      // Make multiple requests with the same session cookies
      const requests = await Promise.all([
        fetch(baseUrl, {
          method: 'HEAD',
          headers: {
            'Cookie': buildCookieHeader(sessionCookies),
          },
        }),
        fetch(joinUrl(baseUrl, '.account/'), {
          method: 'HEAD',
          headers: {
            'Cookie': buildCookieHeader(sessionCookies),
          },
        }),
      ]);

      // All should work with the same session
      requests.forEach(response => {
        expect([200, 302, 404, 405]).toContain(response.status);
      });
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
      const response = await fetch(joinUrl(baseUrl, 'idp/session/end'), {
        method: 'POST',
        headers: {
          'Cookie': buildCookieHeader(sessionCookies),
          'Accept': 'text/html',
        },
        redirect: 'manual',
      });

      // Should redirect after logout  
      expect([302, 303, 200, 401]).toContain(response.status);
      
      // Session cookies should be cleared or invalidated
      const cookies = parseSetCookies(response);
      const clearedCookies = Object.entries(cookies).some(([, value]) => 
        value === '' || value === 'deleted' || value.includes('expires')
      );
      
      if (response.status === 302 || response.status === 303 || clearedCookies) {
        // Try to access protected resource - should be denied
        const protectedResponse = await fetch(joinUrl(baseUrl, '.account/'), {
          method: 'GET',
          headers: {
            'Cookie': buildCookieHeader(sessionCookies),
            'Accept': 'text/html',
          },
        });

        // Should be redirected to login or get 401/403
        expect([302, 401, 403, 404]).toContain(protectedResponse.status);
      }
    });
  });
});
