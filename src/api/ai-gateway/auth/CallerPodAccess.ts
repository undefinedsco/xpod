import type { AuthContext } from '../../auth/AuthContext';

export const CALLER_POD_ACCESS_UNAVAILABLE = 'caller_pod_access_unavailable';

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
    return upstream(input, {
      ...init,
      headers,
    });
  };
}

export function isInternalPodAccessAllowed(auth?: AuthContext): boolean {
  return !auth
    || auth.type !== 'solid'
    || auth.internalInvocation === true
    || auth.viaApiKey !== true;
}
