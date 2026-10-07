/**
 * Compact, human-readable renderings of a consent option's long URLs.
 *
 * Kept out of `WebAccountViews.tsx` so that file only exports components: fast
 * refresh cannot preserve state when a module also exports plain functions.
 */

/**
 * A WebID is `<origin>/<pod>/profile/card#me`; the consent decision only needs
 * the origin and the Pod, and the full value stays available as a tooltip.
 */
export function compactConsentOrigin(webId: string): string {
  try {
    const url = new URL(webId)
    const pod = url.pathname.split('/').filter(Boolean)[0]
    return pod ? `${url.host}/${pod}` : url.host
  } catch {
    return webId
  }
}

/** The storage line repeats the same Pod; show its path instead of the whole URL. */
export function compactConsentStorage(storageUrl: string): string {
  try {
    const url = new URL(storageUrl)
    return url.pathname === '/' ? url.host : url.pathname
  } catch {
    return storageUrl
  }
}
