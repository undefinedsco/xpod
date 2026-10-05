import { errors, type Locator, type Page } from '@playwright/test';
import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';
import { chooseConsentBinding, clickNonPasswordOidcAction, completeOidcLogin,
  type BrowserOidcTrace } from './browserSolidOidc';

/** Actual shared driver/evaluate functions, with browser events in their real order. */
async function callbackScenario(mode = 'current', passwordRequests: Array<{ path: string; method: 'GET' | 'POST' }> = []) {
  const dom = new JSDOM('<main>Authenticated workspace</main>', { url: 'https://app.example/ai-connections' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('fetch', async () => new Response('fixture asset'));
  const storage = dom.window.sessionStorage;
  const first = 'abandoned-before-callback', current = 'actual-callback';
  storage.setItem('xpod.auth.transaction.v1.active', first);
  const markerKey = `xpod.auth.callback.completed.v1.${current}`;
  const marker = () => ({ destination: 'https://app.example/ai-connections',
    callback: `${mode === 'foreign-marker' ? 'https://foreign.example' : 'https://app.example'}/auth/callback?state=${mode === 'wrong-state' ? 'unrelated' : 'current-state'}${mode === 'marker-fragment' ? '#other' : ''}`,
    completedAt: Date.now() - (mode === 'old-timestamp' ? 10_000 : 0) });
  if (mode === 'old-marker') storage.setItem(markerKey, JSON.stringify(marker()));
  const events = new Map<string, Array<(value: unknown) => void>>();
  const emit = (name: string, value: unknown) => events.get(name)?.forEach(fn => fn(value));
  const locator = { first() { return this; }, last() { return this; }, isVisible: async () => false, isEnabled: async () => false,
    count: async () => 0, innerText: async () => 'Authenticated workspace' };
  const page = { bringToFront: async () => undefined, url: () => dom.window.location.href,
    on: (name: string, fn: (value: unknown) => void) => { events.set(name, [...events.get(name) ?? [], fn]); },
    off: () => undefined, locator: () => locator, getByRole: () => locator, getByText: () => locator,
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg), waitForTimeout: async () => undefined,
  } as unknown as Page;
  let ready = false;
  const request = (url: string, body = '') => ({ url: () => url, method: () => body ? 'POST' : 'GET', headers: () => ({}), postData: () => body });
  try {
    return await completeOidcLogin(page, { email: 'fixture@example.test', password: 'not-used' }, {
      baseUrl: 'https://app.example/', timeoutMs: 100, requireCallbackEvidence: true,
      ready: async () => {
        if (ready) return true;
        ready = true;
        for (const requestInput of passwordRequests) emit('request', request('https://id.example' + requestInput.path, requestInput.method === 'POST' ? 'not-retained' : ''));
        const redirect = mode === 'invalid-redirect' ? 'invalid' : mode === 'foreign-redirect' ? 'https://foreign.example/auth/callback' : 'https://app.example/auth/callback';
        const params = new URLSearchParams({ response_type: 'code', client_id: 'fixture', redirect_uri: redirect,
          state: 'current-state', code_challenge: 'challenge', code_challenge_method: mode === 'wrong-pkce' ? 'plain' : 'S256' });
        if (mode === 'with-invalid-observation') {
          const invalid = new URLSearchParams(params); invalid.set('redirect_uri', 'invalid');
          emit('request', request(`https://id.example/authorize?${invalid}`));
        }
        emit('request', request(`https://id.example/authorize?${params}`));
        const origin = mode === 'foreign-callback' ? 'https://foreign.example' : 'https://app.example';
        const pathname = mode === 'wrong-path' ? '/other/callback' : '/auth/callback';
        const callback = new URL(origin + pathname);
        if (mode !== 'no-code') callback.searchParams.set('code', 'one-time-code');
        if (mode !== 'no-state') callback.searchParams.set('state', 'current-state');
        if (mode === 'wrong-explicit') callback.searchParams.set('transaction', first);
        emit('request', request(callback.href));
        emit('request', request('https://id.example/token', 'grant_type=authorization_code&code_verifier=verifier'));
        storage.setItem(`xpod.auth.transaction.v1.consumed.${first}`, 'true');
        if (mode !== 'unconsumed') storage.setItem(`xpod.auth.transaction.v1.consumed.${current}`, 'true');
        storage.removeItem('xpod.auth.transaction.v1.active');
        if (mode === 'still-active') storage.setItem('xpod.auth.transaction.v1.active', current);
        if (!['old-marker', 'missing-marker'].includes(mode)) storage.setItem(markerKey,
          mode === 'invalid-marker' ? 'invalid JSON' : JSON.stringify(marker()));
        if (mode === 'ambiguous') {
          storage.setItem('xpod.auth.callback.completed.v1.another', JSON.stringify(marker()));
          storage.setItem('xpod.auth.transaction.v1.consumed.another', 'true');
        }
        return false;
      },
    });
  } finally { vi.unstubAllGlobals(); dom.window.close(); }
}

it.each(['current', 'with-invalid-observation'])('correlates the actual callback state after an earlier active transaction was abandoned: %s', async mode => {
  const trace = await callbackScenario(mode);
  expect(trace.callbackTransaction).toBe('actual-callback');
  expect(trace.callbackHasCode && trace.callbackHasState && trace.authCodeChallengeMethodS256).toBe(true);
});

it.each(['foreign-redirect', 'foreign-callback', 'wrong-path', 'wrong-state', 'no-code', 'no-state',
  'old-marker', 'still-active', 'ambiguous', 'wrong-explicit', 'wrong-pkce', 'foreign-marker', 'marker-fragment',
  'old-timestamp', 'invalid-redirect', 'unconsumed', 'missing-marker', 'invalid-marker'])('rejects uncorrelated callback completion: %s', async mode => {
  await expect(callbackScenario(mode)).rejects.toThrow('did not finish before timeout');
});

it.each([
  { path: '/.account/login/password/', method: 'POST' as const, expected: 1 },
  { path: '/.account/interaction/current/login/password/', method: 'POST' as const, expected: 1 },
  { path: '/.account/interaction/current/login/password', method: 'POST' as const, expected: 1 },
  { path: '/.account/interaction/current/login/password/', method: 'GET' as const, expected: 0 },
  { path: '/.account/interaction/current/oidc/consent/', method: 'POST' as const, expected: 0 },
  { path: '/other/.account/login/password/', method: 'POST' as const, expected: 0 },
  { path: '/.account/interaction/current/nested/login/password/', method: 'POST' as const, expected: 0 },
])('counts only actual password POSTs on the CSS direct or interaction route: $path $method', async input => {
  const trace = await callbackScenario('current', [input]);
  expect(trace.passwordRequestCount ?? 0).toBe(input.expected);
});

it('selects the requested authoritative Pod instead of retaining another same-owner default', () => {
  const options = ['https://id.example/card#me|https://a.example/pod/', 'https://id.example/card#me|https://b.example/pod/']
    .map(value => ({ value, disabled: false }));
  expect(chooseConsentBinding(options, options[0].value, { webId: 'https://id.example/card#me', podUrl: 'https://b.example/pod/' }))
    .toBe(options[1].value);
  expect(chooseConsentBinding(options.slice(0, 1), options[0].value,
    { webId: 'https://id.example/card#me', podUrl: 'https://b.example/pod/' })).toBeUndefined();
  expect(chooseConsentBinding([{ ...options[1], disabled: true }], '',
    { webId: 'https://id.example/card#me', podUrl: 'https://b.example/pod/' })).toBeUndefined();
  expect(chooseConsentBinding(options, options[0].value, { webId: 'https://id.example/card#other' })).toBeUndefined();
});

const CONTROL_SELECTOR = 'button, input[type=submit], a[href]';

it('returns to readiness detection when navigation removes a discovered control', async () => {
  const locator = { evaluate: vi.fn().mockRejectedValue(new errors.TimeoutError('Control disappeared')) } as unknown as Locator;
  expect(await clickNonPasswordOidcAction(locator)).toBe(false);
});

it('does not hide an unexpected action evaluation failure', async () => {
  const failure = new Error('Unexpected evaluation failure');
  const locator = { evaluate: vi.fn().mockRejectedValue(failure) } as unknown as Locator;
  await expect(clickNonPasswordOidcAction(locator)).rejects.toBe(failure);
});

/** JSDOM stub for `Locator.evaluate` that forwards the serialized argument. */
function stubLocator(element: Element) {
  const click = vi.spyOn(element as HTMLElement, 'click');
  const locator = {
    evaluate: async (fn: (element: Element, arg?: unknown) => unknown, arg?: unknown) => fn(element, arg),
    click,
  } as unknown as Locator;
  return { locator, click };
}

it.each(['<button>登录</button>', '<input type="submit" value="登录">'])('does not submit a password form mounted after the credential visibility check: %s', async (action) => {
  const dom = new JSDOM('<main></main>');
  try {
    // Reproduce the trace ordering: credentials were absent when probed, but
    // the login action exists by the time generic actions are discovered.
    expect(dom.window.document.querySelector('input[type=password]')).toBeNull();
    dom.window.document.querySelector('main')!.innerHTML = `<form><input type="email"><input type="password">${action}</form>`;
    const element = dom.window.document.querySelector<HTMLElement>(`${CONTROL_SELECTOR}`)!;
    const { locator, click } = stubLocator(element);
    expect(await clickNonPasswordOidcAction(locator)).toBe(false);
    expect(click).not.toHaveBeenCalled();
  } finally { dom.window.close(); }
});

it('also excludes submit controls linked to a password form by form ID', async () => {
  const dom = new JSDOM('<form id="credentials"><input name="password"></form><button form="credentials">登录</button>');
  try {
    const { locator, click } = stubLocator(dom.window.document.querySelector('button')!);
    expect(await clickNonPasswordOidcAction(locator)).toBe(false);
    expect(click).not.toHaveBeenCalled();
  } finally { dom.window.close(); }
});

it.each([
  '<form><button>批准</button></form>',
  '<button>使用 WebID 登录</button>',
  '<button>授权</button>',
  '<button>继续</button>',
  '<button>允许</button>',
  '<input type="submit" value="同意">',
  '<a href="#authorize">授权</a>',
  '<a href="#webid">使用 WebID 登录</a>',
])('continues non-password OIDC actions: %s', async (html) => {
  const dom = new JSDOM(html);
  try {
    const control = dom.window.document.querySelector<HTMLElement>(CONTROL_SELECTOR)!;
    const click = vi.fn((event: Event) => event.preventDefault());
    control.addEventListener('click', click);
    const { locator } = stubLocator(control);
    expect(await clickNonPasswordOidcAction(locator)).toBe(true);
    expect(click).toHaveBeenCalledOnce();
  } finally { dom.window.close(); }
});

// Safety: the broad primary discovery regex matches label fragments, so logout
// (退出登录 → 登录) and cancel-authorization (取消授权 → 授权) are discovered as
// candidates. Every control kind - button, submit input and anchor - must refuse
// them on the exact node that would be activated.
it.each([
  '<button>退出登录</button>',
  '<button>退出</button>',
  '<button>取消授权</button>',
  '<button>取消</button>',
  '<button>撤销访问</button>',
  '<button>切换账号</button>',
  '<button>Log out</button>',
  '<button>Revoke access</button>',
  '<button>Reject</button>',
  '<button>Deny</button>',
  '<input type="submit" value="取消授权">',
  '<a href="#logout">退出登录</a>',
  '<a href="#cancel">取消授权</a>',
  '<a href="#revoke">Revoke access</a>',
])('refuses to activate a disruptive OIDC action even when broad discovery matches it: %s', async (html) => {
  const dom = new JSDOM(html);
  try {
    const { locator, click } = stubLocator(dom.window.document.querySelector<HTMLElement>(CONTROL_SELECTOR)!);
    expect(await clickNonPasswordOidcAction(locator)).toBe(false);
    expect(click).not.toHaveBeenCalled();
  } finally { dom.window.close(); }
});

// The refusal rule is deliberately conservative: any of aria-label / text / value
// carrying a disruptive token refuses the control, whichever source disagrees.
it.each([
  '<button aria-label="退出登录">继续</button>',
  '<button aria-label="取消授权">授权</button>',
  '<a href="#x" aria-label="取消授权">继续授权</a>',
  '<button aria-label="授权">取消</button>',
])('refuses when aria-label conflicts with the visible label: %s', async (html) => {
  const dom = new JSDOM(html);
  try {
    const { locator, click } = stubLocator(dom.window.document.querySelector<HTMLElement>(CONTROL_SELECTOR)!);
    expect(await clickNonPasswordOidcAction(locator)).toBe(false);
    expect(click).not.toHaveBeenCalled();
  } finally { dom.window.close(); }
});

it('does not re-resolve an action replaced by a password submit after evaluation', async () => {
  const dom = new JSDOM('<main><button>继续</button></main>');
  try {
    const originalClick = vi.fn();
    const passwordSubmit = vi.fn((event: Event) => event.preventDefault());
    dom.window.document.querySelector('button')!.addEventListener('click', originalClick);
    const locator = {
      evaluate: async (fn: (element: Element, arg?: unknown) => unknown, arg?: unknown) => {
        const result = fn(dom.window.document.querySelector('button')!, arg);
        dom.window.document.querySelector('main')!.innerHTML = '<form><input type="password"><button>继续</button></form>';
        dom.window.document.querySelector('form')!.addEventListener('submit', passwordSubmit);
        return result;
      },
      click: async () => dom.window.document.querySelector('button')!.click(),
    } as unknown as Locator;
    expect(await clickNonPasswordOidcAction(locator)).toBe(true);
    expect(passwordSubmit).not.toHaveBeenCalled();
    expect(originalClick).toHaveBeenCalledOnce();
  } finally { dom.window.close(); }
});

it('activates the discovered anchor rather than a disruptive anchor that replaces it', async () => {
  const dom = new JSDOM('<main><a href="#authorize">继续</a></main>');
  try {
    const originalClick = vi.fn((event: Event) => event.preventDefault());
    const replacementClick = vi.fn((event: Event) => event.preventDefault());
    dom.window.document.querySelector('a')!.addEventListener('click', originalClick);
    const locator = {
      evaluate: async (fn: (element: Element, arg?: unknown) => unknown, arg?: unknown) => {
        const result = fn(dom.window.document.querySelector('a')!, arg);
        dom.window.document.querySelector('main')!.innerHTML = '<a href="#logout">退出登录</a>';
        dom.window.document.querySelector('a')!.addEventListener('click', replacementClick);
        return result;
      },
      click: async () => dom.window.document.querySelector('a')!.click(),
    } as unknown as Locator;
    expect(await clickNonPasswordOidcAction(locator)).toBe(true);
    expect(originalClick).toHaveBeenCalledOnce();
    expect(replacementClick).not.toHaveBeenCalled();
  } finally { dom.window.close(); }
});

it.each(['disabled', 'aria-disabled="true"'])('does not activate an action disabled after discovery: %s', async (attribute) => {
  const dom = new JSDOM(`<button ${attribute}>继续</button>`);
  try {
    const { locator, click } = stubLocator(dom.window.document.querySelector('button')!);
    expect(await clickNonPasswordOidcAction(locator)).toBe(false);
    expect(click).not.toHaveBeenCalled();
  } finally { dom.window.close(); }
});

it('does not activate a detached action', async () => {
  const dom = new JSDOM('<button>继续</button>');
  try {
    const element = dom.window.document.querySelector('button')!;
    element.remove();
    const { locator, click } = stubLocator(element);
    expect(await clickNonPasswordOidcAction(locator)).toBe(false);
    expect(click).not.toHaveBeenCalled();
  } finally { dom.window.close(); }
});

/**
 * Consent-page stub exercising the real driver contract for the explicit
 * remember-client choice: the consent surface marker, the exact checkbox
 * label, and the folded request-details disclosure.
 */
async function consentScenario(
  choice: boolean | undefined,
  options: { checkbox?: 'present' | 'absent' | 'disabled'; summary?: 'present' | 'absent'; folded?: boolean } = {},
) {
  const checkbox = options.checkbox ?? 'present';
  const summary = options.summary ?? 'present';
  const dom = new JSDOM('<main>Consent</main>', { url: 'https://app.example/.account/oidc/consent/' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('fetch', async () => new Response('fixture asset'));
  const events = new Map<string, Array<(value: unknown) => void>>();
  const emit = (name: string, value: unknown) => events.get(name)?.forEach((fn) => fn(value));
  const state = { checked: false, disclosureOpen: !(options.folded ?? false), setCheckedCalls: [] as boolean[], summaryClicks: 0 };
  const locator = (overrides: Record<string, unknown> = {}) => ({
    first() { return this; }, last() { return this; }, nth() { return this; }, locator() { return this; },
    isVisible: async () => false, isEnabled: async () => false, isChecked: async () => false,
    setChecked: async () => undefined, check: async () => undefined, click: async () => undefined,
    count: async () => 0, innerText: async () => '', evaluate: async () => false,
    evaluateAll: async () => [], selectOption: async () => undefined, inputValue: async () => '',
    getAttribute: async () => null, fill: async () => undefined, press: async () => undefined,
    ...overrides,
  });
  const rememberLocator = locator({
    isVisible: async () => checkbox !== 'absent' && state.disclosureOpen,
    isEnabled: async () => checkbox !== 'disabled',
    isChecked: async () => state.checked,
    setChecked: async (value: boolean) => { state.setCheckedCalls.push(value); state.checked = value; },
    count: async () => (checkbox === 'absent' ? 0 : 1),
  });
  const summaryLocator = locator({
    isVisible: async () => summary === 'present',
    click: async () => { state.summaryClicks += 1; state.disclosureOpen = true; },
  });
  const page = {
    bringToFront: async () => undefined,
    url: () => dom.window.location.href,
    on: (name: string, fn: (value: unknown) => void) => { events.set(name, [...(events.get(name) ?? []), fn]); },
    off: () => undefined,
    locator: (selector: string) => selector === '[data-pod-sign-in-state="consent"]'
      ? locator({ isVisible: async () => true })
      : selector === 'summary' ? summaryLocator : locator(),
    // Only the exact remember-client label resolves to a real checkbox.
    getByRole: (role: string, query?: { name?: RegExp }) => role === 'checkbox' && query?.name?.test('以后不再询问')
      ? rememberLocator : locator(),
    getByText: () => locator(),
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
    waitForTimeout: async () => undefined,
  } as unknown as Page;
  let readyCalls = 0;
  try {
    const trace = await completeOidcLogin(page, { email: 'fixture@example.test', password: 'not-used' }, {
      baseUrl: 'https://app.example/', timeoutMs: 2_000,
      ...(choice === undefined ? {} : { rememberClient: choice }),
      ready: async () => {
        readyCalls += 1;
        if (readyCalls === 1) return false;
        // The approval POST is only real evidence when the checkbox state is
        // what the scenario requested; the unit observes the same safe boolean.
        emit('request', {
          url: () => 'https://id.example/.account/oidc/consent/', method: () => 'POST',
          headers: () => ({}), postData: () => JSON.stringify({ remember: state.checked }),
        });
        return true;
      },
    });
    return { trace, state };
  } finally {
    vi.unstubAllGlobals();
    dom.window.close();
  }
}

it('sets and retains the explicit remember-client choice before approval', async () => {
  const { trace, state } = await consentScenario(true, { folded: true });
  expect(state.summaryClicks).toBe(1);
  expect(state.setCheckedCalls).toEqual([true]);
  expect(trace.rememberClientRequested).toBe(true);
  expect(trace.rememberClientObserved).toBe(true);
  expect(trace.consentRequestCount).toBe(1);
  expect(trace.consentRememberPosted).toBe(true);
});

it('records an explicit do-not-remember choice and never treats it as remember', async () => {
  const { trace, state } = await consentScenario(false);
  expect(state.summaryClicks).toBe(0);
  expect(state.setCheckedCalls).toEqual([false]);
  expect(trace.rememberClientRequested).toBe(false);
  expect(trace.rememberClientObserved).toBe(false);
  expect(trace.consentRememberPosted).toBe(false);
});

it('leaves the consent surface default unchanged when no remember choice is requested', async () => {
  const { trace, state } = await consentScenario(undefined, { folded: true });
  expect(state.summaryClicks).toBe(0);
  expect(state.setCheckedCalls).toEqual([]);
  expect(trace.rememberClientRequested).toBeUndefined();
  expect(trace.rememberClientObserved).toBeUndefined();
});

it('fails when the requested remember-client choice is not offered', async () => {
  await expect(consentScenario(true, { checkbox: 'absent', folded: true }))
    .rejects.toThrow(/did not offer the requested remember-client choice/);
});

it('fails when the requested remember-client choice cannot be set before approval', async () => {
  await expect(consentScenario(true, { checkbox: 'disabled' }))
    .rejects.toThrow(/remember-client choice is disabled/);
});

/**
 * Minimal page stub that emits real observed authorize requests, including the
 * authorization credentials a trace must never retain.
 */
async function scopeScenario(scopeSets: string[]): Promise<BrowserOidcTrace> {
  const dom = new JSDOM('<main>Consent</main>', { url: 'https://app.example/.account/oidc/consent/' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('fetch', async () => new Response('fixture asset'));
  const events = new Map<string, Array<(value: unknown) => void>>();
  const emit = (name: string, value: unknown) => events.get(name)?.forEach((fn) => fn(value));
  const locator = (): Locator => ({
    first() { return this; }, last() { return this; }, nth() { return this; }, locator() { return this; },
    isVisible: async () => false, isEnabled: async () => false, isChecked: async () => false,
    setChecked: async () => undefined, check: async () => undefined, click: async () => undefined,
    count: async () => 0, innerText: async () => '', evaluate: async () => false, evaluateAll: async () => [],
    selectOption: async () => undefined, inputValue: async () => '', getAttribute: async () => null,
    fill: async () => undefined, press: async () => undefined,
  } as unknown as Locator);
  const page = {
    bringToFront: async () => undefined,
    url: () => dom.window.location.href,
    on: (name: string, fn: (value: unknown) => void) => { events.set(name, [...(events.get(name) ?? []), fn]); },
    off: () => undefined,
    locator,
    getByRole: locator,
    getByText: locator,
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
    waitForTimeout: async () => undefined,
  } as unknown as Page;
  const requests = scopeSets.map((scope, index) => {
    const url = new URL('https://id.example/.oidc/auth');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', 'fixture-client');
    url.searchParams.set('redirect_uri', 'https://app.example/auth/callback');
    url.searchParams.set('state', `state-secret-${index}`);
    url.searchParams.set('code_challenge', `challenge-secret-${index}`);
    url.searchParams.set('code_challenge_method', 'S256');
    if (scope !== '<none>') for (const value of scope.split(' ')) url.searchParams.append('scope', value);
    return { url: () => url.href, method: () => 'GET', headers: () => ({}), postData: () => '' };
  });
  let readyCalls = 0;
  try {
    return await completeOidcLogin(page, { email: 'fixture@example.test', password: 'not-used' }, {
      baseUrl: 'https://app.example/', timeoutMs: 2_000,
      ready: async () => {
        readyCalls += 1;
        if (readyCalls <= requests.length) {
          emit('request', requests[readyCalls - 1]);
          return false;
        }
        return true;
      },
    });
  } finally {
    vi.unstubAllGlobals();
    dom.window.close();
  }
}

it('records normalized authorization scope sets per authorize request', async () => {
  const trace = await scopeScenario(['openid webid offline_access openid', 'webid openid']);
  expect(trace.authorizationScopeSets).toEqual(['offline_access openid webid', 'openid webid']);
});

it('records a missing authorize scope as <none> and never retains authorization secrets', async () => {
  const trace = await scopeScenario(['<none>']);
  expect(trace.authorizationScopeSets).toEqual(['<none>']);
  const serialized = JSON.stringify(trace);
  for (const secret of ['state-secret-0', 'challenge-secret-0']) {
    expect(serialized).not.toContain(secret);
  }
});
