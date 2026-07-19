import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayProxy, getFreePort } from '../../src/runtime';
import { Supervisor } from '../../src/supervisor/Supervisor';

describe('GatewayProxy CSS health recovery', () => {
  let proxy: GatewayProxy | undefined;
  let upstream: http.Server | undefined;

  afterEach(async () => {
    delete process.env.XPOD_CSS_HEALTH_INTERVAL_MS;
    await proxy?.stop();
    await new Promise<void>((resolve) => upstream?.close(() => resolve()) ?? resolve());
  });

  it('restarts CSS after three HTTP probes time out', async () => {
    const upstreamPort = await getFreePort(4400, '127.0.0.1');
    const gatewayPort = await getFreePort(upstreamPort + 1, '127.0.0.1');
    upstream = http.createServer(() => {
      // Keep the request open to model a live process with a wedged HTTP loop.
    });
    await new Promise<void>((resolve) => upstream!.listen(upstreamPort, '127.0.0.1', resolve));

    const supervisor = new Supervisor({ handleProcessSignals: false });
    const restart = vi.spyOn(supervisor, 'restart').mockResolvedValue();
    process.env.XPOD_CSS_HEALTH_INTERVAL_MS = '20';

    proxy = new GatewayProxy(gatewayPort, supervisor, '127.0.0.1');
    proxy.setTargets({ css: `http://127.0.0.1:${upstreamPort}` });
    await proxy.start();

    await vi.waitFor(() => expect(restart).toHaveBeenCalledWith('css'), { timeout: 6_000 });
  }, 8_000);
});
