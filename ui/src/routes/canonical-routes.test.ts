import { describe, expect, it } from 'vitest';
import { canonicalProductPathname, canonicalRoutes, legacyProductRedirects, productSurfaceRoots, surfaceForPathname, XPOD_DEFAULT_RETURN_PATH } from './canonical-routes';

describe('desktop product route ownership', () => {
  it('starts the WebID workspace and names each canonical host surface', () => {
    expect(XPOD_DEFAULT_RETURN_PATH).toBe('/ai-connections');
    expect(canonicalRoutes).toMatchObject({ tasks: '/tasks', pod: '/pod/models', device: '/device/network', settings: '/settings/appearance' });
  });
  it.each(Object.entries(legacyProductRedirects))('maps %s to its one editing surface', (oldPath, canonical) => {
    expect(canonicalProductPathname(oldPath)).toBe(canonical);
    expect(canonicalProductPathname(`${oldPath}/`)).toBe(canonical);
  });
  it.each(['/tasks', '/pod', '/device', '/inbox', '/notifications', '/ai-connections', '/settings'])('owns the entry document for %s', path => {
    expect(productSurfaceRoots.some(({ basename }) => basename === path)).toBe(true);
    expect(surfaceForPathname(`${path}/detail`).app).toBe('settings');
  });
});
