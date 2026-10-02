// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SAFE_CONTINUATION_TTL_MS,
  clearConsentContinuation,
  clearManagementContinuation,
  confirmConsentInteractionAtAuthority,
  consumeConsentContinuation,
  consumeManagementContinuation,
  currentInteractionScope,
  isAccountReturnTo,
  isConsentReturnTo,
  isInteractionScope,
  peekConsentContinuation,
  readConfirmedConsentContinuation,
  readConsentContinuation,
  readManagementContinuation,
  resolveAuthoritativeAccountId,
  saveConsentContinuation,
  saveManagementContinuation,
} from './safe-continuation';
import type { ConsentContinuation } from './safe-continuation';

const INTERACTION = '/.account/interaction/flow-one';
const OTHER_INTERACTION = '/.account/interaction/flow-two';

const origin = () => window.location.origin;
const consentReturn = (interaction = INTERACTION) => `${origin()}${interaction}/oidc/consent/`;

function at(path: string) {
  window.history.replaceState({}, '', path);
}

beforeEach(() => {
  at(`${INTERACTION}/create-pod/`);
  clearConsentContinuation();
  clearManagementContinuation();
});

afterEach(() => {
  clearConsentContinuation();
  clearManagementContinuation();
  vi.restoreAllMocks();
});

describe('interaction scope and destinations', () => {
  it('reads the interaction scope from the server-routed page address', () => {
    at(`${INTERACTION}/create-pod/`);
    expect(currentInteractionScope()).toBe(INTERACTION);
    at(`${INTERACTION}/oidc/consent/`);
    expect(currentInteractionScope()).toBe(INTERACTION);
    at('/settings/pod');
    expect(currentInteractionScope()).toBeUndefined();
    expect(isInteractionScope(INTERACTION)).toBe(true);
    expect(isInteractionScope(`${INTERACTION}/oidc/consent/`)).toBe(false);
    expect(isInteractionScope('/.account/')).toBe(false);
  });

  it('only accepts the exact consent page of the same interaction on this origin', () => {
    at(`${INTERACTION}/oidc/consent/`);
    expect(isConsentReturnTo(INTERACTION, consentReturn())).toBe(true);
    expect(isConsentReturnTo(INTERACTION, consentReturn(OTHER_INTERACTION))).toBe(false);
    expect(isConsentReturnTo(INTERACTION, `${origin()}/settings/pod`)).toBe(false);
    expect(isConsentReturnTo(INTERACTION, 'https://evil.example/.account/interaction/flow-one/oidc/consent/')).toBe(false);
    expect(isConsentReturnTo(INTERACTION, '//evil.example/.account/interaction/flow-one/oidc/consent/')).toBe(false);
    expect(isConsentReturnTo(INTERACTION, `${INTERACTION}/oidc/consent/?next=https://evil.example`)).toBe(false);
    expect(isAccountReturnTo(`${origin()}/.account/account/`)).toBe(true);
    expect(isAccountReturnTo('https://evil.example/.account/account/')).toBe(false);
    expect(isAccountReturnTo(`${origin()}/settings/pod`)).toBe(false);
  });
});

