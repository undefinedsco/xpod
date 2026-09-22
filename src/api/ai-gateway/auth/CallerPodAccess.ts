import type { AuthContext } from '../../auth/AuthContext';
import { createHostedPodRouteTransport, type HostedPodRoute } from '../pod/HostedPodRoute';

export const CALLER_POD_ACCESS_UNAVAILABLE = 'caller_pod_access_unavailable';
export const CALLER_DPOP_REPLAY_UNSUPPORTED = 'caller_dpop_replay_unsupported';
export const CALLER_OWNER_MISMATCH = 'caller_owner_mismatch';

export function createCallerAuthenticatedPodFetch(
  owner: string,
  auth?: AuthContext,
  upstream: typeof fetch = fetch,
  route?: HostedPodRoute,
): typeof fetch | undefined {
  if (
    !auth
    || auth.type !== 'solid'
    || auth.webId !== owner
    || auth.viaApiKey !== true
    || auth.tokenType !== 'Bearer'
    || typeof auth.accessToken !== 'string'
    || auth.accessToken.trim() === ''
  ) {
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
