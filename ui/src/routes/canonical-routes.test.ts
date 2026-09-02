import { describe, expect, it } from 'vitest';
import { canonicalProductPathname, canonicalRoutes, legacyProductRedirects, surfaceForPathname } from './canonical-routes';

describe('canonical product routes', () => {
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
    expect(legacyProductRedirects['/settings/system']).toBe('/settings/pod');
  });

  it('selects the correct SPA surface from the canonical pathname', () => {
    expect(surfaceForPathname('/status/services/api-server')).toEqual({ app: 'dashboard', basename: '/status' });
    expect(surfaceForPathname('/network/diagnostics')).toEqual({ app: 'dashboard', basename: '/network' });
    expect(surfaceForPathname('/ai-connections')).toEqual({ app: 'settings', basename: '/ai-connections' });
    expect(surfaceForPathname('/ai-config/search-indexing')).toEqual({ app: 'settings', basename: '/ai-config' });
    expect(surfaceForPathname('/settings/runtime')).toEqual({ app: 'settings', basename: '/settings' });
  });
});
