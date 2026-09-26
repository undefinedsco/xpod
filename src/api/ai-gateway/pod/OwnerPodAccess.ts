import { buildAuthenticatedFetch, createDpopHeader, generateDpopKeyPair } from '@inrupt/solid-client-authn-core';
import { getLoggerFor } from 'global-logger-factory';
import { hasSolidClientCredentialsAuthority, type AuthContext } from '../../auth/AuthContext';
import {
  CALLER_DPOP_REPLAY_UNSUPPORTED,
  CALLER_OWNER_MISMATCH,
  CALLER_POD_ACCESS_UNAVAILABLE,
  createCallerAuthenticatedPodFetch,
} from '../auth/CallerPodAccess';
import { resolveTokenEndpointRoute, type TokenEndpointRoute } from '../../auth/TokenEndpointRoute';
import { createHostedPodRouteTransport, type HostedPodRoute } from './HostedPodRoute';
import type {
  PodInterfaceCredential,
  PodInterfaceKeyAccess,
  PodInterfaceKeyGrant,
} from './PodInterfaceKeyStore';

/** No usable Pod credential is on file for this owner; the user has to grant one. */
export const POD_INTERFACE_KEY_MISSING = 'pod_interface_key_missing';
/** The owner's stored credential was refused by the Pod; it has to be granted again. */
export const POD_INTERFACE_KEY_REJECTED = 'pod_interface_key_rejected';

export interface PodAccessRequestContext {
  /** The authenticated caller, when the request carries one. */
  auth?: AuthContext;
  /** Physical Pod root when the identity WebID is hosted by a separate IdP. */
  podBaseUrl?: string;
}

/**
 * Source of a fetch that reaches an owner's Pod through its standard interface.
 *
 * `undefined` means no credential is on file, which is a state the caller reports to the user
 * rather than papers over.
 */
export interface PodAccessFetchProvider {
  getPodFetch(owner: string, context?: PodAccessRequestContext): Promise<typeof fetch | undefined>;
}

export interface OwnerPodAccessOptions {
  keys: PodInterfaceKeyAccess;
  /** Token endpoint of this deployment's Solid interface. */
  tokenEndpoint: string;
  /** Canonical base URL of that interface, used to keep the DPoP proof canonical. */
  publicBaseUrl?: string;
  /** Route this deployment exposes for its own hosted Pods, when one is needed. */
  route?: HostedPodRoute;
  fetch?: typeof fetch;
  now?: () => number;
}

interface CachedPodFetch {
  fetch: typeof fetch;
  expiresAt: number;
}

const TOKEN_EXPIRY_SKEW_MS = 30_000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 300;
const MAX_CACHED_TOKENS = 128;

/**
 * Reaches a Pod as its owner over the standard Solid interface.
 *
 * Three credentials can prove the owner, and all three are the owner's own interface key:
 * the caller's key, when the caller presented one; the caller's reusable token, when it holds
 * one; and the key the owner granted this deployment for work no caller is attached to.
 *
 * What never happens is asking the Solid server to trust the caller's network position. Every
 * request carries a credential for the owner and addresses the Pod's own URLs, so the Pod's own
 * authorization decides - exactly as it does for the browser.
 */
export class OwnerPodAccess implements PodAccessFetchProvider, PodInterfaceKeyGrant {
  private readonly logger = getLoggerFor(this);
  private readonly keys: PodInterfaceKeyAccess;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly tokenRoute: TokenEndpointRoute;
  private readonly route?: HostedPodRoute;
  private readonly podFetches = new Map<string, CachedPodFetch>();

  public constructor(options: OwnerPodAccessOptions) {
    this.keys = options.keys;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.tokenRoute = resolveTokenEndpointRoute(options.tokenEndpoint, options.publicBaseUrl);
    this.route = options.route;
  }

  /** Grant, or rotate, the owner's Pod interface key. */
  public async saveKey(owner: string, credential: PodInterfaceCredential): Promise<void> {
    await this.keys.saveKey(owner, credential);
    this.podFetches.clear();
  }

  public async forgetKey(owner: string): Promise<void> {
    await this.keys.forgetKey(owner);
    this.podFetches.clear();
  }

  public async hasKey(owner: string): Promise<boolean> {
    return await this.keys.hasKey(owner);
  }

  public async getPodFetch(
    owner: string,
    context: PodAccessRequestContext = {},
  ): Promise<typeof fetch | undefined> {
    const auth = context.auth;
    if (auth?.type === 'solid' && auth.webId !== owner) {
      // A caller authenticated as somebody else never borrows this owner's credential.
      return undefined;
    }
    if (hasSolidClientCredentialsAuthority(auth)) {
      // The caller's own interface key. Its exchanged token may be DPoP-bound to a proof that
      // was never kept, so the key is exchanged again with a key this process controls.
      return await this.credentialFetch(
        owner,
        { clientId: auth.clientId, clientSecret: auth.clientSecret },
      );
    }
    const callerFetch = createCallerAuthenticatedPodFetch(owner, auth, this.fetchImpl, this.route);
    if (callerFetch) {
      return callerFetch;
    }
    return await this.storedKeyFetch(owner);
  }

