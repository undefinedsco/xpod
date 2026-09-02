import { describe, expect, test } from 'vitest';
import { isValidElement } from 'react';
import { matchRoutes } from 'react-router-dom';
import {
  aiConfigSurfaceRoutes,
  aiConnectionsSurfaceRoutes,
  systemSettingsSurfaceRoutes,
} from './settings-routes';
import { xpodShellRoutes } from './xpod-shell-routes';
import { AccountAuthBoundary } from './auth/AccountAuthBoundary';
import { XpodSettingsLayout } from './layout/XpodSettingsLayout';
import { WebIdAuthBoundary } from './solid/WebIdAuthBoundary';

function containsElementType(element: unknown, type: unknown): boolean {
  if (!isValidElement(element)) return false;
  if (element.type === type) return true;
  const children = element.props?.children;
  return Array.isArray(children)
    ? children.some((child) => containsElementType(child, type))
    : containsElementType(children, type);
}

function shellRouteFor(path: string) {
  return xpodShellRoutes.find((route) => route.path === path);
}

function routeElementsFor(pathname: string) {
  return matchRoutes(systemSettingsSurfaceRoutes, pathname)
    ?.map(({ route }) => route.element) ?? [];
}

function firstElementIndex(pathname: string, type: unknown) {
  return routeElementsFor(pathname)
    .findIndex((element) => containsElementType(element, type));
}

describe('settings surface routes', () => {
  test('exposes canonical AI Connections, AI Config, and Settings surface trees', () => {
    expect(matchRoutes(aiConnectionsSurfaceRoutes, '/')).toBeTruthy();
    expect(matchRoutes(aiConfigSurfaceRoutes, '/model-assignments')).toBeTruthy();
    expect(matchRoutes(aiConfigSurfaceRoutes, '/index-lifecycle')).toBeTruthy();
    expect(matchRoutes(systemSettingsSurfaceRoutes, '/pod')).toBeTruthy();
    expect(matchRoutes(systemSettingsSurfaceRoutes, '/advanced')).toBeTruthy();
  });

  test('gates Pod and Identity & Access behind the WebID boundary only', () => {
    for (const section of ['/pod', '/identity-access']) {
      expect(firstElementIndex(section, WebIdAuthBoundary), section).toBeGreaterThanOrEqual(0);
      expect(firstElementIndex(section, AccountAuthBoundary), section).toBe(-1);
    }
  });

  test('mounts the WebID boundary before the settings workspace layout for Pod-backed sections', () => {
    for (const section of ['/pod', '/identity-access']) {
      const authBoundaryIndex = firstElementIndex(section, WebIdAuthBoundary);
      const layoutIndex = firstElementIndex(section, XpodSettingsLayout);
      expect(authBoundaryIndex, section).toBeGreaterThanOrEqual(0);
      expect(layoutIndex, section).toBeGreaterThanOrEqual(0);
      expect(authBoundaryIndex, section).toBeLessThan(layoutIndex);
    }

    expect(firstElementIndex('/', XpodSettingsLayout)).toBe(-1);
    expect(firstElementIndex('/', WebIdAuthBoundary)).toBe(-1);
  });

  test('keeps local-only settings sections outside any auth boundary', () => {
    for (const section of ['/storage', '/runtime', '/cloud', '/advanced']) {
      expect(matchRoutes(systemSettingsSurfaceRoutes, section), section).toBeTruthy();
      expect(firstElementIndex(section, WebIdAuthBoundary), section).toBe(-1);
      expect(firstElementIndex(section, AccountAuthBoundary), section).toBe(-1);
      expect(firstElementIndex(section, XpodSettingsLayout), section).toBeGreaterThanOrEqual(0);
    }
  });

  test('wires shell boundaries per route instead of one shell-wide gate', () => {
    expect(containsElementType(shellRouteFor('status')?.element, AccountAuthBoundary)).toBe(true);
    expect(containsElementType(shellRouteFor('dashboard')?.element, AccountAuthBoundary)).toBe(true);
    expect(containsElementType(shellRouteFor('ai-connections')?.element, WebIdAuthBoundary)).toBe(true);
    expect(containsElementType(shellRouteFor('ai-config')?.element, WebIdAuthBoundary)).toBe(true);
    // Network stays reachable without either identity session.
    expect(shellRouteFor('network')?.element).toBeUndefined();
  });
});
