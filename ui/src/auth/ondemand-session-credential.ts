import type { AiClientCredentialsCapability } from '@undefineds.co/extension-sdk/web';
import { createAccountClientCredentialsCapability } from './account-client-credentials';
import { createSessionAccountFetch, readSessionAccountControls } from './session-account-controls';
import { fetchAccountStorageBindings } from './account-storage-bindings';
import {
  createSessionRequestCredential,
  type SessionRequestCredential,
} from './session-request-credential';
import { resolveHostedAccountControlUrl } from '../utils/account-control-url';
import { storedAccountTokenHeaders } from '../utils/account-session';

/**
 * Resolve a Pod-access credential at the moment a request needs one.
 *
 * The page usually knows its Account binding before anything reads the Pod, but
 * the first Pod-backed request of a freshly signed-in session can arrive while
 * the Account controls are still loading. Waiting for that state would leave the
 * caller holding the API's 403 `service_access_missing` with no retry, which
 * reads to the user as "AI is broken" even though nothing is wrong with the Pod.
 *
 * Both bindings the page can legitimately use are tried here: an Account cookie
 * explicitly linked to the current WebID, and the Account index read with the
 * page's own Solid session, independently of that cookie.
 */
export interface AccountBindingLike {
  collection: string;
  webId: string;
  assertCurrent: () => void;
  /** Session-bound fetch for a binding that was resolved through the session. */
  fetch?: typeof fetch;
}

export interface ResolveOnDemandSessionCredentialOptions {
  /** Account authority of this page, as resolved from the deployment. */
  accountIndex?: string;
  /** WebID of the current Solid session. */
  webId?: string;
  /** A binding the page already resolved. */
  binding?: AccountBindingLike;
  /** Cookie-capable fetch for the Account authority. */
  accountFetch: typeof fetch;
  /** Session-bound fetch, used for the Account credential lifecycle. */
  sessionFetch?: typeof fetch;
  /** Refuse work once the session moved on. */
  assertCurrent: (webId: string) => void;
  /** Test seam. */
  createCredential?: (options: { capability: AiClientCredentialsCapability; webId: string }) => SessionRequestCredential;
}

export async function resolveOnDemandSessionCredential(
  options: ResolveOnDemandSessionCredentialOptions,
): Promise<SessionRequestCredential | undefined> {
  const capability = await resolveOnDemandSessionCapability(options);
  if (!capability || !options.webId) return undefined;
  const create = options.createCredential
    ?? ((input: { capability: AiClientCredentialsCapability; webId: string }) => createSessionRequestCredential(input));
  return create({ capability, webId: options.webId });
}

/** Resolve once inside the session holder's pending issuance, never in a mount effect. */
export async function resolveOnDemandSessionCapability(
  options: ResolveOnDemandSessionCredentialOptions,
): Promise<AiClientCredentialsCapability | undefined> {
  if (!options.accountIndex || !options.webId) return undefined;
  options.assertCurrent(options.webId);
  const binding = options.binding ?? await readCookieBinding(options) ?? await readSessionBinding(options);
  options.assertCurrent(options.webId);
  if (!binding || binding.webId !== options.webId) return undefined;
  binding.assertCurrent();
  return createAccountClientCredentialsCapability({
    collection: binding.collection,
    assertCurrent: () => {
      options.assertCurrent(options.webId!);
      binding.assertCurrent();
    },
    accountIndex: options.accountIndex,
    ...(binding.fetch ? { fetch: binding.fetch } : {}),
  });
}

/** The Account authority answers its own cookie session with the full controls. */
async function readCookieBinding(
  options: ResolveOnDemandSessionCredentialOptions,
): Promise<AccountBindingLike | undefined> {
  const index = options.accountIndex!;
  const webId = options.webId!;
  try {
    const url = new URL(index);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/.account/' || url.search || url.hash) return undefined;
  } catch { return undefined; }
  let response: Response;
  try {
    response = await options.accountFetch(index, {
      headers: storedAccountTokenHeaders({ accept: 'application/json' }, index),
      credentials: 'include',
      redirect: 'error',
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;

  const body = await response.json().catch(() => undefined) as
    | { controls?: { account?: { clientCredentials?: string; bindings?: string } } }
    | undefined;
  const advertised = body?.controls?.account?.clientCredentials;
  if (typeof advertised !== 'string' || !advertised) return undefined;
  // Both controls must remain on the authenticated Account authority.
  try {
    for (const value of [advertised, body?.controls?.account?.bindings]) {
      if (typeof value !== 'string' || !value) return undefined;
      const url = new URL(value, index);
      if (url.origin !== new URL(index).origin || !url.pathname.startsWith('/.account/')
        || url.username || url.password || url.hash) return undefined;
    }
  } catch { return undefined; }

  // The credential control alone says nothing about which WebID the cookie owns.
  const bindings = await fetchAccountStorageBindings({
    controls: body?.controls,
    fetchImpl: options.accountFetch,
    trustedAccountIndex: index,
  }).catch(() => undefined);
  options.assertCurrent(webId);
  if (!bindings?.some((binding) => binding.webId === webId)) return undefined;

  const collection = await resolveHostedAccountControlUrl(advertised, options.accountFetch, index);
  return collection
    ? { collection, webId, assertCurrent: () => options.assertCurrent(webId), fetch: options.accountFetch }
    : undefined;
}

/** Read the session actor independently of any Account cookie actor. */
async function readSessionBinding(
  options: ResolveOnDemandSessionCredentialOptions,
): Promise<AccountBindingLike | undefined> {
  if (!options.sessionFetch) return undefined;
  const webId = options.webId!;
  const sessionFetch = createSessionAccountFetch({
    accountIndex: options.accountIndex!,
    fetch: options.sessionFetch,
    assertCurrent: () => options.assertCurrent(webId),
  });
  const controls = await readSessionAccountControls({
    accountIndex: options.accountIndex!,
    webId,
    fetch: sessionFetch,
  }).catch(() => undefined);
  if (!controls) return undefined;
  return {
    collection: controls.collection,
    webId: controls.webId,
    assertCurrent: () => options.assertCurrent(controls.webId),
    fetch: sessionFetch,
  };
}
