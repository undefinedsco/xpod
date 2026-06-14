import { execFileSync } from 'node:child_process';
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

function setIsolatedAuthHome(): void {
  testRoot = join(process.cwd(), '.test-data', `cli-auth-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  testHome = join(testRoot, 'home');
  solidHome = join(testRoot, 'solid-home');
  mkdirSync(testHome, { recursive: true });
  mkdirSync(solidHome, { recursive: true });
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  process.env.SOLID_HOME = solidHome;
  vi.resetModules();
}

function restoreEnv(): void {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalSolidHome === undefined) delete process.env.SOLID_HOME;
  else process.env.SOLID_HOME = originalSolidHome;
}

beforeEach(() => {
  setIsolatedAuthHome();
});

afterEach(() => {
  restoreEnv();
  vi.resetModules();
  if (testRoot) {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

describe('CLI shared Solid auth credentials store', () => {
  it('resolves credentials under SOLID_HOME/auth', async () => {
    const store = await import('../../src/cli/lib/credentials-store');

    expect(store.getSolidHomeDir()).toBe(solidHome);
    expect(store.getSolidAuthDir()).toBe(join(solidHome, 'auth'));
    expect(store.getSolidCredentialsPath()).toBe(join(solidHome, 'auth', 'credentials.json'));
  });

  it('saves and loads client credentials from the shared Solid auth store', async () => {
    const store = await import('../../src/cli/lib/credentials-store');

    store.saveCredentials({
      url: 'https://id.undefineds.co/',
      webId: 'https://id.undefineds.co/gcloud/profile/card#me',
      authType: 'client_credentials',
      secrets: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
      },
    });

    expect(existsSync(join(solidHome, 'auth', 'credentials.json'))).toBe(true);
    expect(existsSync(join(testHome, '.xpod', 'config.json'))).toBe(false);
    expect(store.loadCredentials()).toEqual({
      url: 'https://id.undefineds.co/',
      webId: 'https://id.undefineds.co/gcloud/profile/card#me',
      authType: 'client_credentials',
      secrets: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
      },
    });
  });

  it('uses shared Solid auth as the only credential source for all Solid apps', async () => {
    writeJson(join(testHome, '.xpod', 'config.json'), {
      url: 'http://localhost:3000/',
      webId: 'http://localhost:3000/test/profile/card#me',
      authType: 'client_credentials',
    });
    writeJson(join(testHome, '.xpod', 'secrets.json'), {
      clientId: 'app-local-client',
      clientSecret: 'app-local-secret',
    });
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

    const store = await import('../../src/cli/lib/credentials-store');
    const authContext = await import('../../src/cli/lib/auth-context');

    expect(store.loadCredentials()).toMatchObject({
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
    expect(authContext.getStoredAuthStatus()).toMatchObject({
      authenticated: true,
      authType: 'oidc_oauth',
      baseUrl: 'https://id.undefineds.co/',
      webId: 'https://id.undefineds.co/gcloud/profile/card#me',
      podRoot: 'https://id.undefineds.co/gcloud/',
    });
  });

  it('does not authenticate from app-local .xpod files when shared Solid auth is absent', async () => {
    writeJson(join(testHome, '.xpod', 'config.json'), {
      url: 'http://localhost:3000/',
      webId: 'http://localhost:3000/test/profile/card#me',
      authType: 'client_credentials',
    });
    writeJson(join(testHome, '.xpod', 'secrets.json'), {
      clientId: 'app-local-client',
      clientSecret: 'app-local-secret',
    });

    const store = await import('../../src/cli/lib/credentials-store');
    const authContext = await import('../../src/cli/lib/auth-context');

    expect(store.loadCredentials()).toBeNull();
    expect(authContext.getStoredAuthStatus()).toEqual({ authenticated: false });
  });


  it('reports unauthenticated through `xpod auth status --json` when only app-local .xpod files exist', () => {
    writeJson(join(testHome, '.xpod', 'config.json'), {
      url: 'http://localhost:3000/',
      webId: 'http://localhost:3000/test/profile/card#me',
      authType: 'client_credentials',
    });
    writeJson(join(testHome, '.xpod', 'secrets.json'), {
      clientId: 'app-local-client',
      clientSecret: 'app-local-secret',
    });

    const stdout = execFileSync('bun', [ 'src/cli/index.ts', 'auth', 'status', '--json' ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: testHome,
        USERPROFILE: testHome,
        SOLID_HOME: solidHome,
      },
      encoding: 'utf-8',
    });

    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      code: 'ok',
      data: {
        authenticated: false,
      },
    });
  });

  it('reports shared Solid auth through `xpod auth status --json`', () => {
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
    writeJson(join(testHome, '.xpod', 'config.json'), {
      url: 'http://localhost:3000/',
      webId: 'http://localhost:3000/test/profile/card#me',
      authType: 'client_credentials',
    });

    const stdout = execFileSync('bun', [ 'src/cli/index.ts', 'auth', 'status', '--json' ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: testHome,
        USERPROFILE: testHome,
        SOLID_HOME: solidHome,
      },
      encoding: 'utf-8',
    });

    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      code: 'ok',
      data: {
        authenticated: true,
        authType: 'oidc_oauth',
        baseUrl: 'https://id.undefineds.co/',
        webId: 'https://id.undefineds.co/gcloud/profile/card#me',
        podRoot: 'https://id.undefineds.co/gcloud/',
      },
    });
  });

  it('clears the shared Solid auth credential file without mutating app-local .xpod files', async () => {
    writeJson(join(solidHome, 'auth', 'credentials.json'), {
      url: 'https://id.undefineds.co/',
      webId: 'https://id.undefineds.co/gcloud/profile/card#me',
      authType: 'client_credentials',
      secrets: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
      },
    });
    writeJson(join(testHome, '.xpod', 'config.json'), { url: 'app-local' });

    const store = await import('../../src/cli/lib/credentials-store');
    store.clearCredentials();

    expect(existsSync(join(solidHome, 'auth', 'credentials.json'))).toBe(false);
    expect(readFileSync(join(testHome, '.xpod', 'config.json'), 'utf-8')).toContain('app-local');
  });
});
