import { describe, it, expect } from 'vitest';
import { resolveSolidIntegrationConfig } from '../http/utils/integrationEnv';

const RUN_INTEGRATION_TESTS = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
const suite = RUN_INTEGRATION_TESTS ? describe : describe.skip;

suite('Server Root Access (Integration)', () => {
  const { baseUrl } = resolveSolidIntegrationConfig();

  it('should return 200 OK for GET /', async () => {
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
  });

  it('should return RDF/Turtle metadata for root container', async () => {
    const response = await fetch(baseUrl, {
      headers: {
        Accept: 'text/turtle',
      },
    });

    expect(response.status).toBe(200);
    const contentType = response.headers.get('content-type') || '';

    const text = await response.text();
    if (contentType.includes('text/turtle')) {
      expect(text).toContain('ldp:contains');
    } else {
      expect(contentType).toContain('text/html');
      expect(text.length).toBeGreaterThan(100);
    }
  });
});
