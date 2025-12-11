import { Parser } from 'n3';

const storageRel = 'http://www.w3.org/ns/pim/space#storage';

const normalizeBase = (value: string): string => (value.endsWith('/') ? value : `${value}/`);

const parseStorageFromLink = (linkValue: string | null): string | undefined => {
  if (!linkValue) return undefined;
  for (const part of linkValue.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="http:\/\/www\.w3\.org\/ns\/pim\/space#storage"/);
    if (match?.[1]) return match[1];
  }
  return undefined;
};

/**
 * Resolve pod base from WebID (pim:storage or fallback to pod-id segment / issuer).
 */
export async function resolvePodBase(
  doFetch: typeof fetch,
  webId: string,
  assertSuccess: (response: Response, step: string) => Promise<void>,
  fallbackBase?: string,
): Promise<string> {
  const computeFallback = (): string => {
    try {
      const url = new URL(webId);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length > 0) {
        return normalizeBase(`${url.origin}/${parts[0]}/`);
      }
      return normalizeBase(url.origin);
    } catch {
      /* ignore */
    }
    if (fallbackBase) return normalizeBase(fallbackBase);
    return '/';
  };

  const headRes = await doFetch(webId, { method: 'HEAD' }).catch(() => undefined);
  if (headRes?.ok) {
    const linkStorage = parseStorageFromLink(headRes.headers.get('link'));
    if (linkStorage) return normalizeBase(linkStorage);
  }

  const profileUrl = new URL(webId);
  profileUrl.searchParams.set('_type', 'text/turtle');
  const res = await doFetch(profileUrl.toString(), {
    headers: { accept: 'text/turtle,application/ld+json;q=0.9,text/n3;q=0.8,application/n-triples;q=0.7,text/html;q=0.5' },
  });
  await assertSuccess(res, 'fetch webid');
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    return computeFallback();
  }

  const body = await res.text();
  const quads = new Parser().parse(body);
  const storage = quads.find((q) => q.subject.value === webId && q.predicate.value === storageRel);
  if (!storage) {
    return computeFallback();
  }
  return normalizeBase(storage.object.value);
}
