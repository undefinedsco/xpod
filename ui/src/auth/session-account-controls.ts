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

  let response: Response;
  try {
    response = await options.fetch(index, {
      headers: { accept: 'application/json' },
      credentials: 'include',
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
  const collection = await resolveHostedAccountControlUrl(advertised, options.fetch, index);
  return collection ? { collection, webId: options.webId } : undefined;
}

function normalizeAccountIndex(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || !url.pathname.startsWith('/.account/')) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}
