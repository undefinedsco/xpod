import { resolvePodBaseUrl } from '@undefineds.co/drizzle-solid';

export type PodBaseUrlResolver = (webId: string) => Promise<string | undefined>;

export async function resolveOwnerPodBaseUrl(
  webId: string,
  resolver?: PodBaseUrlResolver,
): Promise<string> {
  const resolved = await resolver?.(webId);
  return normalizePodBaseUrl(resolved ?? resolvePodBaseUrl(webId));
}

function normalizePodBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Pod storage URL must use http or https');
  }
  url.hash = '';
  url.search = '';
  if (!url.pathname.endsWith('/')) {
    url.pathname += '/';
  }
  return url.href;
}
