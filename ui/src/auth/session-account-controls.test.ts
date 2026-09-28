import { describe, expect, it, vi } from 'vitest';
import { readSessionAccountControls } from './session-account-controls';

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
      credentials: 'include',
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
