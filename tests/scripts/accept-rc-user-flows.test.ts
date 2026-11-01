import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AcceptanceError,
  assertBuiltinModels,
  assertChatNonce,
  assertEmptyScopeAsk,
  assertEmptyScopeSelect,
  assertNoSecretMaterial,
  assertSparqlRoot,
  boundedPoll,
  classifyCredentialIssuanceFailure,
  describeAcceptanceFailure,
  formatCredentialFailure,
  matrixSk,
  normalizeRcBaseUrl,
  writeEvidenceFile,
  type RcUserFlowsEvidence,
} from '../../scripts/accept-rc-user-flows';
import {
  classifyConsentOfferedBindingSurface,
  completeOidcLogin,
} from '../helpers/browserSolidOidc';
import {
  RcEvidenceError,
  decodeAccountCookieValue,
  readRcAccountToken,
  verifyRcConsentBinding,
  type RcSession,
} from '../helpers/rcLightWeb';

const identity = {
  accountId: 'alice-account',
  webId: 'https://id-rc.undefineds.cn/alice/profile/card#me',
  storageUrl: 'https://pods-rc.undefineds.cn/alice/',
};

function trace(overrides: Record<string, unknown> = {}): RcSession['trace'] {
  return {
    authorizationRequestSeen: true,
    authCodeChallengeSeen: true,
    authCodeChallengeMethodS256: true,
    redirectCodeSeen: true,
    tokenAuthorizationCodeGrantSeen: true,
    tokenCodeVerifierSeen: true,
    callbackPathSeen: true,
    callbackHasCode: true,
    callbackHasState: true,
    passwordSubmitted: true,
    authorizationRedirectUris: [],
    authorizationScopeSets: [],
    consentSurfaceCount: 1,
    consentBindingOptionCount: 1,
    consentSingleBindingOffered: true,
    consentSingleBindingOfferedBinding: { webId: identity.webId, storageUrl: identity.storageUrl },
    ...overrides,
  } as RcSession['trace'];
}

function session(overrides: Record<string, unknown> = {}): RcSession {
  return {
    identity,
    authenticatedFetch: (async () => new Response('')) as typeof fetch,
    trace: trace(overrides),
  };
}