describe('authoritative Account id (two Accounts, one issuer)', () => {
  const issuer = 'https://id.example/.account/';

  it('derives a different id per Account from the same issuer management routes', () => {
    const alice = {
      account: {
        id: undefined,
        logout: 'https://app.example/.account/account/alice/logout/',
        clientCredentials: 'https://app.example/.account/account/alice/client-credentials/',
      },
    };
    const bob = {
      account: {
        logout: 'https://app.example/.account/account/bob/logout/',
        clientCredentials: 'https://app.example/.account/account/bob/client-credentials/',
      },
    };
    // Same issuer/service address for both Accounts.
    expect(new URL(issuer).origin).toBe(new URL('https://id.example/.account/').origin);
    expect(resolveAuthoritativeAccountId(alice)).toBe('alice');
    expect(resolveAuthoritativeAccountId(bob)).toBe('bob');
    expect(resolveAuthoritativeAccountId(alice)).not.toBe(resolveAuthoritativeAccountId(bob));
  });

  it('aggregates every authoritative id source and fails closed when they disagree or are missing', () => {
    // Two different authoritative ids for one session is a contradiction: reject.
    expect(resolveAuthoritativeAccountId({ account: { id: 'explicit' } }, { id: 'identity' })).toBeUndefined();
    // A single source remains usable, including the advertised explicit id.
    expect(resolveAuthoritativeAccountId({ account: { id: 'explicit' } })).toBe('explicit');
    // identity.id and a route-derived id agree on the same Account.
    expect(resolveAuthoritativeAccountId(
      { account: { logout: 'https://app.example/.account/account/alice/logout/' } },
      { id: 'alice' },
    )).toBe('alice');
    expect(resolveAuthoritativeAccountId({
      account: {
        logout: 'https://app.example/.account/account/alice/logout/',
        pod: 'https://app.example/.account/account/bob/pod/',
      },
    })).toBeUndefined();
    // A control that is not an account-scoped management route carries no id.
    expect(resolveAuthoritativeAccountId({ account: { logout: 'https://id.example/logout/' } })).toBeUndefined();
    expect(resolveAuthoritativeAccountId({ account: { logout: 'https://user:pass@id.example/.account/account/alice/logout/' } })).toBeUndefined();
    expect(resolveAuthoritativeAccountId({ account: {} })).toBeUndefined();
    expect(resolveAuthoritativeAccountId(null, {})).toBeUndefined();
    // A username/WebID is never an Account id.
    expect(resolveAuthoritativeAccountId({ account: { id: undefined, pod: undefined } }, { id: undefined })).toBeUndefined();
  });
});

