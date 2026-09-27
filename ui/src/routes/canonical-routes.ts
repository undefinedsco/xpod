/**
 * Where the product lands when no safe `returnTo` is available: the workspace
 * that only needs a WebID/Pod session. Account-protected workspaces
 * (`/status`, `/dashboard`) are something the user navigates to, not the entry.
 */
export const XPOD_DEFAULT_RETURN_PATH = '/ai-connections';

/** The pre-rail default that older entry documents and bookmarks still carry. */
const LEGACY_DEFAULT_RETURN_PATH = '/dashboard/overview';

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

/**
 * §3.3 的历史入口映射。兼容期从采用本 spec 的稳定版起保留至少两个稳定版且不少于 90 天。
 *
 * 两点与 §3.3 的差异是当前实现的现实，不是口径变化：
 * - `/network/overview`、`/network/domain-dns` 是本轮目标路径，尚未建立，先落 `/network`；
 * - `/status/usage/*` 已由 W4 建立（`ui/src/pages/admin/UsagePage.tsx`），`/dashboard/usage` 按 §3.3 落
 *   `/status/usage/overview`。
 * 记录见 docs/superpowers/audits/2026-09-27-w2-shell-layout-self-review.md（W2-DESIGN-04）。
 */
export const legacyProductRedirects: Readonly<Record<string, string>> = {
  '/dashboard': canonicalRoutes.status,
  [LEGACY_DEFAULT_RETURN_PATH]: canonicalRoutes.status,
  '/dashboard/status': canonicalRoutes.status,
  '/dashboard/runtime': canonicalRoutes.status,
  '/dashboard/logs': '/status/logs',
  '/dashboard/rdf': '/status/index/rdf',
  '/dashboard/network': canonicalRoutes.network,
  '/dashboard/usage': '/status/usage/overview',
  '/dashboard/models': canonicalRoutes.aiConnections,
  '/dashboard/pod': canonicalRoutes.settings,
  // §3.3：服务与启动归「服务与访问」，不再落 Pod 页面
  '/dashboard/services': '/settings/runtime',
  '/dashboard/settings': '/settings/runtime',
  '/settings/models': canonicalRoutes.aiConnections,
  '/settings/ai-connections': canonicalRoutes.aiConnections,
  '/settings/ai-config': canonicalRoutes.aiConfig,
  '/settings/pod': canonicalRoutes.settings,
  '/settings/network': canonicalRoutes.network,
  '/settings/services': '/settings/runtime',
  '/settings/system': '/settings/runtime',
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
