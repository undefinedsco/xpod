import { resolveHostedAccountControlUrl } from '../utils/account-control-url';

/**
 * The Account controls a page can only read with the session that owns its WebID.
 *
 * CSS issues the Account cookie on the account authority's own origin. A page the
 * Xpod Gateway serves never sees that cookie, so the Account API answers it as
 * anonymous and the client-credential control stays hidden - which is why a WebID
 * login could not hand the API a credential for the user's own Pod.
 *
 * The page does hold the WebID session Xpod signed it in with. The account
 * authority resolves that WebID to the Account it is already linked to, so the same
 * controls become readable with the session itself: no second password step, no
 * deployment-wide service identity, and the session can only ever reach its own
 * Account.
 */
export interface SessionAccountControls {
  /** The Account's own client-credential collection. */
  collection: string;
  /** The WebID the Account was resolved from. */
  webId: string;
}

export interface ReadSessionAccountControlsOptions {
  /** The Account authority to read, as resolved from the deployment. */
  accountIndex: string;
  /** The WebID of the current Solid session. */
  webId: string;
  /** Session-bound fetch: it signs the request with the session's own DPoP key. */
  fetch: typeof fetch;
}

/**
 * Read the Account index with the host's own Solid session.
 *
 * Returns nothing when the session cannot read it - an anonymous or expired
 * session, an authority that does not accept it, or a WebID no Account linked.
 * Callers treat that as "this page has no Account credential to offer" rather than
 * as an error, because the WebID session itself stays valid either way.
 */
export async function readSessionAccountControls(
  options: ReadSessionAccountControlsOptions,
): Promise<SessionAccountControls | undefined> {
  const index = normalizeAccountIndex(options.accountIndex);
  if (!index) {
    return undefined;
  }

  const sessionFetch = createSessionAccountFetch(options);
  let response: Response;
  try {
    response = await sessionFetch(index, {
      headers: { accept: 'application/json' },
      credentials: 'omit',
    });
  } catch {
    return undefined;
  }
  if (!response.ok) {
    return undefined;
  }

  const body = await response.json().catch(() => undefined) as
    | { controls?: { account?: { clientCredentials?: unknown } } }
    | undefined;
  const advertised = body?.controls?.account?.clientCredentials;
  if (typeof advertised !== 'string' || !advertised) {
    return undefined;
  }

  // The control is only trusted when it stays on the authority that advertised it.
  const collection = await resolveHostedAccountControlUrl(advertised, sessionFetch, index);
  if (!collection) return undefined;
  const control = new URL(collection, index);
  return control.origin === new URL(index).origin && control.pathname.startsWith('/.account/')
    && !control.username && !control.password && !control.hash
    ? { collection, webId: options.webId } : undefined;
}

/** Keep the Account cookie actor separate from the SDK's DPoP actor. */
export function createSessionAccountFetch(options: {
  accountIndex: string;
  fetch: typeof fetch;
  assertCurrent?: () => void;
}): typeof fetch {
  const index = normalizeAccountIndex(options.accountIndex);
  return async (input, init) => {
    options.assertCurrent?.();
    if (!index) throw new Error('Invalid session Account authority');
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    if (/^CSS-Account-Token(?:\s|$)/iu.test(headers.get('authorization') ?? '')) {
      headers.delete('authorization');
    }
    const effectiveInit = { ...init, headers, credentials: 'omit' as const, redirect: 'error' as const };
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== new URL(index).origin || !url.pathname.startsWith('/.account/')
      || url.username || url.password || url.hash) {
      throw new Error('Session Account request leaves the trusted authority');
    }
    const request = new Request(input, effectiveInit);
    const response = input instanceof Request
      ? await options.fetch(request)
      : await options.fetch(request.url, effectiveInit);
    try { options.assertCurrent?.(); } catch (error) {
      void response.body?.cancel().catch(() => undefined);
      throw error;
    }
    return response;
  };
}

function normalizeAccountIndex(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/.account/' || url.search || url.hash) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}
