import type { AuthSurfaceHost } from '@undefineds.co/shared-ui';
import { useEffect } from 'react';

/**
 * Xpod authentication owns the current viewport. In a browser that is the
 * page; in Electron it is the compact native BrowserWindow. Callers must not
 * introduce another overlay or card merely because the host changed.
 */
export function getXpodAuthSurfaceHost(): AuthSurfaceHost {
  return 'window';
}

/**
 * Keeps native window geometry aligned with the same auth/content boundary
 * that controls the renderer. Browsers safely ignore the absent bridge.
 */
export function useXpodAuthWindowSurface(enabled = true): void {
  useEffect(() => {
    if (!enabled) return undefined;
    globalThis.xpodDesktop?.setWindowMode?.('auth');
    return () => {
      globalThis.xpodDesktop?.setWindowMode?.('workspace');
    };
  }, [enabled]);
}
