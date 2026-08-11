/** Resolve an Xpod-owned URL without allowing another origin to become a provider. */
export function resolveCurrentXpodUrl(value: string, origin: string): string | undefined {
  const candidate = value.trim();
  if (!candidate || (candidate.startsWith('//')) || (!candidate.startsWith('/') && !/^https?:\/\//iu.test(candidate))) {
    return undefined;
  }

  try {
    const currentOrigin = new URL(origin).origin;
    const url = new URL(candidate, `${currentOrigin}/`);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username
      || url.password
      || url.origin !== currentOrigin
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

export function requireCurrentXpodUrl(value: string, origin: string): string {
  const resolved = resolveCurrentXpodUrl(value, origin);
  if (!resolved) throw new TypeError('URL must belong to the current Xpod origin');
  return resolved;
}
