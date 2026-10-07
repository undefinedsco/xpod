/** Follow the discovered Account authority, including managed Local's Cloud issuer. */
export function accountOverviewHref(index: string | undefined): string | undefined {
  if (!index) return undefined;
  try {
    const issuer = new URL(index, window.location.origin);
    if (!['https:', 'http:'].includes(issuer.protocol) || issuer.username || issuer.password
      || issuer.pathname !== '/.account/') return undefined;
    issuer.search = '';
    issuer.hash = '';
    return new URL('account/', issuer).href;
  } catch { return undefined; }
}
