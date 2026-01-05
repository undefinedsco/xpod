import { describe, it, expect, beforeAll } from 'vitest';

// Read from environment variable - must be set
const baseUrl = process.env.CSS_BASE_URL;

if (!baseUrl) {
  throw new Error('CSS_BASE_URL environment variable must be set');
}

describe('Server Mode Root Access (Drizzle)', () => {

  beforeAll(async () => {
    // Check if server is reachable
    try {
      const response = await fetch(baseUrl, { method: 'HEAD' });
      if (!response.ok && ![401, 404, 405].includes(response.status)) {
        throw new Error(`Server responded with status ${response.status}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to reach server at ${baseUrl}. Start it first with "yarn local". Details: ${message}`);
    }
  }, 10000);

  it('should return 200 OK with SPA HTML for GET /', async () => {
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    
    const contentType = response.headers.get('content-type');
    expect(contentType).toContain('text/html');
    
    const text = await response.text();
    // Should contain SPA markers
    expect(text).toContain('<!doctype html>');
    expect(text).toContain('<div id="root">');
  });

  it('should return SPA HTML even with Accept: text/turtle (static-root mode)', async () => {
    // In static-root mode, root path always returns the static HTML page
    // regardless of Accept header. This is by design - Pods are at /{username}/
    const response = await fetch(baseUrl, {
      headers: {
        'Accept': 'text/turtle'
      }
    });
    
    expect(response.status).toBe(200);
    
    const contentType = response.headers.get('content-type');
    expect(contentType).toContain('text/html');
    
    const text = await response.text();
    expect(text).toContain('<!doctype html>');
  });
});
