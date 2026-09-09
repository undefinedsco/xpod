export function isTrustedOidcNavigation(value: string, issuer: string | undefined): boolean {
  if (!issuer) return false
  try {
    const target = new URL(value)
    const configuredIssuer = new URL(issuer)
    return (target.protocol === 'http:' || target.protocol === 'https:')
      && target.origin === configuredIssuer.origin
  } catch {
    return false
  }
}
