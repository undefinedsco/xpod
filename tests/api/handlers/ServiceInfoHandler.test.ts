import { expect, test, vi } from 'vitest';
import type { ApiServer } from '../../../src/api/ApiServer';
import { registerServiceInfoRoute } from '../../../src/api/handlers/ServiceInfoHandler';

test.each(['https://user:secret@example.com/', 'https://node.example/?token=secret', 'javascript:alert(1)', 'bad url'])(
  'omits unsafe public URLs and issuer credentials: %s', async url => {
    const server = { get: vi.fn() };
    registerServiceInfoRoute(server as unknown as ApiServer, () => ({ edition: 'local', managed: true, publicUrl: url, oidcIssuer: url }));
    const response = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
    await server.get.mock.calls[0][1]({}, response);
    expect(JSON.parse(response.end.mock.calls[0][0])).toEqual({ edition: 'local', managed: true, publicUrl: null });
  },
);
