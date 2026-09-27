import { describe, expect, it } from 'vitest';
import {
  canonicalProductPathname,
  canonicalRoutes,
  legacyProductRedirects,
  surfaceForPathname,
  XPOD_DEFAULT_RETURN_PATH,
} from './canonical-routes';

describe('canonical product routes', () => {
  it('lands the product in the WebID-authorized workspace', () => {
    // The Account-protected Status overview is a destination the user picks,
    // not where an unauthenticated entry starts.
    expect(XPOD_DEFAULT_RETURN_PATH).toBe(canonicalRoutes.aiConnections);
    expect(canonicalProductPathname(XPOD_DEFAULT_RETURN_PATH)).toBe('/ai-connections');
  });

  it('keeps each first-level workspace on its own stable route family', () => {
    expect(canonicalRoutes).toMatchObject({
      status: '/status/overview',
      gateway: '/status/services/gateway',
      network: '/network',
      aiConnections: '/ai-connections',
      aiConfig: '/ai-config/model-assignments',
      settings: '/settings/pod',
    });
  });

  it('canonicalizes exact legacy paths without rewriting unknown descendants', () => {
    expect(canonicalProductPathname('/settings/models')).toBe('/ai-connections');
    expect(canonicalProductPathname('/settings/ai-connections')).toBe('/ai-connections');
    expect(canonicalProductPathname('/dashboard/network')).toBe('/network');
    expect(canonicalProductPathname('/dashboard/custom')).toBe('/dashboard/custom');
  });

  it('maps legacy product entry points to canonical workspaces', () => {
    expect(legacyProductRedirects['/dashboard/overview']).toBe('/status/overview');
    expect(legacyProductRedirects['/dashboard/network']).toBe('/network');
    expect(legacyProductRedirects['/settings/models']).toBe('/ai-connections');
    expect(legacyProductRedirects['/settings/ai-connections']).toBe('/ai-connections');
    expect(legacyProductRedirects['/settings/ai-config']).toBe('/ai-config/model-assignments');
    expect(legacyProductRedirects['/settings/system']).toBe('/settings/runtime');
  });

  it('covers every §3.3 row whose target page exists today', () => {
    // spec §3.3 的表：设置类入口归「服务与访问」，日志与索引诊断各有自己的目标
    expect(legacyProductRedirects['/dashboard/status']).toBe('/status/overview');
    expect(legacyProductRedirects['/dashboard/runtime']).toBe('/status/overview');
    expect(legacyProductRedirects['/dashboard/logs']).toBe('/status/logs');
    expect(legacyProductRedirects['/dashboard/rdf']).toBe('/status/index/rdf');
    expect(legacyProductRedirects['/dashboard/services']).toBe('/settings/runtime');
    expect(legacyProductRedirects['/dashboard/settings']).toBe('/settings/runtime');
    expect(legacyProductRedirects['/settings/services']).toBe('/settings/runtime');
  });

  it('sends every legacy target to a route family the shell actually owns', () => {
    const roots = ['/status', '/network', '/settings', '/ai-connections', '/ai-config'];
    for (const [from, to] of Object.entries(legacyProductRedirects)) {
      expect(roots.some((root) => to === root || to.startsWith(`${root}/`)), `${from} -> ${to}`).toBe(true);
    }
  });

  it('selects the correct SPA surface from the canonical pathname', () => {
    expect(surfaceForPathname('/status/services/api-server')).toEqual({ app: 'dashboard', basename: '/status' });
    expect(surfaceForPathname('/network/diagnostics')).toEqual({ app: 'dashboard', basename: '/network' });
    expect(surfaceForPathname('/ai-connections')).toEqual({ app: 'settings', basename: '/ai-connections' });
    expect(surfaceForPathname('/ai-config/search-indexing')).toEqual({ app: 'settings', basename: '/ai-config' });
    expect(surfaceForPathname('/settings/runtime')).toEqual({ app: 'settings', basename: '/settings' });
  });
});
