import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EdgeNodeHealthProbeService } from '../../src/edge/EdgeNodeHealthProbeService';

const ResponseCtor = Response;

describe('EdgeNodeHealthProbeService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('runs multi-location probes and stores samples', async () => {
    const repo = {
      getNodeMetadata: vi.fn().mockResolvedValue({
        metadata: {
          publicAddress: 'https://node.example/ping',
        },
      }),
      mergeNodeMetadata: vi.fn(),
    };

    const fetchMock = vi.fn();
    fetchMock
      // Local cluster probe (HEAD)
      .mockResolvedValueOnce(new ResponseCtor(null, { status: 200 }))
      // Remote probe endpoint
      .mockResolvedValueOnce(new ResponseCtor(JSON.stringify({ success: true, latencyMs: 42 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const service = new EdgeNodeHealthProbeService({
      repository: repo as any,
      enabled: true,
      locations: [ 'cluster', 'remote@https://probe.example/api/check' ],
    });

    await service.probeNode('node-1');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(repo.mergeNodeMetadata).toHaveBeenCalledTimes(1);
    const reachability = repo.mergeNodeMetadata.mock.calls[0][1].reachability;
    expect(reachability.samples).toHaveLength(2);
    const locations = reachability.samples.map((sample: any) => sample.location);
    expect(locations).toContain('cluster');
    expect(locations).toContain('remote');
    expect(reachability.status).toBe('direct');
    expect(reachability.lastSuccessAt).toBeDefined();
  });
});
