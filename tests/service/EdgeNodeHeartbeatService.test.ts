import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EdgeNodeHeartbeatService } from '../../src/service/EdgeNodeHeartbeatService';

describe('EdgeNodeHeartbeatService', () => {
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' } as any));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

  it('立即发送心跳并按照间隔继续上报', async () => {
  new EdgeNodeHeartbeatService({
    edgeNodesEnabled: 'true',
    signalEndpoint: 'https://cluster.example/api/signal',
    nodeId: 'node-1',
    nodeToken: 'top-secret',
      baseUrl: 'https://pods.example.com/',
      publicAddress: 'https://edge.example/',
      pods: 'https://pods.example.com/alice/',
    intervalMs: 1_000,
  });

    const fetchMock = global.fetch as unknown as vi.Mock;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.nodeId).toBe('node-1');
    expect(payload.pods).toEqual([ 'https://pods.example.com/alice/' ]);
  });

  it('缺少配置时不会启动', () => {
  new EdgeNodeHeartbeatService({ edgeNodesEnabled: 'false', signalEndpoint: 'https://cluster.example/api/signal', nodeId: 'node-1', nodeToken: 't' });
  new EdgeNodeHeartbeatService({ edgeNodesEnabled: 'true', signalEndpoint: '', nodeId: 'node-1', nodeToken: 't' });
  new EdgeNodeHeartbeatService({ edgeNodesEnabled: 'true', signalEndpoint: 'https://cluster.example/api/signal', nodeToken: 't' });
    const fetchMock = global.fetch as unknown as vi.Mock;
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
