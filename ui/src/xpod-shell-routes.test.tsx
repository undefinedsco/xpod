import { describe, expect, it } from 'vitest';
import { matchRoutes, Navigate } from 'react-router-dom';
import { xpodShellRoutes } from './xpod-shell-routes';
import { AccountAuthBoundary, AccountWorkspaceBoundary, LocalServiceSurfaceBoundary } from './auth/AccountAuthBoundary';
import { XPOD_DEFAULT_RETURN_PATH } from './routes/canonical-routes';
import { WebIdAuthBoundary } from './solid/WebIdAuthBoundary';

describe('xpodShellRoutes', () => {
  it.each([
    '/status/overview',
    '/network',
    '/ai-connections',
    '/ai-config/model-assignments',
    '/settings/pod',
  ])('renders a concrete route for %s', (pathname) => {
    const matches = matchRoutes(xpodShellRoutes, pathname);

    expect(matches).toBeTruthy();
    expect(matches?.at(-1)?.route.element).toBeTruthy();
  });

  it.each(['/', '/some/unknown/legacy/path'])(
    'sends %s to the WebID workspace instead of the Account gate',
    (pathname) => {
      const element = matchRoutes(xpodShellRoutes, pathname)?.at(-1)?.route.element as
        | { type?: unknown; props?: { to?: string } }
        | undefined;

      expect(XPOD_DEFAULT_RETURN_PATH).toBe('/ai-connections');
      expect(element?.type).toBe(Navigate);
      expect(element?.props?.to).toBe(XPOD_DEFAULT_RETURN_PATH);
    },
  );

  it.each([
    ['/dashboard/overview', AccountAuthBoundary],
    ['/ai-connections', WebIdAuthBoundary],
    ['/ai-config/model-assignments', WebIdAuthBoundary],
    ['/settings/pod', AccountAuthBoundary],
    ['/settings/identity-access', WebIdAuthBoundary],
  ])('guards %s with its service-owned boundary', (pathname, boundary) => {
    const matches = matchRoutes(xpodShellRoutes, pathname);
    expect(matches?.some(({ route }) => route.element?.type === boundary)).toBe(true);
  });

  it.each([
    '/status/overview',
    '/status/services/gateway',
    '/status/services/solid-server',
    '/status/services/api-server',
    '/status/logs',
    '/status/index',
    '/status/index/rdf',
    '/status/index/fts',
    '/status/index/vector',
    '/status/index/retrieval-points',
    '/status/index/cache',
    '/status/index/slow-queries',
    '/status/index/benchmark',
  ])('admits the local service surface %s without an Account or WebID gate', (pathname) => {
    const matches = matchRoutes(xpodShellRoutes, pathname);

    expect(matches?.some(({ route }) => route.element?.type === LocalServiceSurfaceBoundary)).toBe(true);
    expect(matches?.some(({ route }) => route.element?.type === AccountAuthBoundary)).toBe(false);
    expect(matches?.some(({ route }) => route.element?.type === AccountWorkspaceBoundary)).toBe(false);
    expect(matches?.some(({ route }) => route.element?.type === WebIdAuthBoundary)).toBe(false);
  });

  it('keeps the legacy /dashboard tree behind the Account workspace boundary', () => {
    const matches = matchRoutes(xpodShellRoutes, '/dashboard/overview');

    expect(matches?.some(({ route }) => route.element?.type === AccountWorkspaceBoundary)).toBe(true);
    expect(matches?.some(({ route }) => route.element?.type === LocalServiceSurfaceBoundary)).toBe(false);
  });

  it.each([
    '/network',
    '/settings/storage',
    '/settings/runtime',
    '/settings/advanced',
  ])('keeps local service route %s outside account and WebID boundaries', (pathname) => {
    const matches = matchRoutes(xpodShellRoutes, pathname);
    expect(matches?.some(({ route }) => (
      route.element?.type === AccountAuthBoundary
      || route.element?.type === AccountWorkspaceBoundary
      || route.element?.type === WebIdAuthBoundary
    ))).toBe(false);
  });
});