  private async storedKeyFetch(owner: string): Promise<typeof fetch | undefined> {
    const credential = await this.keys.read(owner);
    return credential ? await this.credentialFetch(owner, credential) : undefined;
  }

  private async credentialFetch(
    owner: string,
    credential: PodInterfaceCredential,
  ): Promise<typeof fetch> {
    const cacheKey = `${owner}\u0000${credential.clientId}`;
    const cached = this.podFetches.get(cacheKey);
    if (cached && cached.expiresAt > this.now() + TOKEN_EXPIRY_SKEW_MS) {
      return cached.fetch;
    }
    this.podFetches.delete(cacheKey);

    const exchanged = await this.exchange(owner, credential);
    this.podFetches.set(cacheKey, exchanged);
    pruneOldest(this.podFetches, MAX_CACHED_TOKENS);
    return exchanged.fetch;
  }

  private async exchange(owner: string, credential: PodInterfaceCredential): Promise<CachedPodFetch> {
    const dpopKey = await generateDpopKeyPair();
    const response = await this.fetchImpl(this.tokenRoute.url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${
          Buffer.from(`${credential.clientId}:${credential.clientSecret}`, 'utf8').toString('base64')
        }`,
        DPoP: await createDpopHeader(this.tokenRoute.proofUrl, 'POST', dpopKey),
        ...this.tokenRoute.headers,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'webid' }),
    });

    const body = await response.text().catch(() => '');
    if (!response.ok) {
      this.logger.warn(`Pod interface key refused for ${owner}: ${response.status} ${body.slice(0, 200)}`);
      throw new Error(`${POD_INTERFACE_KEY_REJECTED}:${response.status}`);
    }
    const token = parseTokenResponse(body);
    if (!token) {
      this.logger.warn(`Pod interface key exchange returned no access token for ${owner}`);
      throw new Error(`${POD_INTERFACE_KEY_REJECTED}:invalid_response`);
    }

    const transport = await createHostedPodRouteTransport(this.fetchImpl, this.route);
    const authenticated = buildAuthenticatedFetch(token.accessToken, {
      ...(token.dpopBound ? { dpopKey } : {}),
      fetch: transport,
    });
    return {
      fetch: this.invalidateOnUnauthorized(`${owner}\u0000${credential.clientId}`, authenticated),
      expiresAt: this.now() + token.expiresInSeconds * 1000,
    };
  }

  private invalidateOnUnauthorized(cacheKey: string, podFetch: typeof fetch): typeof fetch {
    return async (input, init) => {
      const response = await podFetch(input, init);
      if (response.status === 401) {
        // The token stopped being accepted; the next request exchanges the key again.
        this.podFetches.delete(cacheKey);
      }
      return response;
    };
  }
}

/**
 * Reason an owner's Pod is out of reach, as a stable code the caller and the UI can act on.
 *
 * A same-owner caller is the ordinary case: Xpod knows who the user is, but holds nothing it can
 * present to the Pod on the user's behalf. A browser session explains why its own credential was
 * not enough - its proof is bound to the URL it was made for - while a bearer session simply has
 * no Pod credential at all. Either way the fix is the same: grant the interface key.
 */
export function podAccessError(owner: string, auth?: AuthContext): string {
  if (!auth || auth.type !== 'solid') {
    return CALLER_POD_ACCESS_UNAVAILABLE;
  }
  if (auth.webId !== owner) {
    return CALLER_OWNER_MISMATCH;
  }
  if (auth.tokenType === 'DPoP' || typeof auth.dpopProof === 'string') {
    return CALLER_DPOP_REPLAY_UNSUPPORTED;
  }
  return POD_INTERFACE_KEY_MISSING;
}

/**
 * Whether a failure means Xpod had no usable way into the owner's Pod.
 *
 * The stable wire code for this is `service_access_missing`, which callers already report; the
 * codes below are the reason behind it, kept distinct so the UI can ask for the right fix.
 */
export function isPodAccessFailure(message: string): boolean {
  return message === 'service_access_missing'
    || message.startsWith(POD_INTERFACE_KEY_MISSING)
    || message.startsWith(POD_INTERFACE_KEY_REJECTED)
    || message.startsWith(CALLER_DPOP_REPLAY_UNSUPPORTED)
    || message.startsWith(CALLER_OWNER_MISMATCH)
    || message.startsWith(CALLER_POD_ACCESS_UNAVAILABLE);
}

function pruneOldest(cache: Map<string, CachedPodFetch>, limit: number): void {
  while (cache.size > limit) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    cache.delete(oldest.value);
  }
}

function parseTokenResponse(
  body: string,
): { accessToken: string; dpopBound: boolean; expiresInSeconds: number } | undefined {
  let parsed: { access_token?: unknown; token_type?: unknown; expires_in?: unknown };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return undefined;
  }
  if (typeof parsed.access_token !== 'string' || !parsed.access_token) {
    return undefined;
  }
  const expiresIn = typeof parsed.expires_in === 'number' && parsed.expires_in > 0
    ? parsed.expires_in
    : DEFAULT_TOKEN_LIFETIME_SECONDS;
  return {
    accessToken: parsed.access_token,
    dpopBound: String(parsed.token_type ?? 'DPoP').toUpperCase() !== 'BEARER',
    expiresInSeconds: expiresIn,
  };
}
