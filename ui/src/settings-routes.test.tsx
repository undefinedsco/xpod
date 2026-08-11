import { describe, expect, test } from 'vitest';
import { isValidElement } from 'react';
import { Navigate, matchRoutes } from 'react-router-dom';
import {
  aiConfigSurfaceRoutes,
  aiConnectionsSurfaceRoutes,
  settingsRoutes,
  systemSettingsSurfaceRoutes,
} from './settings-routes';
import { WebIdAuthBoundary } from './solid/SettingsAuthBoundary';

function containsElementType(element: unknown, type: unknown): boolean {
  if (!isValidElement(element)) return false;
  if (element.type === type) return true;
  const children = element.props?.children;
  return Array.isArray(children)
    ? children.some((child) => containsElementType(child, type))
    : containsElementType(children, type);
}

function routeElementFor(path: string) {
  return matchRoutes(settingsRoutes, path)?.at(-1)?.route.element;
}

function routePathFor(path: string) {
  return matchRoutes(settingsRoutes, path)?.at(-1)?.route.path;
}

function routePathsFor(path: string) {
  return matchRoutes(settingsRoutes, path)?.map((match) => match.route.path).filter(Boolean) ?? [];
}

function redirectTargetFor(path: string) {
  const element = routeElementFor(path);
  if (!isValidElement(element) || element.type !== Navigate) return null;
  return element.props.to;
}

describe('settings routes', () => {
  test('exposes canonical AI Connections, AI Config, and Settings surface trees', () => {
    expect(matchRoutes(aiConnectionsSurfaceRoutes, '/')).toBeTruthy();
    expect(matchRoutes(aiConfigSurfaceRoutes, '/model-assignments')).toBeTruthy();
    expect(matchRoutes(aiConfigSurfaceRoutes, '/index-lifecycle')).toBeTruthy();
    expect(matchRoutes(systemSettingsSurfaceRoutes, '/pod')).toBeTruthy();
    expect(matchRoutes(systemSettingsSurfaceRoutes, '/advanced')).toBeTruthy();
  });
  test('uses Models as the Settings default', () => {
    expect(redirectTargetFor('/')).toBe('models');
  });

  test('owns AI Connections, AI Config, and low-frequency system settings', () => {
    expect(routePathFor('/models')).toBe('models');
    expect(redirectTargetFor('/ai-config')).toBe('model-assignments');
    expect(routePathFor('/ai-config/model-assignments')).toBe('model-assignments');
    expect(routePathFor('/ai-config/document-processing')).toBe('document-processing');
    expect(routePathFor('/ai-config/search-indexing')).toBe('search-indexing');
    expect(routePathFor('/ai-config/index-lifecycle')).toBe('index-lifecycle');
    expect(routePathFor('/pod')).toBe('pod');
    expect(routePathFor('/network')).toBe('network');
    expect(routePathsFor('/services')).toContain('services');
    expect(redirectTargetFor('/system')).toBe('pod');
    for (const section of ['pod', 'identity-access', 'storage', 'runtime', 'cloud', 'advanced']) {
      expect(routePathFor(`/system/${section}`)).toBe(section);
    }
  });

  test('leaves anonymous-local settings routes available without an auth boundary', () => {
    for (const path of ['/network', '/services']) {
      const element = routeElementFor(path);
      expect(isValidElement(element)).toBe(true);
      expect(containsElementType(element, WebIdAuthBoundary)).toBe(false);
    }
  });

  test('keeps Pod and Models settings on the canonical current-origin WebID boundary', () => {
    for (const path of ['/models', '/pod']) {
      const element = routeElementFor(path);
      expect(isValidElement(element)).toBe(true);
      expect(containsElementType(element, WebIdAuthBoundary)).toBe(true);
    }
  });

  test('does not own Dashboard observability routes', () => {
    expect(redirectTargetFor('/logs')).toBe('../models');
    expect(redirectTargetFor('/rdf')).toBe('../models');
    expect(redirectTargetFor('/usage')).toBe('../models');
  });

  test('keeps index and wildcard redirects relative inside the settings basename', () => {
    for (const [path, target] of [['/', 'models'], ['/unknown', '../models']]) {
      expect(redirectTargetFor(path)).toBe(target);
      expect(redirectTargetFor(path)).not.toMatch(/^\//u);
    }
  });
});
