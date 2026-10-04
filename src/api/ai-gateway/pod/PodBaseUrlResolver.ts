import type { AuthContext } from '../../auth/AuthContext';
import type { PodLookupRepository } from '../../../identity/drizzle/PodLookupRepository';
import { resolvePodBaseUrl } from '@undefineds.co/drizzle-solid';

export type PodBaseUrlResolver = ((webId: string, requestedPodUrl?: string) => Promise<string | undefined>) & {
  /** Canonical roots registered to the exact owner, for bounded verifier lookups only. */
  ownedPodUrls?: (webId: string) => Promise<string[]>;
};

export async function resolveOwnerPodBindings(webId: string, resolver?: PodBaseUrlResolver): Promise<string[]> {
  if (!resolver) throw new Error('service_access_missing');
  if (resolver.ownedPodUrls) return resolver.ownedPodUrls(webId);
  const root = await resolver(webId);
  return root ? [normalizeVerifiedPodRoot(root)] : [];
}

export async function resolveOwnerPodBaseUrl(
  webId: string,
  resolver?: PodBaseUrlResolver,
  auth?: AuthContext,
): Promise<string> {
  const solidAuth = auth?.type === 'solid' ? auth : undefined;
  if (solidAuth && solidAuth.webId !== webId) throw new Error('caller_owner_mismatch');
  const requested = solidAuth?.requestedPodUrl;
  const authorized = solidAuth?.authorizedPodUrl;
  if (requested && (solidAuth?.viaGatewayApiKey || solidAuth?.internalInvocation) && !authorized) {
    throw new Error('service_access_missing');
  }
  const selected = requested ?? authorized;
  const resolved = await resolver?.(webId, selected);
  if ((resolver || selected) && !resolved) throw new Error('service_access_missing');
  const podUrl = normalizeVerifiedPodRoot(resolved ?? resolvePodBaseUrl(webId));
  if (authorized && podUrl !== normalizeVerifiedPodRoot(authorized)) throw new Error('service_access_missing');
  return podUrl;
}

/** Only repository-verified ownership and storage bindings may authorize a selected Pod. */
export function createOwnerPodBaseUrlResolver(
  repository: Pick<PodLookupRepository, 'findByWebId' | 'findAllByWebId'> | undefined,
  selection: 'first' | 'unique' = 'first',
): PodBaseUrlResolver {
  const resolver: PodBaseUrlResolver = async (webId, requestedPodUrl) => {
    const pods = selection === 'unique' || requestedPodUrl !== undefined
      ? await repository?.findAllByWebId(webId) ?? []
      : [await repository?.findByWebId(webId)];
    if (requestedPodUrl !== undefined) {
      const requested = normalizeVerifiedPodRoot(requestedPodUrl);
      const owned = pods.filter(pod => [pod?.storageUrl, pod?.baseUrl].some(root =>
        root !== undefined && normalizeVerifiedPodRoot(root) === requested));
      const roots = new Set(owned.flatMap(pod => {
        const root = pod?.storageUrl ?? pod?.baseUrl;
        return root ? [normalizeVerifiedPodRoot(root)] : [];
      }));
      if (roots.size > 1) throw new Error('Authoritative Pod storage binding ambiguous');
      return roots.values().next().value;
    }
    const roots = pods.flatMap(pod => {
      const root = pod?.storageUrl ?? pod?.baseUrl;
      return root ? [root] : [];
    });
    if (selection === 'first') return roots[0];
    const normalized = new Set(roots.map(normalizeVerifiedPodRoot));
    if (normalized.size > 1) throw new Error('Authoritative Pod storage binding ambiguous');
    return normalized.values().next().value;
  };
  resolver.ownedPodUrls = async webId => {
    const pods = await repository?.findAllByWebId(webId) ?? [];
    return [...new Set(pods.flatMap(pod => {
      const root = pod.storageUrl ?? pod.baseUrl;
      return root ? [normalizeVerifiedPodRoot(root)] : [];
    }))];
  };
  return resolver;
}

export function normalizeVerifiedPodRoot(value: string): string {
  const url = new URL(value);
  if (value !== value.trim() || /[\s\\?#]/u.test(value)
    || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid Pod storage binding');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  if (url.href !== (value.endsWith('/') ? value : `${value}/`)) throw new Error('Invalid Pod storage binding');
  return url.href;
}
