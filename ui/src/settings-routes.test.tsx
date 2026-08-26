import { describe, expect, test } from 'vitest';
import { isValidElement } from 'react';
import { Navigate, matchRoutes } from 'react-router-dom';
import { settingsRoutes } from './settings-routes';
import { XpodSettingsLayout } from './layout/XpodSettingsLayout';
import { SettingsAuthBoundary } from './solid/SettingsAuthBoundary';

function routeElementFor(path: string) {
  return matchRoutes(settingsRoutes, path)?.at(-1)?.route.element;
}

function redirectTargetFor(path: string) {
  const element = routeElementFor(path);
  if (!isValidElement(element) || element.type !== Navigate) return null;
  return element.props.to;
}

describe('settings routes', () => {
  test('guards the complete Settings shell so anonymous users never see the rail', () => {
    const root = settingsRoutes[0]?.element;
    expect(isValidElement(root) && root.type).toBe(SettingsAuthBoundary);
    expect(isValidElement(root) && isValidElement(root.props.children) && root.props.children.type)
      .toBe(XpodSettingsLayout);
  });

  test('uses Models as the Settings default', () => {
    expect(redirectTargetFor('/')).toBe('/models');
  });

  test('owns the four writable configuration sections', () => {
    expect(routeElementFor('/models')).toBeTruthy();
    expect(routeElementFor('/pod')).toBeTruthy();
    expect(routeElementFor('/network')).toBeTruthy();
    expect(routeElementFor('/services')).toBeTruthy();
  });

  test('does not own Dashboard observability routes', () => {
    expect(redirectTargetFor('/logs')).toBe('/models');
    expect(redirectTargetFor('/rdf')).toBe('/models');
    expect(redirectTargetFor('/usage')).toBe('/models');
  });
});
