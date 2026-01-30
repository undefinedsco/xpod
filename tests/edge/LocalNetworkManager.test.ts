import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalNetworkManager } from '../../src/edge/LocalNetworkManager';
import type { EdgeNodeCapabilityDetector } from '../../src/edge/EdgeNodeCapabilityDetector';
import type { EdgeNodeDnsCoordinator } from '../../src/edge/EdgeNodeDnsCoordinator';

describe('LocalNetworkManager', () => {
  let detector: EdgeNodeCapabilityDetector;
  let dnsCoordinator: EdgeNodeDnsCoordinator;
  let manager: LocalNetworkManager;

  beforeEach(() => {
    detector = {
      detectNetworkAddresses: vi.fn().mockResolvedValue({
        ipv4: '192.168.1.10',
        ipv6: 'fe80::1',
        ipv4Public: '1.2.3.4',
        ipv6Public: '240e:abcd::1',
        hasPublicIPv6: true,
      }),
    } as any;

    dnsCoordinator = {
      synchronize: vi.fn().mockResolvedValue(undefined),
    } as any;

    manager = new LocalNetworkManager({
      detector,
      dnsCoordinator,
      intervalMs: 100, // Short interval for testing
    });
  });

  afterEach(() => {
    manager.stop();
  });

  it('should detect network and synchronize DNS on start', async () => {
    manager.start();

    // Wait for async execution
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(detector.detectNetworkAddresses).toHaveBeenCalled();
    expect(dnsCoordinator.synchronize).toHaveBeenCalledWith('local-self', {
      ipv4: '1.2.3.4',
      ipv6: '240e:abcd::1',
      accessMode: 'direct',
      subdomain: '@',
    });
  });

  it('should not synchronize if no public IP detected', async () => {
    detector.detectNetworkAddresses = vi.fn().mockResolvedValue({
      ipv4: undefined,
      ipv6: undefined,
      ipv4Public: undefined,
      ipv6Public: undefined,
    });

    manager.start();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(detector.detectNetworkAddresses).toHaveBeenCalled();
    expect(dnsCoordinator.synchronize).not.toHaveBeenCalled();
  });

  it('should continue running periodically', async () => {
    manager.start();

    // Wait for > 100ms
    await new Promise(resolve => setTimeout(resolve, 150));

    // Should have run at least twice (initial + 1 interval)
    expect(detector.detectNetworkAddresses).toHaveBeenCalledTimes(2);
  });
});
