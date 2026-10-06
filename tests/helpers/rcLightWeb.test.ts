import { JSDOM } from 'jsdom';
import type { Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyRcAccountSurface, describeRcAccountSurface, observeRcAccountSurface,
  RC_ACCOUNT_DASHBOARD_HEADING, RC_ACCOUNT_DOCUMENT_PATH, settleRcAccountSurface,
  type PaintedRcAccountSurface, type RcAccountSurfaceKind } from './rcLightWeb';

const CLOSED_KINDS: RcAccountSurfaceKind[] = ['account-dashboard', 'bootstrap-loading', 'bootstrap-error', 'login',
  'oidc-consent', 'unrecognized'];

const LOADING_HTML = '<div role="status" aria-live="polite">正在加载…</div>';
const DASHBOARD_HTML = '<h2>账号总览</h2><p>绑定</p>';
const ERROR_HTML = '<div role="alert">账号服务暂不可用</div>';

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A page whose `evaluate` really runs the shared landmark callback against a live document,
 * so the wrapper is exercised end to end instead of through a copied fixture shape.
 */
function domPage(html: string, url: string, afterRead?: (read: number) => void) {
  const dom = new JSDOM(`<body>${html}</body>`, { url });
  const view = dom.window as unknown as Window & typeof globalThis;
  // jsdom reports empty boxes; the shared callback intentionally ignores unpainted nodes.
  view.Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    return { x: 0, y: 0, width: 120, height: 24, top: 0, left: 0, right: 120, bottom: 24,
      toJSON: () => ({ width: 120, height: 24 }) } as DOMRect;
  };
  vi.stubGlobal('window', view);
  vi.stubGlobal('document', view.document);
  vi.stubGlobal('getComputedStyle', view.getComputedStyle.bind(view));
  const waits: number[] = [];
  let reads = 0;
  const page = {
    evaluate: async (fn: () => unknown) => { reads += 1; const value = fn(); afterRead?.(reads); return value; },
    waitForTimeout: async (ms: number) => { waits.push(ms); },
  } as unknown as Page;
  return { dom, page, waits, reads: () => reads,
    paint: (next: string) => { view.document.body.innerHTML = next; },
    goTo: (next: string) => { view.history.pushState({}, '', next); } };
}

function framePage(frames: Array<PaintedRcAccountSurface | 'throw'>) {
  let reads = 0;
  const waits: number[] = [];
  const page = {
    evaluate: async () => {
      const frame = frames[Math.min(reads, frames.length - 1)];
      reads += 1;
      if (frame === 'throw') throw new Error('locator rejected: cookie=SECRET-cookie-value token=SECRET-token-value');
      return frame;
    },
    waitForTimeout: async (ms: number) => { waits.push(ms); },
  } as unknown as Page;
  return { page, waits, reads: () => reads };
}

function painted(overrides: Partial<PaintedRcAccountSurface> = {}): PaintedRcAccountSurface {
  return { pathname: RC_ACCOUNT_DOCUMENT_PATH, headingText: '', hasPasswordInput: false,
    hasBootstrapStatus: false, hasAlert: false, ...overrides };
}

