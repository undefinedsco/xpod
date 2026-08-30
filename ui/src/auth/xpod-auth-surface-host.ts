import type { AuthSurfaceHost } from '@undefineds.co/shared-ui';

/**
 * Xpod keeps one persistent desktop workspace. Authentication is therefore a
 * compact card inside that document, never a second full-window auth host.
 */
export function getXpodAuthSurfaceHost(): AuthSurfaceHost {
  return 'document';
}

export function isXpodDesktopHost(
  bridge: typeof globalThis.xpodDesktop,
): bridge is NonNullable<typeof globalThis.xpodDesktop> {
  return bridge?.platform === 'darwin'
    || bridge?.platform === 'linux'
    || bridge?.platform === 'win32';
}
