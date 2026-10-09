/** Product entry needs a WebID; local device and settings remain reachable without one. */
export const XPOD_DEFAULT_RETURN_PATH = '/ai-connections';
export const canonicalRoutes = {
  tasks: '/tasks',
  pod: '/pod/models',
  device: '/device/network',
  status: '/device/services',
  gateway: '/device/services',
  solidServer: '/device/services',
  apiServer: '/device/services',
  network: '/device/network',
  aiConnections: '/ai-connections',
  aiConfig: '/pod/models',
  settings: '/settings/appearance',
} as const;

/** Old entry points lead to the one editing surface for each choice. */
export const legacyProductRedirects: Readonly<Record<string, string>> = {
  '/dashboard': canonicalRoutes.status,
  '/dashboard/overview': canonicalRoutes.status,
  '/dashboard/status': canonicalRoutes.status,
  '/dashboard/runtime': '/device/runtime',
  '/dashboard/logs': '/device/logs',
  '/dashboard/network': canonicalRoutes.network,
  '/dashboard/usage': '/pod/data',
  '/dashboard/models': canonicalRoutes.aiConnections,
  '/dashboard/pod': canonicalRoutes.pod,
  '/dashboard/services': canonicalRoutes.status,
  '/dashboard/settings': '/device/runtime',
  '/status': canonicalRoutes.status,
  '/status/overview': canonicalRoutes.status,
  '/status/services/gateway': canonicalRoutes.status,
  '/status/services/solid-server': canonicalRoutes.status,
  '/status/services/api-server': canonicalRoutes.status,
  '/status/logs': '/device/logs',
  '/network': canonicalRoutes.network,
  '/network/overview': canonicalRoutes.network,
  '/settings/models': canonicalRoutes.aiConnections,
  '/settings/ai-connections': canonicalRoutes.aiConnections,
  '/settings/ai-config': canonicalRoutes.pod,
  '/settings/pod': canonicalRoutes.pod,
  '/settings/identity-access': '/pod/apps',
  '/settings/storage': '/pod/data',
  '/settings/network': canonicalRoutes.network,
  '/settings/services': canonicalRoutes.status,
  '/settings/system': '/device/runtime',
  '/settings/runtime': '/device/runtime',
  '/ai-config': canonicalRoutes.pod,
  '/ai-config/model-assignments': canonicalRoutes.pod,
  '/ai-config/document-processing': canonicalRoutes.pod,
  '/ai-config/search-indexing': '/pod/search',
  '/ai-config/index-lifecycle': '/pod/search',
} as const;
export type ProductSurface = {
  app: 'dashboard' | 'settings';
  basename: '/dashboard' | '/status' | '/network' | '/settings' | '/ai-connections' | '/ai-config' | '/tasks' | '/pod' | '/device' | '/inbox' | '/notifications';
};
export const productSurfaceRoots: readonly ProductSurface[] = [
  ...(['/dashboard', '/status', '/network'] as const).map(basename => ({ app: 'dashboard' as const, basename })),
  ...(['/settings', '/ai-connections', '/ai-config', '/tasks', '/pod', '/device', '/inbox', '/notifications'] as const).map(basename => ({ app: 'settings' as const, basename })),
];
export function canonicalProductPathname(pathname: string): string {
  return legacyProductRedirects[pathname.replace(/\/$/, '')] ?? pathname;
}
export function surfaceForPathname(pathname: string): ProductSurface {
  return productSurfaceRoots.find(({ basename }) => pathname === basename || pathname.startsWith(`${basename}/`))
    ?? { app: 'settings', basename: '/settings' };
}
