import type { AiClientCredentialsCapability } from '@undefineds.co/extension-sdk/web';
import { createAccountClientCredentialsCapability } from './account-client-credentials';
import { readSessionAccountControls } from './session-account-controls';
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
 * Both bindings the page can legitimately use are tried here: the Account cookie
 * it already holds, and - when the Gateway serves the page and no cookie exists -
 * the same Account index read with the page's own Solid session.
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
  /** Session-bound fetch, used only to read the Account index. */
  sessionFetch?: typeof fetch;
  /** Refuse work once the session moved on. */
  assertCurrent: (webId: string) => void;
  /** Test seam. */
  createCredential?: (options: { capability: AiClientCredentialsCapability; webId: string }) => SessionRequestCredential;
}

export async function resolveOnDemandSessionCredential(
  options: ResolveOnDemandSessionCredentialOptions,
): Promise<SessionRequestCredential | undefined> {
  if (!options.accountIndex || !options.webId) return undefined;

  const binding = options.binding ?? await readCookieBinding(options) ?? await readSessionBinding(options);
  if (!binding) return undefined;

  const capability = createAccountClientCredentialsCapability({
    collection: binding.collection,
    assertCurrent: binding.assertCurrent,
    accountIndex: options.accountIndex,
    ...(binding.fetch ? { fetch: binding.fetch } : {}),
  });
  const create = options.createCredential
    ?? ((input: { capability: AiClientCredentialsCapability; webId: string }) => createSessionRequestCredential(input));
  return create({ capability, webId: binding.webId });
}

/** The Account authority answers its own cookie session with the full controls. */
async function readCookieBinding(
  options: ResolveOnDemandSessionCredentialOptions,
): Promise<AccountBindingLike | undefined> {
  const index = options.accountIndex!;
  const webId = options.webId!;
  let response: Response;
  try {
    response = await options.accountFetch(index, {
      headers: storedAccountTokenHeaders({ accept: 'application/json' }, index),
      credentials: 'include',
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;

  const body = await response.json().catch(() => undefined) as
    | { controls?: { account?: { clientCredentials?: unknown } } }
    | undefined;
  const advertised = body?.controls?.account?.clientCredentials;
  if (typeof advertised !== 'string' || !advertised) return undefined;

  const collection = await resolveHostedAccountControlUrl(advertised, options.accountFetch, index);
  return collection
    ? { collection, webId, assertCurrent: () => options.assertCurrent(webId), fetch: options.accountFetch }
    : undefined;
}

/** Cookie-less pages read the same index with the session that owns the WebID. */
async function readSessionBinding(
  options: ResolveOnDemandSessionCredentialOptions,
): Promise<AccountBindingLike | undefined> {
  if (!options.sessionFetch) return undefined;
  const webId = options.webId!;
  const controls = await readSessionAccountControls({
    accountIndex: options.accountIndex!,
    webId,
    fetch: options.sessionFetch,
  }).catch(() => undefined);
  if (!controls) return undefined;
  return {
    collection: controls.collection,
    webId: controls.webId,
    assertCurrent: () => options.assertCurrent(controls.webId),
    fetch: options.sessionFetch,
  };
}
