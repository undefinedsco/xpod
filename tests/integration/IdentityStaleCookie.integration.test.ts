import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { XpodTestStack } from '../helpers/XpodTestStack';
import { getSqliteRuntime, type SqliteDatabase } from '../../src/storage/SqliteRuntime';

const shouldRunIntegration = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
const suite = shouldRunIntegration ? describe : describe.skip;

function parseSetCookieHeaders(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }

  const setCookie = response.headers.get('set-cookie');
  return setCookie ? [ setCookie ] : [];
}

function parseCookies(response: Response): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const cookieString of parseSetCookieHeaders(response)) {
    const nameValue = cookieString.split(';', 1)[0];
    const separator = nameValue.indexOf('=');
    if (separator === -1) {
      continue;
    }

    const name = nameValue.slice(0, separator).trim();
    const value = nameValue.slice(separator + 1).trim();
    if (name) {
      cookies[name] = value;
    }
  }
  return cookies;
}

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([ name, value ]) => `${name}=${value}`)
    .join('; ');
}

function findAccountIdForEmail(db: SqliteDatabase, email: string): string {
  const rows = db.prepare<{ key: string; value: string }>(`
    SELECT key, value
    FROM internal_kv
    WHERE key LIKE 'accounts/data/%'
  `).all().map((entry: any) => ({
    key: entry.key,
    value: JSON.parse(entry.value),
  }));

  for (const row of rows) {
    const passwords = row.value?.['**password**'];
    if (!passwords || typeof passwords !== 'object') {
      continue;
    }

    for (const passwordLogin of Object.values(passwords) as Array<Record<string, unknown>>) {
      if (passwordLogin.email === email && typeof passwordLogin.accountId === 'string') {
        return passwordLogin.accountId;
      }
    }
  }

  throw new Error(`Unable to find account id for ${email}`);
}

function deleteAccount(db: SqliteDatabase, accountId: string): void {
  db.prepare(`DELETE FROM internal_kv WHERE key = ?`).run(`accounts/data/${accountId}`);
}

suite('Identity stale account cookie recovery', () => {
  const runtimeRoot = path.resolve('.test-data/identity-stale-cookie', randomUUID());
  const identityDbPath = path.join(runtimeRoot, 'identity.sqlite');
  const stack = new XpodTestStack();
  let db: SqliteDatabase | undefined;

  beforeAll(async() => {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    await stack.start('local', {
      runtimeRoot,
      transport: 'port',
      identityDbUrl: identityDbPath,
      logLevel: 'warn',
    });
    db = getSqliteRuntime().openDatabase(identityDbPath);
  }, 60_000);

  afterAll(async() => {
    db?.close();
    await stack.stop();
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  it('clears a cookie when its account row disappeared and then allows account creation', async() => {
    const email = `stale-cookie-${Date.now()}@example.test`;
    const password = 'StaleCookie123!';

    const createAccountResponse = await stack.runtimeFetch(`${stack.baseUrl}.account/account/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(createAccountResponse.status).toBe(200);
    const { authorization } = await createAccountResponse.json() as { authorization: string };

    const controlsResponse = await stack.runtimeFetch(`${stack.baseUrl}.account/`, {
      headers: {
        accept: 'application/json',
        authorization: `CSS-Account-Token ${authorization}`,
      },
    });
    expect(controlsResponse.status).toBe(200);
    const controls = await controlsResponse.json() as { controls?: { password?: { create?: string }}};
    expect(controls.controls?.password?.create).toBeTruthy();

    const passwordResponse = await stack.runtimeFetch(controls.controls!.password!.create!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `CSS-Account-Token ${authorization}`,
      },
      body: JSON.stringify({ email, password }),
    });
    expect(passwordResponse.status).toBe(200);

    const loginResponse = await stack.runtimeFetch(`${stack.baseUrl}.account/login/password/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ email, password }),
    });
    expect(loginResponse.status).toBe(200);
    const loginCookies = parseCookies(loginResponse);
    expect(loginCookies['css-account']).toBeTruthy();

    const accountId = findAccountIdForEmail(db!, email);
    deleteAccount(db!, accountId);

    const staleResponse = await stack.runtimeFetch(`${stack.baseUrl}.account/`, {
      headers: {
        accept: 'application/json',
        cookie: cookieHeader(loginCookies),
      },
    });
    expect(staleResponse.status).toBe(200);
    expect(parseCookies(staleResponse)['css-account']).toBe(loginCookies['css-account']);
    expect(parseSetCookieHeaders(staleResponse).some((value) => value.toLowerCase().includes('expires=thu, 01 jan 1970'))).toBe(true);

    const freshCreateResponse = await stack.runtimeFetch(`${stack.baseUrl}.account/account/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        cookie: cookieHeader(loginCookies),
      },
      body: JSON.stringify({}),
    });
    expect(freshCreateResponse.status).toBe(200);
    const freshCreate = await freshCreateResponse.json() as { authorization?: string };
    expect(freshCreate.authorization).toBeTruthy();

    const freshControlsResponse = await stack.runtimeFetch(`${stack.baseUrl}.account/`, {
      headers: {
        accept: 'application/json',
        authorization: `CSS-Account-Token ${freshCreate.authorization}`,
        cookie: cookieHeader(loginCookies),
      },
    });
    expect(freshControlsResponse.status).toBe(200);
    const freshControls = await freshControlsResponse.json() as { controls?: { account?: { pod?: string }}};
    expect(freshControls.controls?.account?.pod).toBeTruthy();
  });
});
