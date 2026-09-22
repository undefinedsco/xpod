import { localServiceUrl } from '../../../runtime/bootstrap';

export interface HostedPodRoute {
  /** Canonical Pod/container URL used for RDF identity and public access. */
  canonicalBaseUrl: string;
  /** Same resource tree exposed by the local Xpod Gateway. */
  localBaseUrl: string;
}

type CreateSolidLocalRouteFetch = (options: {
  fetch: typeof fetch;
  routes: () => readonly HostedPodRoute[];
}) => typeof fetch;

/**
 * The route that reaches this deployment's hosted Pods from inside the API sidecar.
 *
 * The inputs are resolved where they are known - when the runtime builds its services - and not
 * read from the environment per request: the runtime restores the environment it borrowed once
 * its services are up, so a lazy lookup would silently find nothing and address the Pod's
 * canonical URL instead of the route that is actually reachable.
 */
export function resolveHostedPodRoute(input: {
  canonicalBaseUrl?: string;
  gatewayHost?: string;
  gatewayPort?: string | number;
}): HostedPodRoute | undefined {
  const canonicalBaseUrl = input.canonicalBaseUrl?.trim();
  const gatewayPort = String(input.gatewayPort ?? '').trim();
  if (!canonicalBaseUrl || !/^\d+$/u.test(gatewayPort)) {
    return undefined;
  }
  return {
    canonicalBaseUrl,
    // The gateway has to be reached on the address it actually bound: `localhost` may be
    // IPv6-only, and a wildcard bind is not connectable on every platform.
    localBaseUrl: `${localServiceUrl(input.gatewayHost, Number(gatewayPort))}/`,
  };
}

/**
 * Wrap a transport so canonical Pod URLs are sent over the gateway route.
 *
 * This belongs *under* a DPoP signer, never wrapped around an authenticated fetch: the proof is
 * made for the canonical URL, and this layer only replaces the wire target, so a DPoP-bound
 * request stays bound to the URL the caller named.
 */
export async function createHostedPodRouteTransport(
  transport: typeof fetch,
  route: HostedPodRoute | undefined,
): Promise<typeof fetch> {
  if (!route) {
    return transport;
  }
  const { createSolidLocalRouteFetch } = await importSolidLocalRouteFetch();
  return createSolidLocalRouteFetch({ fetch: transport, routes: () => [route] });
}

async function importSolidLocalRouteFetch(): Promise<{
  createSolidLocalRouteFetch: CreateSolidLocalRouteFetch;
}> {
  // The API runtime is CommonJS while solid-sdk is intentionally ESM-only. Keep the package
  // boundary and load the SDK without TypeScript lowering import() to require().
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<{ createSolidLocalRouteFetch: CreateSolidLocalRouteFetch }>;
  return dynamicImport('@undefineds.co/solid-sdk/local-route-fetch');
}
