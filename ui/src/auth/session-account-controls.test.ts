import { describe, expect, it, vi } from 'vitest';
import { createSessionAccountFetch, readSessionAccountControls } from './session-account-controls';

const ACCOUNT_INDEX = 'https://id.example/.account/';
const WEB_ID = 'https://id.example/ada/profile/card#me';
const COLLECTION = 'https://id.example/.account/account/account-1/client-credentials/';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('readSessionAccountControls', () => {
  it('reads the client-credential collection with the session fetch', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      controls: { account: { clientCredentials: COLLECTION } },
    }));

    await expect(readSessionAccountControls({
      accountIndex: ACCOUNT_INDEX,
      webId: WEB_ID,
      fetch: fetchImpl as unknown as typeof fetch,
    })).resolves.toEqual({ collection: COLLECTION, webId: WEB_ID });

    expect(fetchImpl).toHaveBeenCalledWith(ACCOUNT_INDEX, expect.objectContaining({
      credentials: 'omit', redirect: 'error',
    }));
  });

  it('returns nothing while the authority still answers as anonymous', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ controls: { account: { create: 'https://id.example/.account/account/' } } }));

    await expect(readSessionAccountControls({
      accountIndex: ACCOUNT_INDEX,
      webId: WEB_ID,
      fetch: fetchImpl as unknown as typeof fetch,
    })).resolves.toBeUndefined();
  });

  it('refuses a control that leaves the account authority', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      controls: { account: { clientCredentials: 'https://evil.example/.account/account/1/client-credentials/' } },
    }));

    await expect(readSessionAccountControls({
      accountIndex: ACCOUNT_INDEX,
      webId: WEB_ID,
      fetch: fetchImpl as unknown as typeof fetch,
    })).resolves.toBeUndefined();
  });

  it('returns nothing when the request itself fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(readSessionAccountControls({
      accountIndex: ACCOUNT_INDEX,
      webId: WEB_ID,
      fetch: fetchImpl as unknown as typeof fetch,
    })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns nothing for a refused authority response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 403));

    await expect(readSessionAccountControls({
      accountIndex: ACCOUNT_INDEX,
      webId: WEB_ID,
      fetch: fetchImpl as unknown as typeof fetch,
    })).resolves.toBeUndefined();
  });

  it('does not read an Account authority that is not an account index', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));

    await expect(readSessionAccountControls({
      accountIndex: 'https://id.example/pod/',
      webId: WEB_ID,
      fetch: fetchImpl as unknown as typeof fetch,
    })).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});


describe('createSessionAccountFetch', () => {
  it('preserves Request bodies, signals and merged headers while isolating the SDK actor', async () => {
    const controller = new AbortController();
    const request = new Request(COLLECTION, {
      method: 'POST', body: JSON.stringify({ webId: WEB_ID }), signal: controller.signal,
      credentials: 'include', redirect: 'follow', headers: {
        authorization: 'cSs-AcCoUnT-ToKeN cookie-bob', 'x-request': 'retained', 'x-override': 'before',
      },
    });
    let forwarded: Request | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      forwarded = new Request(input, init);
      return jsonResponse({});
    });
    const guarded = createSessionAccountFetch({ accountIndex: ACCOUNT_INDEX, fetch: fetchImpl });
    await guarded(request, { headers: { 'x-init': 'retained', 'x-override': 'after' } });
    expect(forwarded?.credentials).toBe('omit');
    expect(forwarded?.redirect).toBe('error');
    expect(forwarded?.method).toBe('POST');
    expect(await forwarded?.json()).toEqual({ webId: WEB_ID });
    expect(forwarded?.headers.get('authorization')).toBeNull();
    expect(forwarded?.headers.get('x-request')).toBe('retained');
    expect(forwarded?.headers.get('x-init')).toBe('retained');
    expect(forwarded?.headers.get('x-override')).toBe('after');
    controller.abort();
    expect(forwarded?.signal.aborted).toBe(true);
  });

  it('preserves the SDK authorization while overriding cookie and redirect settings', async () => {
    const fetchImpl = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>(async () => jsonResponse({}));
    await createSessionAccountFetch({ accountIndex: ACCOUNT_INDEX, fetch: fetchImpl })(ACCOUNT_INDEX, {
      headers: { Authorization: 'DPoP sdk-alice' }, credentials: 'include', redirect: 'follow',
    });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBe('DPoP sdk-alice');
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
  });

  it.each([
    'https://evil.example/.account/', 'https://id.example/pod/',
    'https://user:password@id.example/.account/', 'http://id.example/.account/',
    'https://id.example/.account/#fragment',
  ])('refuses requests outside the exact authority: %s', async (url) => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await expect(createSessionAccountFetch({ accountIndex: ACCOUNT_INDEX, fetch: fetchImpl })(url))
      .rejects.toThrow('trusted authority');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a late response after the captured session ends', async () => {
    let active = true;
    const guarded = createSessionAccountFetch({
      accountIndex: ACCOUNT_INDEX,
      fetch: async () => { active = false; return jsonResponse({}); },
      assertCurrent: () => { if (!active) throw new Error('session ended'); },
    });
    await expect(guarded(ACCOUNT_INDEX)).rejects.toThrow('session ended');
  });
});
