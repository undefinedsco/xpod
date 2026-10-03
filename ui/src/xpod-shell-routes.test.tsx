import { describe, expect, it } from 'vitest';
import { matchRoutes, Navigate } from 'react-router-dom';
import { xpodShellRoutes } from './xpod-shell-routes';
import { WorkspacePage } from './DesktopWorkspaces';
import { WebIdAuthBoundary } from './solid/WebIdAuthBoundary';
import { XpodProductLayout } from './layout/XpodProductLayout';
import { canonicalRoutes, legacyProductRedirects } from './routes/canonical-routes';

describe('desktop shell routes', () => {
  it.each(['/device/network', '/device/services', '/device/runtime', '/device/logs', '/settings/appearance'])('opens %s with local host authority', pathname => {
    const matches = matchRoutes(xpodShellRoutes, pathname);
    expect(matches?.at(-1)?.route.element).toBeTruthy();
    expect(matches?.some(({ route }) => route.element?.type === XpodProductLayout)).toBe(true);
    expect(matches?.some(({ route }) => route.element?.type === WebIdAuthBoundary)).toBe(false);
  });
  it.each(['/tasks', '/ai-connections', '/pod/models', '/pod/search', '/pod/apps', '/pod/data', '/inbox', '/notifications'])('keeps the host outside the WebID gate for %s', pathname => {
    const matches = matchRoutes(xpodShellRoutes, pathname)!;
    expect(matches[0].route.element?.type).toBe(XpodProductLayout);
    expect(matches.some(({ route }) => route.element?.type === WebIdAuthBoundary)).toBe(true);
  });
  it.each([canonicalRoutes.device, canonicalRoutes.network, canonicalRoutes.status, canonicalRoutes.settings])('keeps canonical local route %s reachable without a WebID', pathname => {
    const matches = matchRoutes(xpodShellRoutes, pathname)!;
    expect(matches.some(({ route }) => route.element?.type === XpodProductLayout)).toBe(true);
    expect(matches.some(({ route }) => route.element?.type === WebIdAuthBoundary)).toBe(false);
  });
  it.each([canonicalRoutes.tasks, canonicalRoutes.pod, canonicalRoutes.aiConnections])('gates canonical WebID applet route %s', pathname => {
    expect(matchRoutes(xpodShellRoutes, pathname)?.some(({ route }) => route.element?.type === WebIdAuthBoundary)).toBe(true);
  });
  it.each(['/inbox', '/notifications'])('gives %s a single workspace page header', pathname => {
    expect(matchRoutes(xpodShellRoutes, pathname)?.at(-1)?.route.element?.type).toBe(WorkspacePage);
  });
  it.each(Object.entries(legacyProductRedirects))('redirects %s before rendering a duplicate editor', (pathname, to) => {
    const element = matchRoutes(xpodShellRoutes, pathname)?.at(-1)?.route.element;
    expect(element?.type).toBe(Navigate);
    expect(element?.props.to).toBe(to);
  });
});
