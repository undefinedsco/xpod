import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const previousSolidHome = process.env.SOLID_HOME;
let directory: string;
let credentialsPath: string;
let now: number;
let issued: number;
let discovery: number;
let expiry: unknown;
let resourceStatus: number;
let delayTokens: boolean;
let releaseTokens: Array<() => void>;
let resourceCalls: Array<{ method: string; token: string | null }>;
let credentials: {
  url: string; webId: string; authType: string;
  secrets: { clientId: string; clientSecret: string };
};

function saveCredentials(): void {
  writeFileSync(credentialsPath, JSON.stringify(credentials), { mode: 0o600 });
}

beforeEach(() => {
  mkdirSync('.test-data', { recursive: true });
  directory = mkdtempSync(path.resolve('.test-data/client-token-cache-'));
  process.env.SOLID_HOME = directory;
  mkdirSync(path.join(directory, 'auth'));
  credentialsPath = path.join(directory, 'auth', 'credentials.json');
  credentials = {
    url: 'https://pod.example/', webId: 'https://pod.example/alice/profile/card#me',
    authType: 'client_credentials', secrets: { clientId: 'fixture-client', clientSecret: 'fixture-secret' },
  };
  saveCredentials();
  now = Date.UTC(2026, 9, 2);
  issued = 0; discovery = 0; expiry = 120; resourceStatus = 200;
  delayTokens = false; releaseTokens = []; resourceCalls = [];
  vi.resetModules();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/.well-known/openid-configuration')) {
      discovery += 1;
      return Response.json({ token_endpoint: new URL('.oidc/token', credentials.url).href });
    }
    if (url.pathname.endsWith('/.oidc/token')) {
      const token = `fixture-token-${++issued}`;
      if (delayTokens) { await new Promise<void>((resolve) => releaseTokens.push(resolve)); }
      return Response.json({ access_token: token, ...(expiry === undefined ? {} : { expires_in: expiry }) });
    }
    resourceCalls.push({ method: init?.method ?? 'GET', token: new Headers(init?.headers).get('authorization') });
    return new Response('fixture resource', { status: resourceStatus });
  }));
});

afterEach(() => {
  if (previousSolidHome === undefined) { delete process.env.SOLID_HOME; }
  else { process.env.SOLID_HOME = previousSolidHome; }
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules();
  rmSync(directory, { recursive: true, force: true });
});

