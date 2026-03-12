import { describe, expect, it } from 'vitest';
import { NodeRuntimeHost } from '../../src/runtime/host/node/NodeRuntimeHost';

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
    })).resolves.toEqual({
      gateway: 5610,
      css: 5611,
      api: 5612,
    });
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
