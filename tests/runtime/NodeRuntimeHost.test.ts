import { describe, expect, it } from 'vitest';
import net from 'node:net';
import { NodeRuntimeHost } from '../../src/runtime/host/node/NodeRuntimeHost';

function listenOn(server: net.Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

describe('NodeRuntimeHost', () => {
  const host = new NodeRuntimeHost();

  it('should respect explicit transport preference', () => {
    expect(host.resolveTransport('socket')).toBe('socket');
    expect(host.resolveTransport('port')).toBe('port');
  });

  it('should default transport based on platform', () => {
    expect(host.resolveTransport()).toBe(process.platform === 'win32' ? 'port' : 'socket');
  });

  it('should preserve explicit port allocation', async() => {
    await expect(host.allocatePorts({
      gatewayPort: 5610,
      cssPort: 5611,
      apiPort: 5612,
      ingressPort: 5613,
    })).resolves.toEqual({
      gateway: 5610,
      css: 5611,
      api: 5612,
      ingress: 5613,
    });
  });

  it('should allocate an ingress port of its own for the other ports', async() => {
    const ports = await host.allocatePorts({
      gatewayPort: 5620,
      cssPort: 5621,
      apiPort: 5622,
    });

    // Remote forwarding terminates on this machine, so it needs its own listener that
    // the Gateway can tell apart from a genuine local client.
    expect(ports.ingress).toBeGreaterThan(0);
    expect([ ports.gateway, ports.css, ports.api ]).not.toContain(ports.ingress);
  });

  it('should not claim a port another runtime has already planned', async() => {
    // The full integration harness plans `css = gateway + 10` and `api = gateway + 11` per
    // runtime, so the neighbour of this runtime's api port belongs to the next runtime.
    // Deriving the ingress port by probing upwards stole that service's port.
    const first = await host.allocatePorts({ gatewayPort: 5630, cssPort: 5640, apiPort: 5641 });

    const ingressListener = net.createServer();
    await listenOn(ingressListener, first.ingress);
    try {
      const otherRuntimeCss = net.createServer();
      await expect(listenOn(otherRuntimeCss, 5642)).resolves.toBeUndefined();
      await new Promise<void>((resolve) => otherRuntimeCss.close(() => resolve()));
    } finally {
      await new Promise<void>((resolve) => ingressListener.close(() => resolve()));
    }
  });

  it('should format listen endpoints', () => {
    expect(host.formatListenEndpoint(host.createListenEndpoint({
      host: '127.0.0.1',
      port: 5700,
    }))).toBe('http://127.0.0.1:5700');

    expect(host.formatListenEndpoint(host.createListenEndpoint({
      socketPath: '/tmp/xpod-test.sock',
    }))).toBe('unix:///tmp/xpod-test.sock');
  });
});
