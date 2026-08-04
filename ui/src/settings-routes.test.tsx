import { describe, expect, test } from 'vitest';
import { isValidElement } from 'react';
import { Navigate, matchRoutes } from 'react-router-dom';
import { settingsRoutes } from './settings-routes';

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

  test('keeps the Solid OIDC callback route stable while session restoration completes', () => {
    expect(routeElementFor('/auth/callback')).toBeTruthy();
    expect(redirectTargetFor('/auth/callback')).toBeNull();
  });

  test('does not own Dashboard observability routes', () => {
    expect(redirectTargetFor('/logs')).toBe('/models');
    expect(redirectTargetFor('/rdf')).toBe('/models');
    expect(redirectTargetFor('/usage')).toBe('/models');
  });
});
