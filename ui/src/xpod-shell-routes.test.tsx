import { describe, expect, it } from 'vitest';
import { matchRoutes } from 'react-router-dom';
import { xpodShellRoutes } from './xpod-shell-routes';
import { AccountAuthBoundary } from './auth/AccountAuthBoundary';
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

  it.each([
    ['/status/overview', AccountAuthBoundary],
    ['/dashboard/overview', AccountAuthBoundary],
    ['/ai-connections', WebIdAuthBoundary],
    ['/ai-config/model-assignments', WebIdAuthBoundary],
    ['/settings/pod', WebIdAuthBoundary],
    ['/settings/identity-access', WebIdAuthBoundary],
  ])('guards %s with its service-owned boundary', (pathname, boundary) => {
    const matches = matchRoutes(xpodShellRoutes, pathname);
    expect(matches?.some(({ route }) => route.element?.type === boundary)).toBe(true);
  });

  it.each([
    '/network',
    '/settings/storage',
    '/settings/runtime',
    '/settings/advanced',
  ])('keeps local service route %s outside account and WebID boundaries', (pathname) => {
    const matches = matchRoutes(xpodShellRoutes, pathname);
    expect(matches?.some(({ route }) => (
      route.element?.type === AccountAuthBoundary || route.element?.type === WebIdAuthBoundary
    ))).toBe(false);
  });
});