function evidence(overrides: Partial<RcUserFlowsEvidence> = {}): RcUserFlowsEvidence {
  return {
    schemaVersion: 1,
    kind: 'xpod-rc-user-flows',
    baseUrl: 'https://id-rc.undefineds.cn/',
    startedAt: '2026-11-01T00:00:00.000Z',
    completedAt: '2026-11-01T00:01:00.000Z',
    checks: {
      'rc-pod-sparql': { ok: true, detail: 'root 200; empty descendant scope' },
      'rc-builtin-models-chat': { ok: true, detail: 'linx and linx-lite nonce matched' },
      'rc-matrix-collaboration': { ok: true, detail: 'exact sender/body both ways' },
      'rc-browser-consent': { ok: true, detail: 'one consent screen, one binding' },
    },
    evidenceScope: 'deployed RC only',
    ...overrides,
  };
}

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('RC user-flow acceptance runner', () => {
  it('accepts only the deployed RC HTTPS origin', () => {
    expect(normalizeRcBaseUrl('https://id-rc.undefineds.cn/').href).toBe('https://id-rc.undefineds.cn/');
    for (const value of [
      'http://id-rc.undefineds.cn/',
      'https://id.undefineds.co/',
      'https://id-rc.undefineds.cn/settings/',
      'https://user:pass@id-rc.undefineds.cn/',
      'http://127.0.0.1:3000/',
    ]) {
      expect(() => normalizeRcBaseUrl(value), value).toThrow(AcceptanceError);
    }
  });

  it('requires both deployment built-in models on HTTP 200', () => {
    expect(assertBuiltinModels(200, { data: [{ id: 'linx' }, { id: 'linx-lite' }] })).toEqual(['linx', 'linx-lite']);
    expect(() => assertBuiltinModels(500, { data: [] })).toThrow(/HTTP 500/u);
    expect(() => assertBuiltinModels(200, { data: [{ id: 'linx' }] })).toThrow(/linx-lite/u);
    expect(() => assertBuiltinModels(200, { data: 'not-an-array' })).toThrow(/malformed/u);
  });

  it('does not require the seed Pod root to be empty but requires the unique descendant scope to be empty', () => {
    expect(assertSparqlRoot(200, { results: { bindings: [{ s: { value: 'urn:seed' } }] } })).toBe(1);
    expect(() => assertSparqlRoot(500, {})).toThrow(/HTTP 500/u);
    expect(assertEmptyScopeAsk(200, { boolean: false })).toBe(false);
    expect(() => assertEmptyScopeAsk(200, { boolean: true })).toThrow(/not false/u);
    expect(assertEmptyScopeSelect(200, { results: { bindings: [] } })).toBe(0);
    expect(() => assertEmptyScopeSelect(200, { results: { bindings: [{}] } })).toThrow(/1 row/u);
  });

  it('accepts a real chat answer only when it stopped normally and contains the unique nonce', () => {
    const nonce = 'XPOD_RC_ABCDEF0123456789';
    const valid = { choices: [{ finish_reason: 'stop', message: { content: ` ${nonce}\n` } }] };
    expect(assertChatNonce(200, valid, 'linx', nonce).nonceSha256).toHaveLength(64);
    expect(() => assertChatNonce(200, { ...valid, choices: [...valid.choices, valid.choices[0]] }, 'linx', nonce))
      .toThrow(/exactly one choice/u);
    expect(() => assertChatNonce(200, { choices: [{ finish_reason: 'length', message: { content: nonce } }] }, 'linx', nonce))
      .toThrow(/stop normally/u);
    expect(() => assertChatNonce(200, { error: { message: 'upstream' } }, 'linx', nonce)).toThrow(/returned an error/u);
    expect(() => assertChatNonce(200, valid, 'linx', 'XPOD_RC_DIFFERENT')).toThrow(/unique nonce/u);
  });

  it('counts exactly one visible consent screen and one matching binding, not merely one radio', () => {
    expect(verifyRcConsentBinding(session())).toEqual({ consentScreenCount: 1, consentBindingCount: 1 });
    expect(verifyRcConsentBinding(session({
      consentSingleBindingOffered: false,
      storageBindingSelected: { webId: identity.webId, podUrl: identity.storageUrl },
    }))).toEqual({ consentScreenCount: 1, consentBindingCount: 1 });
    expect(verifyRcConsentBinding(session({
      consentSingleBindingOffered: false,
      consentBindingOptionCount: 1,
      consentWebIdSelected: identity.webId,
    }))).toEqual({ consentScreenCount: 1, consentBindingCount: 1 });
    expect(() => verifyRcConsentBinding(session({
      consentSingleBindingOffered: false,
      consentBindingOptionCount: 1,
      consentWebIdSelected: 'https://id-rc.undefineds.cn/bob/profile/card#me',
    }))).toThrow(/did not match/u);
    expect(() => verifyRcConsentBinding(session({ consentSurfaceCount: 0 }))).toThrow(/0 visible consent screen/u);
    expect(() => verifyRcConsentBinding(session({ consentSurfaceCount: 2 }))).toThrow(/2 visible consent screen/u);
    expect(() => verifyRcConsentBinding(session({ consentBindingOptionCount: 2 }))).toThrow(/2 WebID\/storage binding/u);
    expect(() => verifyRcConsentBinding(session({
      consentSingleBindingOffered: false,
      storageBindingSelected: { webId: 'https://id-rc.undefineds.cn/bob/profile/card#me', podUrl: identity.storageUrl },
    }))).toThrow(/did not match/u);
  });

  it('rejects a no-chooser surface whose single offered binding is wrong or missing', () => {
    expect(verifyRcConsentBinding(session())).toEqual({ consentScreenCount: 1, consentBindingCount: 1 });
    expect(verifyRcConsentBinding(session({
      consentSingleBindingOfferedBinding: { webId: identity.webId },
    }))).toEqual({ consentScreenCount: 1, consentBindingCount: 1 });
    expect(() => verifyRcConsentBinding(session({
      consentSingleBindingOfferedBinding: {
        webId: 'https://id-rc.undefineds.cn/bob/profile/card#me',
        storageUrl: identity.storageUrl,
      },
    }))).toThrow(/did not match/u);
    expect(() => verifyRcConsentBinding(session({
      consentSingleBindingOfferedBinding: {
        webId: identity.webId,
        storageUrl: 'https://pods-rc.undefineds.cn/bob/',
      },
    }))).toThrow(/did not match/u);
    expect(() => verifyRcConsentBinding(session({
      consentSingleBindingOfferedBinding: undefined,
    }))).toThrow(/did not match/u);
  });

  it('classifies only an unambiguous rendered WebID and optional storage URL as the offered binding', () => {
    expect(classifyConsentOfferedBindingSurface({
      titles: ['数据存在 Xpod 云端'],
      texts: [identity.webId, identity.webId],
    })).toEqual({ webId: identity.webId });
    expect(classifyConsentOfferedBindingSurface({
      titles: [identity.storageUrl],
      texts: [identity.webId],
    })).toEqual({ webId: identity.webId, storageUrl: identity.storageUrl });
    expect(classifyConsentOfferedBindingSurface({ titles: [], texts: [] })).toBeUndefined();
    expect(classifyConsentOfferedBindingSurface({
      titles: [],
      texts: [identity.webId, 'https://id-rc.undefineds.cn/bob/profile/card#me'],
    })).toBeUndefined();
    expect(classifyConsentOfferedBindingSurface({
      titles: [identity.storageUrl, 'https://pods-rc.undefineds.cn/bob/'],
      texts: [identity.webId],
    })).toBeUndefined();
  });

  async function runConsentDriver(mode: 'reload' | 'continuous' | 'missing-observer' | 'storage-get-throw' | 'storage-set-throw' | 'observer-unavailable' | 'unreliable-first-visible' | 'unrelated-initial-unobservable') {
    const consentHtml = `<!doctype html><html><body><main data-pod-sign-in-state="consent">
      <p title="${identity.webId}">${identity.webId}</p>
      <p title="${identity.storageUrl}">${identity.storageUrl}</p>
    </main></body></html>`;
    const url = 'https://id.example/.account/oidc/consent/';
    let dom = new JSDOM(consentHtml, { url });
    const initScripts: Array<{ fn: (arg?: unknown) => unknown; arg?: unknown }> = [];
    const events = new Map<string, Array<(value: unknown) => void>>();
    const falseLocator = {
      first() { return this; }, last() { return this; }, isVisible: async () => false,
      isEnabled: async () => false, count: async () => 0, innerText: async () => '',
      click: async () => undefined, evaluate: async () => undefined, evaluateAll: async () => [],
    };
    let calls = 0;
    let allowReturn = false;
    let failedOnce = false;
    const flush = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const prepareDocument = (savedSession: Array<[string, string]> = []) => {
      const consent = dom.window.document.querySelector('[data-pod-sign-in-state="consent"]')!;
      Object.defineProperty(consent, 'getBoundingClientRect', {
        value: () => ({ width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 }),
      });
      Object.defineProperty(dom.window.document, 'readyState', { value: 'complete', configurable: true });
      for (const [key, value] of savedSession) dom.window.sessionStorage.setItem(key, value);
      const savedStorage = dom.window.sessionStorage;
      const failGet = mode === 'storage-get-throw'
        || (mode === 'unrelated-initial-unobservable' && !failedOnce);
      const failSet = mode === 'storage-set-throw'
        || (mode === 'unreliable-first-visible' && !failedOnce);
      const storage: Storage = {
        get length() { return savedStorage.length; },
        clear() { savedStorage.clear(); },
        getItem(key) { if (failGet) throw new Error('storage get unavailable'); return savedStorage.getItem(key); },
        key(index) { return savedStorage.key(index); },
        removeItem(key) { savedStorage.removeItem(key); },
        setItem(key, value) { if (failSet) throw new Error('storage set unavailable'); savedStorage.setItem(key, value); },
      };
      vi.stubGlobal('window', dom.window);
      vi.stubGlobal('document', dom.window.document);
      vi.stubGlobal('sessionStorage', storage);
      vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
      vi.stubGlobal('MutationObserver', mode === 'observer-unavailable' ? undefined : dom.window.MutationObserver);
    };
    const runInitScripts = () => {
      for (const { fn, arg } of initScripts) fn(arg);
    };
    const reload = async () => {
      failedOnce = true;
      const savedSession: Array<[string, string]> = [];
      for (let index = 0; index < dom.window.sessionStorage.length; index += 1) {
        const key = dom.window.sessionStorage.key(index);
        if (key) savedSession.push([key, dom.window.sessionStorage.getItem(key) ?? '']);
      }
      dom.window.close();
      dom = new JSDOM(consentHtml, { url });
      prepareDocument(savedSession);
      runInitScripts();
      await flush();
    };
    prepareDocument();
    const consentLocator = {
      first() { return this; }, last() { return this; }, isEnabled: async () => true,
      innerText: async () => '', click: async () => undefined, evaluateAll: async () => [],
      evaluate: async (fn: (element: Element, arg?: unknown) => unknown, arg?: unknown) =>
        fn(dom.window.document.querySelector('[data-pod-sign-in-state="consent"]')!, arg),
      isVisible: async () => {
        calls += 1;
        if (mode === 'unrelated-initial-unobservable') {
          if (calls <= 2) return false;
          if (calls === 3) await reload();
          allowReturn = true;
          return true;
        }
        if (mode !== 'reload' && mode !== 'unreliable-first-visible') {
          allowReturn = calls >= 3;
          return true;
        }
        if (calls <= 2) return true;
        await reload();
        allowReturn = true;
        return true;
      },
      count: async () => 1,
    };
    const page = {
      bringToFront: async () => undefined,
      addInitScript: async (fn: (arg?: unknown) => unknown, arg?: unknown) => {
        if (mode === 'missing-observer') throw new Error('addInitScript unavailable');
        initScripts.push({ fn, arg });
      },
      goto: async () => { runInitScripts(); },
      url: () => dom.window.location.href,
      on: (name: string, fn: (value: unknown) => void) => {
        events.set(name, [...events.get(name) ?? [], fn]);
      },
      off: () => undefined,
      locator: (selector: string) => selector === '[data-pod-sign-in-state="consent"]' ? consentLocator : falseLocator,
      getByRole: () => falseLocator,
      getByText: () => falseLocator,
      evaluate: async (fn: (arg?: unknown) => unknown, arg?: unknown) => {
        if (mode === 'missing-observer' && fn.name === 'installConsentEpisodeCounter') {
          throw new Error('page-side counter unavailable');
        }
        return fn(arg);
      },
      waitForTimeout: async () => { await flush(); },
    } as any;
    try {
      const trace = await completeOidcLogin(page, {
        email: 'fixture@example.test',
        password: 'not-used',
      }, {
        baseUrl: 'https://id.example/',
        startUrl: url,
        timeoutMs: 2_000,
        ready: async () => allowReturn,
      });
      return trace;
    } finally {
      (dom.window as unknown as { __xpodConsentEpisodeObserver?: { disconnect(): void } })
        .__xpodConsentEpisodeObserver?.disconnect();
      vi.unstubAllGlobals();
      dom.window.close();
    }
  }

  it('counts same-URL reload as two consent episodes and rejects the RC gate', async () => {
    const trace = await runConsentDriver('reload');
    expect(trace.consentSurfaceCount).toBe(2);
    expect(trace.consentSingleBindingOfferedBinding).toEqual({
      webId: identity.webId,
      storageUrl: identity.storageUrl,
    });
    expect(() => verifyRcConsentBinding({
      identity,
      authenticatedFetch: (async () => new Response('')) as typeof fetch,
      trace: {
        ...trace,
        authorizationRequestSeen: true,
        authCodeChallengeMethodS256: true,
        callbackHasCode: true,
        callbackHasState: true,
      },
    })).toThrow(/2 visible consent screen/u);
  });

  it('keeps one continuously visible page as one consent episode and accepts it', async () => {
    const trace = await runConsentDriver('continuous');
    expect(trace.consentSurfaceCount).toBe(1);
    expect(verifyRcConsentBinding({
      identity,
      authenticatedFetch: (async () => new Response('')) as typeof fetch,
      trace: {
        ...trace,
        authorizationRequestSeen: true,
        authCodeChallengeMethodS256: true,
        callbackHasCode: true,
        callbackHasState: true,
      },
    })).toEqual({ consentScreenCount: 1, consentBindingCount: 1 });
  });

  it('does not accept a missing page-side observer as one consent screen', async () => {
    const trace = await runConsentDriver('missing-observer');
    expect(trace.consentSurfaceCount).toBe(0);
    expect(() => verifyRcConsentBinding({
      identity,
      authenticatedFetch: (async () => new Response('')) as typeof fetch,
      trace: {
        ...trace,
        authorizationRequestSeen: true,
        authCodeChallengeMethodS256: true,
        callbackHasCode: true,
        callbackHasState: true,
      },
    })).toThrow(/0 visible consent screen/u);
  });

  it('fails closed when page-side counter capability is unavailable', async () => {
    for (const mode of [
      'storage-get-throw',
      'storage-set-throw',
      'observer-unavailable',
      'unreliable-first-visible',
    ] as const) {
      const trace = await runConsentDriver(mode);
      expect(trace.consentSurfaceCount, mode).toBe(0);
      expect(() => verifyRcConsentBinding({
        identity,
        authenticatedFetch: (async () => new Response('')) as typeof fetch,
        trace: {
          ...trace,
          authorizationRequestSeen: true,
          authCodeChallengeMethodS256: true,
          callbackHasCode: true,
          callbackHasState: true,
        },
      }), mode).toThrow(/0 visible consent screen/u);
    }
  });

  it('does not poison the login when unobservable initial polls see no consent', async () => {
    const trace = await runConsentDriver('unrelated-initial-unobservable');
    expect(trace.consentSurfaceCount).toBe(1);
    expect(verifyRcConsentBinding({
      identity,
      authenticatedFetch: (async () => new Response('')) as typeof fetch,
      trace: {
        ...trace,
        authorizationRequestSeen: true,
        authCodeChallengeMethodS256: true,
        callbackHasCode: true,
        callbackHasState: true,
      },
    })).toEqual({ consentScreenCount: 1, consentBindingCount: 1 });
  });

  it('never publishes an arbitrary Account helper or server body', async () => {
    const body = 'UNLISTED_SERVER_BODY_that_must_not_escape_9f7c';
    const httpFailure = classifyCredentialIssuanceFailure(new Error(
      `POST Cloud controls.account.clientCredentials HTTP 502: ${body}`,
    ));
    expect(httpFailure).toEqual({ category: 'account-credential-server-error', status: 502 });
    expect(formatCredentialFailure(httpFailure)).toBe(
      'account-client-credential account-credential-server-error (HTTP 502)',
    );
    const nonJson = classifyCredentialIssuanceFailure(new Error(
      `POST Cloud controls.account.clientCredentials returned non-JSON: ${body}`,
    ));
    expect(nonJson).toEqual({ category: 'account-credential-invalid-json' });
    expect(describeAcceptanceFailure(new Error(body))).toBe('unexpected-error');
    expect(describeAcceptanceFailure(new RcEvidenceError('RC consent offered 2 WebID/storage binding(s)')))
      .toBe('RC consent offered 2 WebID/storage binding(s)');
    expect(JSON.stringify({ httpFailure, nonJson })).not.toContain(body);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rc-user-flows-error-'));
    tempRoots.push(root);
    const file = await writeEvidenceFile(root, evidence({
      checks: {
        ...evidence().checks,
        'rc-matrix-collaboration': { ok: false, detail: formatCredentialFailure(httpFailure) },
      },
    }), []);
    const published = await readFile(file, 'utf8');
    expect(published).not.toContain(body);
    expect(published).toContain('account-credential-server-error');
    expect(published).toContain('HTTP 502');
  });

  it('reads the Account token from the same browser context without publishing it', async () => {
    const page = {
      context: () => ({
        cookies: async () => [
          { name: 'other', value: 'ignored', expires: -1 },
          { name: 'css-account', value: 'account%2Dtoken', expires: -1 },
        ],
      }),
    } as any;
    await expect(readRcAccountToken(page, 'https://id-rc.undefineds.cn/')).resolves.toBe('account-token');
    expect(decodeAccountCookieValue('raw%ZZtoken')).toBe('raw%ZZtoken');
    await expect(readRcAccountToken({
      context: () => ({ cookies: async () => [] }),
    } as any, 'https://id-rc.undefineds.cn/')).rejects.toThrow(/Account session cookie/u);
  });

  it('bounds Matrix polling and publishes only a useful last status', async () => {
    let clock = 0;
    const sleep = async (ms: number): Promise<void> => { clock += ms; };
    const result = await boundedPoll({
      label: 'Bob sees message',
      timeoutMs: 100,
      intervalMs: 10,
      now: () => clock,
      sleep,
      probe: async (attempt) => attempt < 3
        ? { done: false, status: `HTTP 200 events=0 attempt=${attempt}` }
        : { done: true, value: 'event', status: 'HTTP 200 events=1' },
    });
    expect(result).toEqual({ value: 'event', attempts: 3 });

    await expect(boundedPoll({
      label: 'Bob sees message',
      timeoutMs: 20,
      intervalMs: 10,
      now: () => clock,
      sleep,
      probe: async () => ({ done: false, status: 'HTTP 503 retryable' }),
    })).rejects.toThrow(/timed out after 20ms after 3 attempt\(s\); last status: HTTP 503 retryable/u);

    await expect(boundedPoll({
      label: 'Bob sees message',
      timeoutMs: 0,
      now: () => clock,
      sleep,
      probe: async () => { throw new Error('Bearer SYNTHETIC_SECRET'); },
    })).rejects.toThrow(/last status: unexpected-error/u);

    await expect(boundedPoll({
      label: 'Bob sees message',
      timeoutMs: 0,
      now: () => clock,
      sleep,
      probe: async () => { throw new AcceptanceError('matrix fixed status'); },
    })).rejects.toThrow(/last status: matrix fixed status/u);
  });

  it('keeps credentials out of evidence and rejects any secret that reaches it', async () => {
    const secret = 'sk-SYNTHETICSECRETVALUE';
    expect(() => assertNoSecretMaterial('{"value":"safe"}', [secret])).not.toThrow();
    expect(() => assertNoSecretMaterial(`{"value":"${secret}"}`, [secret])).toThrow(/credential material/u);
    expect(() => assertNoSecretMaterial('{"value":"sk-abcdefgh"}', [])).toThrow(/credential material/u);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rc-user-flows-'));
    tempRoots.push(root);
    const file = await writeEvidenceFile(root, evidence(), [secret]);
    expect(JSON.parse(await readFile(file, 'utf8')).kind).toBe('xpod-rc-user-flows');
    await expect(writeEvidenceFile(root, evidence({
      checks: {
        ...evidence().checks,
        'rc-browser-consent': { ok: false, detail: `leaked ${secret}` },
      },
    }), [secret])).rejects.toThrow(/credential material/u);
  });

  it('wraps Account client credentials in the Matrix sk transport format without retaining plaintext', () => {
    const token = matrixSk('client-id', 'client-secret');
    expect(token.startsWith('sk-')).toBe(true);
    expect(Buffer.from(token.slice(3), 'base64').toString('utf8')).toBe('client-id:client-secret');
    expect(() => matrixSk('', 'client-secret')).toThrow(/incomplete/u);
  });

  it('type-checks the runner against current browser and Account helper contracts', () => {
    const entry = path.resolve('scripts/accept-rc-user-flows.ts');
    const program = ts.createProgram([entry], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      types: ['node'],
      noEmit: true,
    });
    expect(program.getSourceFile(entry)).toBeDefined();
    const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) =>
      diagnostic.file && path.resolve(diagnostic.file.fileName) === entry);
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });
});
