import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLogs } from './admin';

afterEach(() => { vi.unstubAllGlobals(); });
describe('device log authority', () => {
  it('reads supervisor logs through a current-origin relative URL with server filters', async () => {
    const logs = [{ timestamp: '2026-10-02T12:00:00Z', source: 'css', level: 'debug', message: 'ready' }];
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(logs)));
    vi.stubGlobal('fetch', fetcher);
    expect(await getLogs({ source: 'css', level: 'debug', limit: 500 })).toEqual(logs);
    expect(fetcher).toHaveBeenCalledWith('/service/logs?limit=500&level=debug&source=css');
  });

  it('keeps direct API installations working when no supervisor endpoint exists', async () => {
    const logs = [{ source: 'api', level: 'warn', message: 'direct API' }];
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ logs })));
    vi.stubGlobal('fetch', fetcher);
    expect(await getLogs({ level: 'warn' })).toEqual(logs);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/service/logs?level=warn', '/api/admin/logs?level=warn']);
  });

  it.each([401, 403, 500])('does not fall back around supervisor HTTP %s', async (status) => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status }));
    vi.stubGlobal('fetch', fetcher);
    expect(await getLogs()).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
