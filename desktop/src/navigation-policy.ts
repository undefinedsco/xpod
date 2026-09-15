export function isTrustedOidcNavigation(value: string, issuer: string | undefined): boolean {
  if (!issuer) return false
  try {
    const target = new URL(value)
    const configuredIssuer = new URL(issuer)
    return (target.protocol === 'http:' || target.protocol === 'https:')
      && !target.username && !target.password
      && !configuredIssuer.username && !configuredIssuer.password
      && target.origin === configuredIssuer.origin
  } catch {
    return false
  }
}


/** Read identity authority from the same Gateway as the renderer, never the shell environment. */
export async function resolveDesktopOidcIssuer(
  targetOrigin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const read = async (pathname: string) => fetchImpl(new URL(pathname, targetOrigin), {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    })
    const response = await read('/provision/status')
    if (response.status !== 404 && !response.ok) return undefined
    const status = response.ok ? await response.json() : undefined
    if (status?.managed === true) return safeIssuer(status.oidcIssuer)
    if (response.status !== 404 && status?.managed !== false) return undefined
    const discovery = await read('/.well-known/openid-configuration')
    return discovery.ok ? safeIssuer((await discovery.json()).issuer) : undefined
  } catch {
    return undefined
  }
}

function safeIssuer(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol)
      && !url.username && !url.password && !url.search && !url.hash
      ? url.href : undefined
  } catch {
    return undefined
  }
}


/**
 * Product pages served by the shell's own Gateway origin.
 *
 * Electron denies popups unless the open handler allows them, so an in-app
 * `window.open` used to be swallowed with no window and no error. These are the
 * URLs that must stay in the desktop session; anything else is either routed to
 * the system browser or handled as an OIDC navigation.
 */
export function isSameOriginProductUrl(value: string, origin: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && !url.username && !url.password
      && url.origin === new URL(origin).origin
  } catch {
    return false
  }
}


/** Classification only: the issuer still must be verified against the Gateway. */
export function isOidcAuthorizationRequest(value: string, callbackOrigin: string): boolean {
  try {
    const url = new URL(value)
    const redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
    return ['http:', 'https:'].includes(url.protocol)
      && !url.username && !url.password
      && url.searchParams.get('response_type') === 'code'
      && Boolean(url.searchParams.get('client_id'))
      && redirect.origin === new URL(callbackOrigin).origin
      && redirect.pathname === '/auth/callback'
  } catch {
    return false
  }
}
