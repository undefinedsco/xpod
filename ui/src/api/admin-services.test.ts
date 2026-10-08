import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchServicesStatusSnapshot } from './admin';

afterEach(() => vi.unstubAllGlobals());

describe('device service status authority', () => {
  it('combines owner states with supervisor states without overwriting supervisor facts', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/service/status') return Response.json([
        { name: 'api', status: 'running', pid: 11, restartCount: 2 },
      ]);
      if (url === '/api/admin/status') return Response.json({ status: 'running', services: [
        { name: 'api', status: 'stopped' },
        { name: 'qlever', status: 'crashed' },
        { name: 'inngest', status: 'managed' },
      ] });
      return new Response('', { status: 404 });
    }));
    const snapshot = await fetchServicesStatusSnapshot();
    expect(snapshot.servicesData).toEqual([
      { name: 'api', status: 'running', pid: 11, restartCount: 2 },
      { name: 'qlever', status: 'crashed' },
      { name: 'inngest', status: 'managed' },
    ]);
  });

  it('does not invent native child health when the API cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/service/status'
      ? Response.json([{ name: 'api', status: 'running', restartCount: 0 }])
      : new Response('', { status: 403 })));
    expect((await fetchServicesStatusSnapshot()).servicesData).toEqual([
      { name: 'api', status: 'running', restartCount: 0 },
    ]);
  });
});
