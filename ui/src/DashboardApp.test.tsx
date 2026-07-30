import { describe, expect, test } from 'bun:test';
import { isValidElement } from 'react';
import { Navigate, matchRoutes } from 'react-router-dom';
import { dashboardRoutes } from './dashboard-routes';

function routeElementFor(path: string) {
  const matches = matchRoutes(dashboardRoutes, path);
  return matches?.at(-1)?.route.element;
}

function redirectTargetFor(path: string) {
  const element = routeElementFor(path);
  if (!isValidElement(element) || element.type !== Navigate) return null;
  return element.props.to;
}

describe('dashboard routes', () => {
  test('redirects the dashboard index to Models', () => {
    expect(redirectTargetFor('/')).toBe('/models');
  });

  test('keeps replaceable routes for the new settings sections', () => {
    expect(routeElementFor('/models')).toBeTruthy();
    expect(routeElementFor('/pod')).toBeTruthy();
    expect(routeElementFor('/network')).toBeTruthy();
    expect(routeElementFor('/services')).toBeTruthy();
  });

  test('redirects legacy admin routes into Services subroutes', () => {
    expect(redirectTargetFor('/status')).toBe('/services');
    expect(redirectTargetFor('/logs')).toBe('/services/logs');
    expect(redirectTargetFor('/rdf')).toBe('/services/rdf');
    expect(redirectTargetFor('/settings')).toBe('/services/runtime');
  });
});