describe('consent continuation is bound to Account id + interaction', () => {
  it('distinguishes two Accounts that share one issuer', () => {
    at(`${INTERACTION}/oidc/consent/`);
    expect(saveConsentContinuation({ accountId: 'alice', interaction: INTERACTION, returnTo: consentReturn() })).toBe(true);

    expect(readConsentContinuation({ accountId: 'bob', interaction: INTERACTION })).toBeNull();
    // The mismatch also drops the record so nothing can pick it up later.
    expect(readConsentContinuation({ accountId: 'alice', interaction: INTERACTION })).toBeNull();
  });

  it('refuses to store or read without a non-empty authoritative Account id', () => {
    at(`${INTERACTION}/oidc/consent/`);
    expect(saveConsentContinuation({ accountId: '', interaction: INTERACTION, returnTo: consentReturn() })).toBe(false);
    expect(saveConsentContinuation({ accountId: '   ', interaction: INTERACTION, returnTo: consentReturn() })).toBe(false);
    expect(saveConsentContinuation({ accountId: 'alice', interaction: INTERACTION, returnTo: consentReturn() })).toBe(true);

    // No id: do not silently allow the stored record.
    expect(readConsentContinuation({ accountId: '', interaction: INTERACTION })).toBeNull();
    expect(readConsentContinuation({ accountId: 'alice', interaction: INTERACTION })).toBeNull();
  });

  it('rejects the same Account with a different pending interaction', () => {
    at(`${INTERACTION}/oidc/consent/`);
    saveConsentContinuation({ accountId: 'alice', interaction: INTERACTION, returnTo: consentReturn() });
    expect(readConsentContinuation({ accountId: 'alice', interaction: OTHER_INTERACTION })).toBeNull();
  });

  it('rejects a caller that re-uses the record interaction while the page is elsewhere', () => {
    at(`${INTERACTION}/oidc/consent/`);
    saveConsentContinuation({ accountId: 'alice', interaction: INTERACTION, returnTo: consentReturn() });
    at('/settings/pod');
    // Record matches, but the page's own routed scope does not: no resume.
    expect(readConsentContinuation({ accountId: 'alice', interaction: INTERACTION })).toBeNull();
  });

  it('keeps a still-valid task readable across a refresh but burns it exactly once', () => {
    at(`${INTERACTION}/create-pod/`);
    saveConsentContinuation({ accountId: 'alice', interaction: INTERACTION, returnTo: consentReturn() });
    expect(readConsentContinuation({ accountId: 'alice', interaction: INTERACTION })?.returnTo).toBe(consentReturn());
    expect(readConsentContinuation({ accountId: 'alice', interaction: INTERACTION })?.returnTo).toBe(consentReturn());
    expect(consumeConsentContinuation({ accountId: 'alice', interaction: INTERACTION })?.returnTo).toBe(consentReturn());
    expect(consumeConsentContinuation({ accountId: 'alice', interaction: INTERACTION })).toBeNull();
  });

  it('drops the task on Account switch, cancel and expiry', () => {
    at(`${INTERACTION}/create-pod/`);
    saveConsentContinuation({ accountId: 'alice', interaction: INTERACTION, returnTo: consentReturn() });
    // Account switch
    expect(readConsentContinuation({ accountId: 'bob', interaction: INTERACTION })).toBeNull();
    // Cancel clears it explicitly.
    saveConsentContinuation({ accountId: 'alice', interaction: INTERACTION, returnTo: consentReturn() });
    clearConsentContinuation();
    expect(readConsentContinuation({ accountId: 'alice', interaction: INTERACTION })).toBeNull();
    // Expiry
    saveConsentContinuation({ accountId: 'alice', interaction: INTERACTION, returnTo: consentReturn(), ttlMs: -1 });
    expect(readConsentContinuation({ accountId: 'alice', interaction: INTERACTION })).toBeNull();
  });

  it('rejects a TTL beyond the fixed internal cap', () => {
    at(`${INTERACTION}/create-pod/`);
    expect(saveConsentContinuation({
      accountId: 'alice', interaction: INTERACTION, returnTo: consentReturn(), ttlMs: SAFE_CONTINUATION_TTL_MS + 1,
    })).toBe(false);
    expect(saveConsentContinuation({
      accountId: 'alice', interaction: INTERACTION, returnTo: consentReturn(), ttlMs: Number.POSITIVE_INFINITY,
    })).toBe(false);
  });

  it('rejects a tampered or wrong-shaped stored record', () => {
    at(`${INTERACTION}/create-pod/`);
    const key = 'xpod.safe-continuation.consent.v2';
    const valid = {
      kind: 'consent', accountId: 'alice', interaction: INTERACTION,
      returnTo: consentReturn(), createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    };
    const cases: unknown[] = [
      null,
      [],
      'a string',
      { ...valid, kind: 'management' },
      { ...valid, accountId: 7 },
      { ...valid, interaction: '/.account/' },
      { ...valid, returnTo: 'https://evil.example/.account/interaction/flow-one/oidc/consent/' },
      { ...valid, createdAt: 'now' },
      { ...valid, expiresAt: Number.NaN },
      { ...valid, expiresAt: valid.createdAt - 1 },
      { ...valid, expiresAt: valid.createdAt + SAFE_CONTINUATION_TTL_MS + 1 },
      { ...valid, expiresAt: valid.createdAt, createdAt: valid.expiresAt },
    ];
    for (const value of cases) {
      window.sessionStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
      expect(readConsentContinuation({ accountId: 'alice', interaction: INTERACTION })).toBeNull();
    }
  });
});

