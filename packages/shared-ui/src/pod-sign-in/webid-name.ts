/**
 * Short display name for a WebID that has no remembered profile: the last
 * meaningful path segment (`/alice/profile/card#me` -> `alice`), else the host.
 */
export function webIdShortName(webId: string): string {
  try {
    const url = new URL(webId)
    const segments = url.pathname.split('/').filter((segment) => segment && !['profile', 'card'].includes(segment))
    return segments[segments.length - 1] ?? url.hostname
  } catch {
    return webId
  }
}
