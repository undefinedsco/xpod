import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EdgeNodeHealthProbeService } from '../../src/edge/EdgeNodeHealthProbeService';

const ResponseCtor = Response;

describe('EdgeNodeHealthProbeService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function createRepo(candidate: string) {
    return {
      getNodeMetadata: vi.fn().mockResolvedValue({
        metadata: {
          tunnel: {
            entrypoint: candidate,
          },
        },
      }),
      mergeNodeMetadata: vi.fn(),
    };
  }

  it('runs multi-location probes and stores samples', async () => {
    const repo = createRepo('https://node.example/ping');

    const fetchMock = vi.fn();
    fetchMock
      // Remote probe endpoint
      .mockResolvedValueOnce(new ResponseCtor(JSON.stringify({ success: true, latencyMs: 42 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const headRequest = vi.fn().mockResolvedValue({ status: 200 });
    const service = new EdgeNodeHealthProbeService({
      repository: repo as any,
      enabled: true,
      locations: [ 'cluster', 'remote@https://probe.example/api/check' ],
      resolveAddresses: async() => [ '93.184.216.34' ],
      headRequest,
    });

    await service.probeNode('node-1');

    expect(headRequest).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(repo.mergeNodeMetadata).toHaveBeenCalledTimes(1);
    const reachability = repo.mergeNodeMetadata.mock.calls[0][1].reachability;
    expect(reachability.samples).toHaveLength(2);
    const locations = reachability.samples.map((sample: any) => sample.location);
    expect(locations).toContain('cluster');
    expect(locations).toContain('remote');
    expect(reachability.status).toBe('direct');
    expect(reachability.lastSuccessAt).toBeDefined();
  });

  it('never contacts a private, loopback or metadata candidate', async () => {
    for (const candidate of [
      'http://127.0.0.1:3000/',
      'http://10.0.0.5/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]:8080/',
    ]) {
      const repo = createRepo(candidate);
      const headRequest = vi.fn().mockResolvedValue({ status: 200 });
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const service = new EdgeNodeHealthProbeService({
        repository: repo as any,
        enabled: true,
        locations: [ 'cluster' ],
        headRequest,
      });

      await service.probeNode('node-1');

      expect(headRequest, candidate).not.toHaveBeenCalled();
      expect(fetchMock, candidate).not.toHaveBeenCalled();
      const reachability = repo.mergeNodeMetadata.mock.calls[0][1].reachability;
      expect(reachability.samples[0].success).toBe(false);
      expect(reachability.samples[0].error).toContain('blocked-target');
      expect(reachability.status).toBe('unreachable');
    }
  });

  it('does not hand a private candidate to a remote probe location either', async () => {
    const repo = createRepo('http://192.168.1.20:5737/');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new EdgeNodeHealthProbeService({
      repository: repo as any,
      enabled: true,
      locations: [ 'remote@https://probe.example/api/check' ],
      headRequest: vi.fn(),
    });

    await service.probeNode('node-1');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-validates every redirect hop and refuses one that enters a private address', async () => {
    const repo = createRepo('https://node.example/ping');
    const headRequest = vi.fn()
      .mockResolvedValueOnce({ status: 302, location: 'http://169.254.169.254/latest/meta-data/' });

    const service = new EdgeNodeHealthProbeService({
      repository: repo as any,
      enabled: true,
      locations: [ 'cluster' ],
      resolveAddresses: async() => [ '93.184.216.34' ],
      headRequest,
    });

    await service.probeNode('node-1');

    expect(headRequest).toHaveBeenCalledTimes(1);
    const reachability = repo.mergeNodeMetadata.mock.calls[0][1].reachability;
    expect(reachability.samples[0].error).toContain('blocked-redirect');
    expect(reachability.status).toBe('unreachable');
  });

  it('follows a redirect to another public target', async () => {
    const repo = createRepo('https://node.example/ping');
    const headRequest = vi.fn()
      .mockResolvedValueOnce({ status: 301, location: '/moved' })
      .mockResolvedValueOnce({ status: 204 });

    const service = new EdgeNodeHealthProbeService({
      repository: repo as any,
      enabled: true,
      locations: [ 'cluster' ],
      resolveAddresses: async() => [ '93.184.216.34' ],
      headRequest,
    });

    await service.probeNode('node-1');

    expect(headRequest).toHaveBeenCalledTimes(2);
    expect(headRequest.mock.calls[1][0].toString()).toBe('https://node.example/moved');
    const reachability = repo.mergeNodeMetadata.mock.calls[0][1].reachability;
    expect(reachability.status).toBe('direct');
  });
});