describe('deployed Account surface observation', () => {
  it('keeps waiting past the loading frame until the client-rendered dashboard paints', async () => {
    const dom = domPage(LOADING_HTML, 'https://id.example/.account/account/', read => {
      if (read === 2) dom.paint(DASHBOARD_HTML);
    });
    // A single frame after domcontentloaded is the loading screen: that frame alone must
    // never be read as success, which is what the previous bare visibility assert did.
    const first = await observeRcAccountSurface(dom.page);
    expect(first?.kind).toBe('bootstrap-loading');
    const settled = await settleRcAccountSurface(dom.page);
    expect(settled.kind).toBe('account-dashboard');
    expect(dom.reads()).toBeGreaterThan(1);
    expect(settled.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('never treats a redirect off the Account document as the dashboard', async () => {
    const consent = domPage(DASHBOARD_HTML, 'https://id.example/.account/oidc/consent/');
    const settled = await settleRcAccountSurface(consent.page, RC_ACCOUNT_DOCUMENT_PATH, 200);
    expect(settled.kind).toBe('oidc-consent');
    // The dashboard copy is painted, but on the wrong document: the budget must expire.
    expect(consent.reads()).toBeGreaterThan(1);
    expect(consent.waits.length).toBeGreaterThan(0);

    const login = domPage('<input type="password" />', 'https://id.example/.account/login/password/');
    expect((await settleRcAccountSurface(login.page, RC_ACCOUNT_DOCUMENT_PATH, 5)).kind).toBe('login');
  });

  it('distinguishes a stuck bootstrap from an unknown surface instead of renaming both', async () => {
    const error = domPage(ERROR_HTML, 'https://id.example/.account/account/');
    expect((await settleRcAccountSurface(error.page, RC_ACCOUNT_DOCUMENT_PATH, 5)).kind).toBe('bootstrap-error');
    const blank = domPage('<p>nothing painted yet</p>', 'https://id.example/.account/account/');
    expect((await settleRcAccountSurface(blank.page, RC_ACCOUNT_DOCUMENT_PATH, 5)).kind).toBe('unrecognized');
  });

  it('publishes only the closed-vocabulary token when the surface never settles', async () => {
    const unauthorized = domPage('<div role="alert">token=SECRET-alert-value</div>',
      'https://id.example/.account/oidc/consent/#SECRET-fragment');
    const settled = await settleRcAccountSurface(unauthorized.page, RC_ACCOUNT_DOCUMENT_PATH, 5);
    expect(CLOSED_KINDS).toContain(settled.kind);
    expect(settled.pathname).toBe('/.account/oidc/consent/');
    const message = describeRcAccountSurface(settled);
    expect(message).toBe('RC Account surface did not reach the dashboard (observed=oidc-consent)');
    expect(message).not.toMatch(/SECRET|token=/u);
  });

  it('reads landmarks without carrying page copy or URL credentials out of the document', async () => {
    const secret = domPage('<h2>账号总览</h2>',
      'https://id.example/.account/account/?access_token=SECRET-query-token&code=SECRET-code#SECRET-hash');
    const observed = await observeRcAccountSurface(secret.page);
    expect(observed).toEqual({ kind: 'account-dashboard', pathname: RC_ACCOUNT_DOCUMENT_PATH });
    expect(JSON.stringify(observed)).not.toMatch(/SECRET/u);
    expect(RC_ACCOUNT_DASHBOARD_HEADING.test('<h2>账号总览</h2>')).toBe(true);
  });

  it('stays honest when the document read itself fails or returns nothing', async () => {
    const rejected = framePage(['throw']);
    expect(await observeRcAccountSurface(rejected.page)).toBeUndefined();
    const settled = await settleRcAccountSurface(rejected.page, RC_ACCOUNT_DOCUMENT_PATH, 5);
    expect(settled).toEqual({ kind: 'unrecognized', pathname: RC_ACCOUNT_DOCUMENT_PATH, elapsedMs: 0 });
    expect(describeRcAccountSurface(settled)).not.toMatch(/SECRET/u);

    expect(await observeRcAccountSurface({
      evaluate: async () => undefined, waitForTimeout: async () => undefined,
    } as unknown as Page)).toBeUndefined();
    const loading = framePage([painted({ hasBootstrapStatus: true })]);
    expect((await settleRcAccountSurface(loading.page, RC_ACCOUNT_DOCUMENT_PATH, 5)).kind).toBe('bootstrap-loading');
  });

  it('classifies a bounced document with the same closed vocabulary the caller publishes', () => {
    expect(classifyRcAccountSurface(painted({ headingText: '账号总览', hasAlert: true }))).toBe('account-dashboard');
    expect(classifyRcAccountSurface(painted({ pathname: '/.account/account/abc/' }))).toBe('unrecognized');
    expect(classifyRcAccountSurface(painted({ pathname: '/.account/login/password/register/' }))).toBe('login');
    expect(classifyRcAccountSurface(painted({ hasPasswordInput: true }))).toBe('unrecognized');
    expect(classifyRcAccountSurface(painted({ hasAlert: true, hasBootstrapStatus: true }))).toBe('bootstrap-error');
  });
});
