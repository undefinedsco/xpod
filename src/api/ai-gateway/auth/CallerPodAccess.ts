import type { AuthContext } from '../../auth/AuthContext';

interface SolidLocalRoute {
  canonicalBaseUrl: string;
  localBaseUrl: string;
}

type CreateSolidLocalRouteFetch = (options: {
  fetch: typeof fetch;
  routes: () => readonly SolidLocalRoute[];
}) => typeof fetch;

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
  const route = localHostedPodRoute();
  if (!route) {
    return authenticatedFetch;
  }

  // The API runtime is CommonJS while solid-sdk is intentionally ESM-only.
  // Keep the package boundary and load the SDK lazily without TypeScript
  // lowering import() to require().
  let routedFetch: Promise<typeof fetch> | undefined;
  return async (input, init) => {
    routedFetch ??= importSolidLocalRouteFetch().then(({ createSolidLocalRouteFetch }) =>
      createSolidLocalRouteFetch({ fetch: authenticatedFetch, routes: () => [route] }));
    return (await routedFetch)(input, init);
  };
}

async function importSolidLocalRouteFetch(): Promise<
  { createSolidLocalRouteFetch: CreateSolidLocalRouteFetch }
> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<{ createSolidLocalRouteFetch: CreateSolidLocalRouteFetch }>;
  return dynamicImport('@undefineds.co/solid-sdk/local-route-fetch');
}

function localHostedPodRoute(): SolidLocalRoute | undefined {
  const canonicalBaseUrl = process.env.CSS_BASE_URL?.trim();
  const mainPort = process.env.XPOD_MAIN_PORT?.trim();
  if (!canonicalBaseUrl || !mainPort || !/^\d+$/u.test(mainPort)) {
    return undefined;
  }
  return {
    canonicalBaseUrl,
    localBaseUrl: `http://127.0.0.1:${mainPort}/`,
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
    || (auth?.type === 'solid' && (
      auth.viaApiKey === true
      ||
      auth.internalInvocation === true
      || (auth.viaGatewayApiKey === true && auth.gatewayRuntimeAccess === true)
    ));
}
