import { describe, expect, test } from 'vitest';
import { isValidElement } from 'react';
import { Navigate, matchRoutes } from 'react-router-dom';
import { settingsRoutes } from './settings-routes';
import { SettingsAuthBoundary } from './solid/SettingsAuthBoundary';

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

function redirectTargetFor(path: string) {
  const element = routeElementFor(path);
  if (!isValidElement(element) || element.type !== Navigate) return null;
  return element.props.to;
}

describe('settings routes', () => {
  test('uses Models as the Settings default', () => {
    expect(redirectTargetFor('/')).toBe('/models');
  });

  test('owns the four writable configuration sections', () => {
    expect(routeElementFor('/models')).toBeTruthy();
    expect(routeElementFor('/pod')).toBeTruthy();
    expect(routeElementFor('/network')).toBeTruthy();
    expect(routeElementFor('/services')).toBeTruthy();
  });

  test('leaves local settings routes available without an Account or Solid chooser boundary', () => {
    for (const path of ['/models', '/network', '/services']) {
      const element = routeElementFor(path);
      expect(isValidElement(element)).toBe(true);
      expect(containsElementType(element, SettingsAuthBoundary)).toBe(false);
    }
  });

  test('keeps Pod settings on the host readiness boundary rather than the legacy chooser', () => {
    const element = routeElementFor('/pod');
    expect(isValidElement(element)).toBe(true);
    expect(containsElementType(element, SettingsAuthBoundary)).toBe(false);
  });

  test('does not own Dashboard observability routes', () => {
    expect(redirectTargetFor('/logs')).toBe('/models');
    expect(redirectTargetFor('/rdf')).toBe('/models');
    expect(redirectTargetFor('/usage')).toBe('/models');
  });
});
