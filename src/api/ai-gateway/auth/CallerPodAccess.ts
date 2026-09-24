import type { AuthContext, SolidAuthContext } from '../../auth/AuthContext';
import { createHostedPodRouteTransport, type HostedPodRoute } from '../pod/HostedPodRoute';

export const CALLER_POD_ACCESS_UNAVAILABLE = 'caller_pod_access_unavailable';
export const CALLER_DPOP_REPLAY_UNSUPPORTED = 'caller_dpop_replay_unsupported';
export const CALLER_OWNER_MISMATCH = 'caller_owner_mismatch';

/**
 * Whether the caller presented a token that is its own Pod credential.
 *
 * The token was already verified against the Solid issuer - signature, expiry and owner - and
 * the owner check below binds it to the Pod being opened, so its origin does not matter: a
 * caller that holds a valid Bearer token for the owner may use it, whether or not the token
 * arrived wrapped as `sk-`. What is excluded is a principal Xpod authenticated for itself: a
 * gateway access key or a runtime invocation token proves the caller to the gateway, not to the
 * Pod, and forwarding one would turn a gateway credential into Pod access. A DPoP-bound token is
 * excluded as well, because replaying it needs the caller's private key, which never leaves the
 * caller.
 */
export function isCallerOwnPodBearer(
  owner: string,
  auth?: AuthContext,
): auth is SolidAuthContext & { accessToken: string; tokenType: 'Bearer' } {
  return auth?.type === 'solid'
    && auth.webId === owner
    && auth.viaGatewayApiKey !== true
    && auth.internalInvocation !== true
    && auth.tokenType === 'Bearer'
    && typeof auth.accessToken === 'string'
    && auth.accessToken.trim() !== '';
}

export function createCallerAuthenticatedPodFetch(
  owner: string,
  auth?: AuthContext,
  upstream: typeof fetch = fetch,
  route?: HostedPodRoute,
): typeof fetch | undefined {
  if (!isCallerOwnPodBearer(owner, auth)) {
    return undefined;
  }

  const accessToken = auth.accessToken;
  const authenticatedFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(
      init?.headers
      ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set('Authorization', `Bearer ${accessToken}`);
    // A Request body's encoded byte length can change when Bun/Undici replays
    // it with a new init object. Let the runtime calculate the framing.
    headers.delete('content-length');
    return upstream(input, {
      ...init,
      headers,
    });
  };
  if (!route) {
    return authenticatedFetch;
  }

  let routedFetch: Promise<typeof fetch> | undefined;
  return async (input, init) => {
    routedFetch ??= createHostedPodRouteTransport(authenticatedFetch, route);
    return (await routedFetch)(input, init);
  };
}
