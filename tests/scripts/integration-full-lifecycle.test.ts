import { afterEach, describe, expect, it, vi } from 'vitest';

const { startRuntime } = vi.hoisted(() => ({ startRuntime: vi.fn() }));
vi.mock('../../src/runtime/XpodRuntime', () => ({ startXpodRuntime: startRuntime }));
import { startFullRuntimes } from '../../scripts/run-integration-full';

const ports = {
  cloud: { gateway: 6300, css: 6310, api: 6311, ingress: 6303 },
  cloudB: { gateway: 6400, css: 6410, api: 6411, ingress: 6403 },
  local: { gateway: 5737, css: 5747, api: 5748, ingress: 5740 },
  standalone: { gateway: 5739, css: 5749, api: 5750, ingress: 5742 },
};

describe('full integration startup cleanup', () => {
  afterEach(() => { vi.restoreAllMocks(); startRuntime.mockReset(); });

  it.each([false, true])('reports the startup error before stopping partial runtimes (stop fails=%s)', async stopFails => {
    const order: string[] = [];
    const original = new Error('second node startup failed');
    const stop = vi.fn(async () => { order.push('stop'); if (stopFails) throw new Error('stop failed'); });
    const log = vi.spyOn(console, 'error').mockImplementation(() => { order.push('error'); });
    startRuntime.mockResolvedValueOnce({ stop }).mockRejectedValueOnce(original);

    await expect(startFullRuntimes(ports, 'fixture-command')).rejects.toBe(original);
    expect(stop).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('[full] Runtime startup failed:', original);
    expect(order).toEqual(['error', 'stop']);
  });

  it('hands successful runtimes to the caller without stopping them', async () => {
    const stop = vi.fn(async () => {});
    startRuntime.mockResolvedValue({ stop });
    const runtimes = await startFullRuntimes(ports, 'fixture-command');
    expect(runtimes).toHaveLength(4);
    for (const [index, plan] of Object.values(ports).entries()) {
      expect(startRuntime.mock.calls[index][0]).toMatchObject({
        gatewayPort: plan.gateway, cssPort: plan.css, apiPort: plan.api, ingressPort: plan.ingress,
      });
    }
    expect(stop).not.toHaveBeenCalled();
  });
});
