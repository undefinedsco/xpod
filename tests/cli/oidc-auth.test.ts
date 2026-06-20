import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalHome = process.env.HOME;
const originalSolidHome = process.env.SOLID_HOME;
const originalUserProfile = process.env.USERPROFILE;

let testRoot: string;
let testHome: string;
let solidHome: string;
let refreshTimeout: ReturnType<typeof setTimeout> | undefined;
let tokenListener: ((tokenSet: any) => void) | undefined;

function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

function writeOidcStorage(key: string, value: unknown): void {
  const dir = join(solidHome, 'auth', 'oidc-storage');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, encodeURIComponent(key)), typeof value === 'string' ? value : JSON.stringify(value), 'utf-8');
}

beforeEach(() => {
  testRoot = join(process.cwd(), '.test-data', `cli-oidc-auth-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  testHome = join(testRoot, 'home');
  solidHome = join(testRoot, 'solid-home');
  mkdirSync(testHome, { recursive: true });
  mkdirSync(solidHome, { recursive: true });
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  process.env.SOLID_HOME = solidHome;
  refreshTimeout = undefined;
  tokenListener = undefined;
  vi.resetModules();
  vi.doUnmock('@inrupt/solid-client-authn-node');
});

afterEach(() => {
  if (refreshTimeout) clearTimeout(refreshTimeout);
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

describe('OIDC OAuth token refresh', () => {
  it('disposes the one-shot refresh timer so CLI read commands can exit after stdout completes', async () => {
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

    const session = {
      info: {
        isLoggedIn: true,
        webId: 'https://id.undefineds.co/gcloud/profile/card#me',
      },
      events: {
        on: vi.fn((_event: string, listener: (tokenSet: any) => void) => {
          tokenListener = listener;
        }),
        off: vi.fn((_event: string, listener: (tokenSet: any) => void) => {
          if (tokenListener === listener) tokenListener = undefined;
        }),
      },
    };
    const getSessionFromStorage = vi.fn(async () => session);
    const refreshSession = vi.fn(async () => {
      refreshTimeout = setTimeout(() => undefined, 60_000);
      (session as any).lastTimeoutHandle = refreshTimeout;
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

    const { getOidcAccessToken } = await import('../../src/cli/lib/oidc-auth');

    await expect(getOidcAccessToken(JSON.parse(readFileSync(join(solidHome, 'auth', 'credentials.json'), 'utf-8')))).resolves
      .toBe('new-access');
    expect(refreshSession).toHaveBeenCalled();
    expect(refreshTimeout).toBeDefined();
    expect((refreshTimeout as any)?._destroyed).toBe(true);
    expect(session.events.off).toHaveBeenCalledWith('newTokens', expect.any(Function));
  });
});
