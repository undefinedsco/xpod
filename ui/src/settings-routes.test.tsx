import { describe, expect, test } from 'vitest';
import { isValidElement } from 'react';
import { Navigate, matchRoutes } from 'react-router-dom';
import {
  aiConfigSurfaceRoutes,
  aiConnectionsSurfaceRoutes,
  settingsRoutes,
  systemSettingsSurfaceRoutes,
} from './settings-routes';

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
    expect(redirectTargetFor('/')).toBe('/models');
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

  test('does not own Dashboard observability routes', () => {
    expect(redirectTargetFor('/logs')).toBe('/models');
    expect(redirectTargetFor('/rdf')).toBe('/models');
    expect(redirectTargetFor('/usage')).toBe('/models');
  });
});
