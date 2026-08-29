import type { AuthSurfaceHost } from '@undefineds.co/shared-ui';

/**
 * Electron owns the outer login window, so Xpod must not draw a second modal
 * backdrop and card frame inside it. Browser-hosted Xpod keeps the regular
 * document modal presentation.
 */
export function getXpodAuthSurfaceHost(): AuthSurfaceHost {
  return isXpodDesktopHost(globalThis.xpodDesktop) ? 'window' : 'document';
}

export function isXpodDesktopHost(
  bridge: typeof globalThis.xpodDesktop,
): bridge is NonNullable<typeof globalThis.xpodDesktop> {
  return bridge?.platform === 'darwin'
    || bridge?.platform === 'linux'
    || bridge?.platform === 'win32';
}
