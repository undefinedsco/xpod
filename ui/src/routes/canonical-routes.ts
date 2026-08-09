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
  '/dashboard/overview': canonicalRoutes.status,
  '/dashboard/network': canonicalRoutes.network,
  '/dashboard/models': canonicalRoutes.aiConnections,
  '/dashboard/pod': canonicalRoutes.settings,
  '/dashboard/services': canonicalRoutes.status,
  '/dashboard/settings': canonicalRoutes.settings,
  '/settings/models': canonicalRoutes.aiConnections,
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

export function canonicalProductPathname(pathname: string): string {
  return legacyProductRedirects[pathname] ?? pathname;
}

export function surfaceForPathname(pathname: string): ProductSurface {
  if (pathname === '/status' || pathname.startsWith('/status/')) return { app: 'dashboard', basename: '/status' };
  if (pathname === '/network' || pathname.startsWith('/network/')) return { app: 'dashboard', basename: '/network' };
  if (pathname === '/ai-connections' || pathname.startsWith('/ai-connections/')) return { app: 'settings', basename: '/ai-connections' };
  if (pathname === '/ai-config' || pathname.startsWith('/ai-config/')) return { app: 'settings', basename: '/ai-config' };
  if (pathname === '/settings' || pathname.startsWith('/settings/')) return { app: 'settings', basename: '/settings' };
  return pathname === '/dashboard' || pathname.startsWith('/dashboard/')
    ? { app: 'dashboard', basename: '/dashboard' }
    : { app: 'settings', basename: '/settings' };
}
