import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalHome = process.env.HOME;
const originalSolidHome = process.env.SOLID_HOME;
const originalUserProfile = process.env.USERPROFILE;

let testRoot: string;
let testHome: string;
let solidHome: string;

function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

function writeOidcStorage(key: string, value: unknown): void {
  const dir = join(solidHome, 'auth', 'oidc-storage');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, encodeURIComponent(key)), typeof value === 'string' ? value : JSON.stringify(value), 'utf-8');
}

function readCredentials(): any {
  return JSON.parse(readFileSync(join(solidHome, 'auth', 'credentials.json'), 'utf-8'));
}

beforeEach(() => {
  testRoot = join(process.cwd(), '.test-data', `cli-auth-context-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  testHome = join(testRoot, 'home');
  solidHome = join(testRoot, 'solid-home');
  mkdirSync(testHome, { recursive: true });
  mkdirSync(solidHome, { recursive: true });
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  process.env.SOLID_HOME = solidHome;
  vi.resetModules();
  vi.doUnmock('@inrupt/solid-client-authn-node');
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalSolidHome === undefined) delete process.env.SOLID_HOME;
  else process.env.SOLID_HOME = originalSolidHome;
  vi.resetModules();
  vi.doUnmock('@inrupt/solid-client-authn-node');
  if (testRoot && existsSync(testRoot)) {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

describe('CLI resource auth context', () => {
  it('uses an unexpired shared OAuth access token for resource operations', async () => {
    writeJson(join(solidHome, 'auth', 'credentials.json'), {
      url: 'https://id.undefineds.co/',
      webId: 'https://id.undefineds.co/gcloud/profile/card#me',
      authType: 'oidc_oauth',
      secrets: {
        oidcRefreshToken: 'refresh-token',
        oidcAccessToken: 'access-token',
        oidcExpiresAt: '2099-01-01T00:00:00.000Z',
        oidcClientId: 'oidc-client',
      },
    });

    const authContext = await import('../../src/cli/lib/auth-context');

    await expect(authContext.requireAuthContext()).resolves.toMatchObject({
      accessToken: 'access-token',
      webId: 'https://id.undefineds.co/gcloud/profile/card#me',
      podRoot: 'https://id.undefineds.co/gcloud/',
    });
  });

  it('refreshes an expired shared OAuth token through the shared OIDC session store', async () => {
    writeJson(join(solidHome, 'auth', 'credentials.json'), {
      url: 'https://id.undefineds.co/',
      webId: 'https://id.undefineds.co/gcloud/profile/card#me',
      authType: 'oidc_oauth',
      secrets: {
        oidcRefreshToken: 'old-refresh',
        oidcAccessToken: 'old-access',
        oidcExpiresAt: '2020-01-01T00:00:00.000Z',
        oidcClientId: 'old-client',
      },
    });
    writeOidcStorage('solidClientAuthn:registeredSessions', ['session-1']);
    writeOidcStorage('solidClientAuthenticationUser:session-1', {
      webId: 'https://id.undefineds.co/gcloud/profile/card#me',
      issuer: 'https://id.undefineds.co',
      dpop: false,
    });

    let tokenListener: ((tokenSet: any) => void) | undefined;
    const session = {
      info: {
        isLoggedIn: true,
        webId: 'https://id.undefineds.co/gcloud/profile/card#me',
      },
      events: {
        on: vi.fn((_event: string, listener: (tokenSet: any) => void) => {
          tokenListener = listener;
        }),
      },
    };
    const getSessionFromStorage = vi.fn(async () => session);
    const refreshSession = vi.fn(async () => {
      tokenListener?.({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: 4102444800,
        clientId: 'new-client',
      });
      return session;
    });

    vi.doMock('@inrupt/solid-client-authn-node', () => ({
      EVENTS: { NEW_TOKENS: 'newTokens' },
      getSessionFromStorage,
      refreshSession,
      Session: class Session {},
    }));

    const authContext = await import('../../src/cli/lib/auth-context');

    await expect(authContext.requireAuthContext()).resolves.toMatchObject({
      accessToken: 'new-access',
      webId: 'https://id.undefineds.co/gcloud/profile/card#me',
    });
    expect(getSessionFromStorage).toHaveBeenCalledWith('session-1', expect.objectContaining({
      refreshSession: false,
    }));
    expect(refreshSession).toHaveBeenCalled();
    expect(readCredentials()).toMatchObject({
      authType: 'oidc_oauth',
      secrets: {
        oidcRefreshToken: 'new-refresh',
        oidcAccessToken: 'new-access',
        oidcClientId: 'new-client',
      },
    });
  });
});
