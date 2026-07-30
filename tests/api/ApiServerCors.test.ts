import { afterEach, describe, expect, it } from 'vitest';
import { ApiServer } from '../../src/api/ApiServer';

describe('ApiServer CORS', () => {
  let server: ApiServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('explicitly allows authorization and DPoP headers during preflight', async () => {
    server = new ApiServer({ port: 0 });
    server.get('/api/test', async (_request, response) => {
      response.statusCode = 200;
      response.end('ok');
    }, { public: true });
    await server.start();

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('ApiServer did not bind a TCP port');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/api/test`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization,dpop',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    const allowedHeaders = response.headers.get('access-control-allow-headers')?.toLowerCase() ?? '';
    expect(allowedHeaders.split(/\s*,\s*/)).toEqual(expect.arrayContaining([
      'authorization',
      'dpop',
    ]));
  });
});
