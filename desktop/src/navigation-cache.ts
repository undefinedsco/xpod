export interface DesktopNavigationSession {
  clearCache(): Promise<void>
  clearCodeCaches(options: { urls?: string[] }): Promise<void>
}

export interface DesktopNavigationWindow {
  webContents: {
    session: DesktopNavigationSession
  }
  loadURL(url: string): Promise<void>
}

export type DesktopNavigationCacheWarning = (message: string) => void

export async function clearDesktopNavigationCache(
  session: DesktopNavigationSession,
  url: string,
  reportWarning: DesktopNavigationCacheWarning = (message) => console.warn(message),
): Promise<void> {
  const operations = [
    ['HTTP cache', Promise.resolve().then(() => session.clearCache())],
    ['code cache', Promise.resolve().then(() => session.clearCodeCaches({ urls: [url] }))],
  ] as const
  const results = await Promise.allSettled(operations.map(([, operation]) => operation))
  const failures: string[] = []

  results.forEach((result, index) => {
    if (result.status !== 'rejected') {
      return
    }

    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
    failures.push(`${operations[index][0]}: ${reason}`)
  })

  if (failures.length > 0) {
    reportWarning(`[xpod-desktop] Cache invalidation incomplete before loading ${url}: ${failures.join('; ')}`)
  }
}

export async function loadDesktopUrlWithoutStaleCache(
  window: DesktopNavigationWindow,
  url: string,
  reportWarning?: DesktopNavigationCacheWarning,
): Promise<void> {
  await clearDesktopNavigationCache(window.webContents.session, url, reportWarning)
  await window.loadURL(url)
}
