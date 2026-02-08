import { describe, it, expect } from 'vitest';

const RUN_DOCKER_LITE_TESTS = process.env.XPOD_RUN_DOCKER_LITE_TESTS === 'true';
const suite = RUN_DOCKER_LITE_TESTS ? describe : describe.skip;

suite('Server Root Access (Docker Lite)', () => {
  const baseUrl = 'http://localhost:5739/';

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
    expect(contentType).toContain('text/turtle');

    const text = await response.text();
    expect(text).toContain('ldp:contains');
  });
});
