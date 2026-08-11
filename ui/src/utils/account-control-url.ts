/**
 * Accept an Account control only when it remains inside the current Xpod
 * http(s) origin and does not carry URL userinfo.
 */
export function resolveSameOriginAccountControlUrl(value: string | undefined): string | undefined {
  if (typeof window === 'undefined' || typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  const candidate = value.trim();
  try {
    const url = new URL(candidate, window.location.origin);
    if (
      url.origin !== window.location.origin
      || !['http:', 'https:'].includes(url.protocol)
      || url.username
      || url.password
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}
