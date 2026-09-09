/** Default post-auth destination when no safe `returnTo` is available. */
export const XPOD_DEFAULT_RETURN_PATH = '/dashboard/overview';

export const canonicalRoutes = {
  status: '/status/overview',
  gateway: '/status/services/gateway',
  solidServer: '/status/services/solid-server',
  apiServer: '/status/services/api-server',
  network: '/network',
  aiConnections: '/ai-connections',
  aiConfig: '/ai-config/model-assignments',
  settings: '/settings/pod',
} as const;

export const legacyProductRedirects: Readonly<Record<string, string>> = {
  '/dashboard': canonicalRoutes.status,
  [XPOD_DEFAULT_RETURN_PATH]: canonicalRoutes.status,
  '/dashboard/network': canonicalRoutes.network,
  '/dashboard/models': canonicalRoutes.aiConnections,
  '/dashboard/pod': canonicalRoutes.settings,
  '/dashboard/services': canonicalRoutes.status,
  '/dashboard/settings': canonicalRoutes.settings,
  '/settings/models': canonicalRoutes.aiConnections,
  '/settings/ai-connections': canonicalRoutes.aiConnections,
  '/settings/ai-config': canonicalRoutes.aiConfig,
  '/settings/pod': canonicalRoutes.settings,
  '/settings/network': canonicalRoutes.network,
  '/settings/services': canonicalRoutes.status,
  '/settings/system': canonicalRoutes.settings,
} as const;

export type ProductSurface = {
  app: 'dashboard' | 'settings';
  basename: '/dashboard' | '/status' | '/network' | '/settings' | '/ai-connections' | '/ai-config';
};

/**
 * Authoritative product-shell roots shared by the normal entry documents and
 * the OIDC callback document. Keep route ownership in one place so adding a
 * rail surface cannot silently strand an authenticated callback elsewhere.
 */
export const productSurfaceRoots: readonly ProductSurface[] = [
  { app: 'dashboard', basename: '/dashboard' },
  { app: 'dashboard', basename: '/status' },
  { app: 'dashboard', basename: '/network' },
  { app: 'settings', basename: '/settings' },
  { app: 'settings', basename: '/ai-connections' },
  { app: 'settings', basename: '/ai-config' },
];

export function canonicalProductPathname(pathname: string): string {
  return legacyProductRedirects[pathname] ?? pathname;
}

export function surfaceForPathname(pathname: string): ProductSurface {
  return productSurfaceRoots.find(({ basename }) => (
    pathname === basename || pathname.startsWith(`${basename}/`)
  )) ?? { app: 'settings', basename: '/settings' };
}
