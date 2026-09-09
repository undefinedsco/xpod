import { describe, expect, it, vi } from 'vitest';
import { DdnsManager } from '../../src/edge/DdnsManager';

describe('DdnsManager', () => {
  it('reconciles an existing allocation with the current direct address', async () => {
    const client = {
      getDdns: vi.fn().mockResolvedValue({
        fqdn: 'node-1.nodes.example',
        ipAddress: '10.0.0.2',
      }),
      allocateDdns: vi.fn(),
      updateDdns: vi.fn().mockResolvedValue({
        success: true,
        fqdn: 'node-1.nodes.example',
      }),
    };
    const detector = {
      detectNetworkAddresses: vi.fn().mockResolvedValue({
        ipv4: '192.168.1.10',
        ipv4Public: undefined,
        ipv6: '2409:8a5c::1',
        ipv6Public: '2409:8a5c::1',
      }),
    };

    const manager = new DdnsManager({
      client: client as any,
      detector: detector as any,
      subdomain: 'node-1',
      localPort: 3000,
      autoAllocate: true,
    });

    await manager.runOnce();

    expect(client.allocateDdns).not.toHaveBeenCalled();
    expect(client.updateDdns).toHaveBeenCalledWith('node-1', {
      ipAddress: '192.168.1.10',
      ipv6Address: '2409:8a5c::1',
      mode: 'direct',
      tunnelProvider: 'none',
      localPort: 3000,
    });
  });
});