describe('heavy surface confirmation re-reads the server', () => {
  const clientBody = { client: { client_id: 'app-1', client_name: 'App' } };

  it('confirms only while the server still serves that interaction consent document', async () => {
    at(`${INTERACTION}/oidc/consent/`);
    saveConsentContinuation({ accountId: 'alice', interaction: INTERACTION, returnTo: consentReturn() });
    at('/settings/pod');

    const record = peekConsentContinuation({ accountId: 'alice' });
    expect(record).not.toBeNull();
    const okFetch = vi.fn(async () => new Response(JSON.stringify(clientBody), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(confirmConsentInteractionAtAuthority(record!, { fetch: okFetch as unknown as typeof fetch })).resolves.toBe(true);
    expect(okFetch).toHaveBeenCalledWith(consentReturn(), expect.objectContaining({ method: 'GET', credentials: 'include' }));

    const deadFetch = vi.fn(async () => new Response('', { status: 404 }));
    await expect(confirmConsentInteractionAtAuthority(record!, { fetch: deadFetch as unknown as typeof fetch })).resolves.toBe(false);
    const throwing = vi.fn(async () => { throw new Error('network'); });
    await expect(confirmConsentInteractionAtAuthority(record!, { fetch: throwing as unknown as typeof fetch })).resolves.toBe(false);
  });

  it('drops an account switcher and a server-dead interaction instead of resuming', async () => {
    at(`${INTERACTION}/oidc/consent/`);
    saveConsentContinuation({ accountId: 'alice', interaction: INTERACTION, returnTo: consentReturn() });
    at('/settings/pod');

    expect(peekConsentContinuation({ accountId: 'bob' })).toBeNull();

    saveConsentContinuation({ accountId: 'alice', interaction: INTERACTION, returnTo: consentReturn() });
    const deadFetch = vi.fn(async () => new Response('', { status: 404 }));
    await expect(readConfirmedConsentContinuation({ accountId: 'alice' }, { fetch: deadFetch as unknown as typeof fetch })).resolves.toBeNull();
    expect(peekConsentContinuation({ accountId: 'alice' })).toBeNull();
  });
});

describe('management continuation is a distinct, minimal semantic', () => {
  const accountReturn = () => `${origin()}/.account/account/`;

  it('binds only the Account id and an Account destination, with no pending interaction', () => {
    expect(saveManagementContinuation({ accountId: 'alice', returnTo: accountReturn() })).toBe(true);
    const record = readManagementContinuation({ accountId: 'alice' });
    expect(record?.returnTo).toBe(accountReturn());
    expect(record && 'interaction' in record).toBe(false);

    expect(readManagementContinuation({ accountId: 'bob' })).toBeNull();
    saveManagementContinuation({ accountId: 'alice', returnTo: accountReturn() });
    expect(consumeManagementContinuation({ accountId: 'alice' })).not.toBeNull();
    expect(consumeManagementContinuation({ accountId: 'alice' })).toBeNull();
  });

  it('refuses a task destination outside the Account scope or without an Account id', () => {
    expect(saveManagementContinuation({ accountId: 'alice', returnTo: `${origin()}/settings/pod` })).toBe(false);
    expect(saveManagementContinuation({ accountId: 'alice', returnTo: 'https://evil.example/.account/account/' })).toBe(false);
    expect(saveManagementContinuation({ accountId: '', returnTo: accountReturn() })).toBe(false);
  });

  it('keeps consent and management tasks independent', () => {
    at(`${INTERACTION}/create-pod/`);
    saveConsentContinuation({ accountId: 'alice', interaction: INTERACTION, returnTo: consentReturn() });
    saveManagementContinuation({ accountId: 'alice', returnTo: `${origin()}/.account/account/` });

    clearManagementContinuation();
    expect(readManagementContinuation({ accountId: 'alice' })).toBeNull();
    expect(peekConsentContinuation({ accountId: 'alice' })).not.toBeNull();
  });
});

describe('continuation hardening (Lead black-box regressions)', () => {
  const CONSENT_KEY = 'xpod.safe-continuation.consent.v2';
  const consentRecord = (overrides: Partial<ConsentContinuation> = {}): ConsentContinuation => ({
    kind: 'consent',
    accountId: 'alice',
    interaction: INTERACTION,
    returnTo: consentReturn(),
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  });

  it('rejects a valid record whose two timestamps are moved into the future', () => {
    at(`${INTERACTION}/create-pod/`);
    expect(saveConsentContinuation({ accountId: 'alice', interaction: INTERACTION, returnTo: consentReturn() })).toBe(true);
    // Mutate the stored record exactly like a saved-then-tampered record would be.
    const stored = JSON.parse(window.sessionStorage.getItem(CONSENT_KEY)!) as Record<string, unknown>;
    stored.createdAt = Date.now() + 86_400_000;
    stored.expiresAt = (stored.createdAt as number) + SAFE_CONTINUATION_TTL_MS;
    window.sessionStorage.setItem(CONSENT_KEY, JSON.stringify(stored));
    expect(readConsentContinuation({ accountId: 'alice', interaction: INTERACTION })).toBeNull();

    // A future `expiresAt` must not smuggle the window past the fixed cap either.
    const wide = JSON.parse(JSON.stringify(consentRecord())) as Record<string, unknown>;
    wide.createdAt = Date.now() - 1000;
    wide.expiresAt = Date.now() + 86_400_000;
    window.sessionStorage.setItem(CONSENT_KEY, JSON.stringify(wide));
    expect(readConsentContinuation({ accountId: 'alice', interaction: INTERACTION })).toBeNull();
  });

  it('rejects identity/control evidence that points at a different Account', () => {
    // identity A + controls.logout pointing at Account B: sources disagree, fail closed.
    expect(resolveAuthoritativeAccountId(
      { account: { logout: 'http://localhost/.account/account/account-b/logout/' } },
      { id: 'account-a' },
    )).toBeUndefined();
    // A WebID-shaped identity.id is not an Account id: it neither supplies nor vetoes one.
    expect(resolveAuthoritativeAccountId(
      { account: { logout: 'http://localhost/.account/account/account-a/logout/' } },
      { id: 'https://alice.example/profile#me' },
    )).toBe('account-a');
  });

  it('refuses a consent authority answer that was redirected to another interaction', async () => {
    at(`${INTERACTION}/oidc/consent/`);
    const record = consentRecord();
    const answerAtOther = (redirected: boolean) => (async () => ({
      ok: true,
      redirected,
      status: 200,
      url: `${origin()}${OTHER_INTERACTION}/oidc/consent/`,
      json: async () => ({ client: { client_id: 'other-app', client_name: 'Other App' } }),
    })) as unknown as typeof fetch;

    // An expired/foreign interaction whose GET is redirected to a still-valid one.
    await expect(confirmConsentInteractionAtAuthority(record, { fetch: answerAtOther(true) })).resolves.toBe(false);
    // Moved without the redirect flag still answers from the wrong address.
    await expect(confirmConsentInteractionAtAuthority(record, { fetch: answerAtOther(false) })).resolves.toBe(false);
    // A 3xx surfaced by `redirect: 'manual'` is not a confirmation.
    const threeOhTwo = (async () => ({
      ok: false, redirected: false, status: 302, url: record.returnTo, json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(confirmConsentInteractionAtAuthority(record, { fetch: threeOhTwo })).resolves.toBe(false);
    // Control: the exact interaction still confirms.
    const okFetch = vi.fn(async () => ({
      ok: true, redirected: false, status: 200, url: record.returnTo, json: async () => ({ client: { client_id: 'app-1' } }),
    })) as unknown as typeof fetch;
    await expect(confirmConsentInteractionAtAuthority(record, { fetch: okFetch })).resolves.toBe(true);
    expect(okFetch).toHaveBeenCalledWith(record.returnTo, expect.objectContaining({ redirect: 'manual' }));
  });

  it('drops a confirmation that returns after the session changed mid-await', async () => {
    at(`${INTERACTION}/oidc/consent/`);
    saveConsentContinuation({ accountId: 'alice', interaction: INTERACTION, returnTo: consentReturn() });
    at('/settings/pod');
    // The Account switch clears the queued task while the fetch is in flight.
    const switchDuringAwait = (async () => {
      clearConsentContinuation();
      return { ok: true, redirected: false, status: 200, url: consentReturn(), json: async () => ({ client: { client_id: 'app-1' } }) };
    }) as unknown as typeof fetch;
    await expect(readConfirmedConsentContinuation({ accountId: 'alice' }, { fetch: switchDuringAwait })).resolves.toBeNull();

    // Or the Account-capability guard flips once the await resolves.
    saveConsentContinuation({ accountId: 'alice', interaction: INTERACTION, returnTo: consentReturn() });
    let calls = 0;
    const assertCurrent = () => { calls += 1; if (calls >= 3) throw new Error('account switched'); };
    const okFetch = (async () => ({
      ok: true, redirected: false, status: 200, url: consentReturn(), json: async () => ({ client: { client_id: 'app-1' } }),
    })) as unknown as typeof fetch;
    await expect(readConfirmedConsentContinuation({ accountId: 'alice' }, { fetch: okFetch, assertCurrent })).resolves.toBeNull();
  });
});
