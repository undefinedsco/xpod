import type { AuthSurfaceHost } from '@undefineds.co/shared-ui';
import { useEffect } from 'react';

/**
 * Only the desktop bridge declares a native auth window. A small browser
 * viewport remains a Web document; width and hostname are not host signals.
 */
export function getXpodAuthSurfaceHost(): AuthSurfaceHost {
  return globalThis.xpodDesktop ? 'window' : 'document';
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
