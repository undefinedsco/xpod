import { describe, expect, test } from 'vitest';
import { isValidElement } from 'react';
import { matchRoutes, Navigate } from 'react-router-dom';
import { xpodShellRoutes } from './xpod-shell-routes';
import { AccountAuthBoundary, AccountWorkspaceBoundary } from './auth/AccountAuthBoundary';
import { XpodProductLayout } from './layout/XpodProductLayout';
import { WebIdAuthBoundary } from './solid/WebIdAuthBoundary';

function containsElementType(element: unknown, type: unknown): boolean {
  if (!isValidElement(element)) return false;
  if (element.type === type) return true;
  const children = element.props?.children;
  return Array.isArray(children)
    ? children.some((child) => containsElementType(child, type))
    : containsElementType(children, type);
}
function routeElements(path: string) {
  const matches = matchRoutes(xpodShellRoutes, path);
  expect(matches, path).toBeTruthy();
  return matches!.map(({ route }) => route.element);
}

describe('desktop settings and applet route boundaries', () => {
  test.each(['/device/network', '/device/services', '/device/runtime', '/device/logs', '/settings/appearance'])(
    '%s remains inside the shell without Account or WebID authorization', (path) => {
      const elements = routeElements(path);
      expect(elements.some(element => containsElementType(element, XpodProductLayout))).toBe(true);
      for (const boundary of [AccountAuthBoundary, AccountWorkspaceBoundary, WebIdAuthBoundary]) {
        expect(elements.some(element => containsElementType(element, boundary))).toBe(false);
      }
      const page = elements.at(-1);
      expect(isValidElement(page) && page.type === Navigate).toBe(false);
    },
  );
  test.each(['/ai-connections', '/tasks', '/pod/models', '/pod/search', '/pod/apps', '/pod/data', '/inbox', '/notifications'])(
    '%s requires WebID inside the existing shell', (path) => {
      const elements = routeElements(path);
      const layout = elements.findIndex(element => containsElementType(element, XpodProductLayout));
      const gate = elements.findIndex(element => containsElementType(element, WebIdAuthBoundary));
      expect(layout).toBeGreaterThanOrEqual(0);
      expect(gate).toBeGreaterThan(layout);
      expect(elements.filter(element => containsElementType(element, WebIdAuthBoundary))).toHaveLength(1);
      expect(elements.some(element => containsElementType(element, AccountAuthBoundary) || containsElementType(element, AccountWorkspaceBoundary))).toBe(false);
    },
  );
  test.each([
    ['/settings/pod', '/pod/models'], ['/settings/storage', '/pod/data'],
    ['/settings/identity-access', '/pod/apps'], ['/settings/runtime', '/device/runtime'],
    ['/ai-config/search-indexing', '/pod/search'], ['/status/overview', '/device/services'],
  ])('redirects legacy %s to its one canonical owner', (path, target) => {
    const redirect = routeElements(path).at(-1);
    expect(isValidElement(redirect) && redirect.type).toBe(Navigate);
    expect(isValidElement(redirect) && redirect.props.to).toBe(target);
  });
});
