import type { AuthContext } from '../../auth/AuthContext';

export const CALLER_POD_ACCESS_UNAVAILABLE = 'caller_pod_access_unavailable';
export const CALLER_DPOP_REPLAY_UNSUPPORTED = 'caller_dpop_replay_unsupported';
export const CALLER_OWNER_MISMATCH = 'caller_owner_mismatch';

export function createCallerAuthenticatedPodFetch(
  owner: string,
  auth?: AuthContext,
  upstream: typeof fetch = fetch,
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
  return async (input, init) => {
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
}

export function callerPodAccessError(owner: string, auth?: AuthContext): string {
  if (!auth || auth.type !== 'solid') {
    return CALLER_POD_ACCESS_UNAVAILABLE;
  }
  if (auth.webId !== owner) {
    return CALLER_OWNER_MISMATCH;
  }
  if (auth.tokenType === 'DPoP' || typeof auth.dpopProof === 'string') {
    return CALLER_DPOP_REPLAY_UNSUPPORTED;
  }
  return CALLER_POD_ACCESS_UNAVAILABLE;
}

export function isInternalPodAccessAllowed(
  auth?: AuthContext,
  options: { explicitInternalAccess?: boolean } = {},
): boolean {
  return options.explicitInternalAccess === true
    || (auth?.type === 'solid' && auth.internalInvocation === true);
}
