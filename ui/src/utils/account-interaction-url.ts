/** Routing scope only; the interaction cookie remains the server credential. */
export function accountInteractionBase(pathname = typeof window === 'undefined' ? '/.account/' : window.location.pathname): string {
  return /^\/\.account\/interaction\/[^/]+(?=\/|$)/u.exec(pathname)?.[0] ?? '/.account';
}

/** Carry the current interaction on same-origin Account navigation and requests. */
export function scopeAccountUrl(value: string | URL, location: Pick<Location, 'href' | 'origin' | 'pathname'> | undefined = typeof window === 'undefined' ? undefined : window.location): string {
  const original = String(value);
  if (!location) return original;
  const base = accountInteractionBase(location.pathname);
  if (base === '/.account') return original;
  const url = new URL(original, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith('/.account/')
    || url.pathname.startsWith('/.account/interaction/')) return original;
  url.pathname = `${base}${url.pathname.slice('/.account'.length)}`;
  return original.startsWith('/') && !original.startsWith('//')
    ? `${url.pathname}${url.search}${url.hash}`
    : url.href;
}