describe('client-credential tokens in a long-lived CLI process', () => {
  it('reuses a valid token while each file request still reaches the server', async () => {
    const { requireAuthContext, authFetch } = await import('../../packages/xpod-cli/src/lib/auth-context');
    for (let n = 0; n < 3; n += 1) {
      await authFetch(await requireAuthContext(), `https://pod.example/alice/file-${n}`, { method: 'HEAD' });
    }
    expect({ issued, discovery, resources: resourceCalls.length }).toEqual({ issued: 1, discovery: 1, resources: 3 });
  });

  it('shares one exchange across concurrent requests and concurrent forced refreshes', async () => {
    const { requireAuthContext } = await import('../../packages/xpod-cli/src/lib/auth-context');
    const initial = await Promise.all([requireAuthContext(), requireAuthContext(), requireAuthContext()]);
    expect(initial.map((context) => context.accessToken)).toEqual(Array(3).fill('fixture-token-1'));
    const refreshed = await Promise.all(Array.from({ length: 3 }, () => requireAuthContext({ forceRefresh: true })));
    expect(refreshed.map((context) => context.accessToken)).toEqual(Array(3).fill('fixture-token-2'));
    expect(issued).toBe(2);
  });

  it('refreshes within sixty seconds of the advertised expiry', async () => {
    const { requireAuthContext } = await import('../../packages/xpod-cli/src/lib/auth-context');
    await requireAuthContext(); now += 59_000; await requireAuthContext();
    expect(issued).toBe(1);
    now += 2_000;
    expect((await requireAuthContext()).accessToken).toBe('fixture-token-2');
  });

  it.each([undefined, 0, -1, '120', Number.MAX_VALUE])('does not assume a reusable lifetime for expires_in=%s', async (value) => {
    expiry = value;
    const { requireAuthContext } = await import('../../packages/xpod-cli/src/lib/auth-context');
    await requireAuthContext(); await requireAuthContext();
    expect(issued).toBe(2);
  });

  it('invalidates the active cache for changed secret, issuer and WebID', async () => {
    const { requireAuthContext } = await import('../../packages/xpod-cli/src/lib/auth-context');
    await requireAuthContext();
    credentials.secrets.clientSecret = 'different-fixture-secret'; saveCredentials(); await requireAuthContext();
    credentials.url = 'https://other.example/issuer/'; saveCredentials(); await requireAuthContext();
    credentials.webId = 'https://other.example/bob/profile/card#me'; saveCredentials();
    expect((await requireAuthContext()).webId).toBe(credentials.webId);
    expect(issued).toBe(4);
  });

  it('does not restore a usable context when logout occurs during an exchange', async () => {
    const { requireAuthContext } = await import('../../packages/xpod-cli/src/lib/auth-context');
    delayTokens = true;
    const pending = requireAuthContext();
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(releaseTokens).toHaveLength(1));
    rmSync(credentialsPath); releaseTokens[0]();
    await rejected;
    await expect(requireAuthContext()).rejects.toThrow();
    saveCredentials(); delayTokens = false;
    expect((await requireAuthContext()).accessToken).toBe('fixture-token-2');
  });

  it('does not let a late exchange overwrite the newly selected credential token', async () => {
    const { requireAuthContext } = await import('../../packages/xpod-cli/src/lib/auth-context');
    delayTokens = true;
    const old = requireAuthContext(); const oldRejected = expect(old).rejects.toThrow();
    await vi.waitFor(() => expect(releaseTokens).toHaveLength(1));
    credentials.secrets.clientSecret = 'new-fixture-secret'; saveCredentials(); delayTokens = false;
    expect((await requireAuthContext()).accessToken).toBe('fixture-token-2');
    releaseTokens[0](); await oldRejected;
    expect((await requireAuthContext()).accessToken).toBe('fixture-token-2');
    expect(issued).toBe(2);
  });

  it('allows a subsequent exchange after a transient failure', async () => {
    const { requireAuthContext } = await import('../../packages/xpod-cli/src/lib/auth-context');
    vi.mocked(fetch).mockRejectedValueOnce(new Error('fixture network failure'));
    await expect(requireAuthContext()).rejects.toThrow();
    await requireAuthContext(); await requireAuthContext();
    expect(issued).toBe(1);
  });

  it.each(['GET', 'PUT', 'DELETE'])('invalidates a rejected %s token without replaying the resource request', async (method) => {
    const { requireAuthContext, authFetch } = await import('../../packages/xpod-cli/src/lib/auth-context');
    const context = await requireAuthContext(); resourceStatus = 401;
    expect((await authFetch(context, 'https://pod.example/alice/file', { method })).status).toBe(401);
    expect(resourceCalls).toHaveLength(1);
    resourceStatus = 200;
    expect((await requireAuthContext()).accessToken).toBe('fixture-token-2');
  });

  it('keeps permission failures cached and ignores a late 401 for an older token', async () => {
    const { requireAuthContext, authFetch } = await import('../../packages/xpod-cli/src/lib/auth-context');
    const old = await requireAuthContext(); resourceStatus = 403;
    await authFetch(old, 'https://pod.example/alice/private'); await requireAuthContext();
    expect(issued).toBe(1);
    await requireAuthContext({ forceRefresh: true }); resourceStatus = 401;
    await authFetch(old, 'https://pod.example/alice/file');
    expect((await requireAuthContext()).accessToken).toBe('fixture-token-2');
    expect(issued).toBe(2);
  });
});
