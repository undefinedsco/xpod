import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EdgeNodeDnsCoordinator } from '../../src/edge/EdgeNodeDnsCoordinator';

describe('EdgeNodeDnsCoordinator', () => {
  const upsertRecord = vi.fn();
  const mockProvider = {
    upsertRecord,
  };

  beforeEach(() => {
    upsertRecord.mockReset();
  });

  it('synchronizes direct mode nodes to their public IP', async () => {
    const coordinator = new EdgeNodeDnsCoordinator({
      provider: mockProvider as any,
      rootDomain: 'cluster.example',
      ttl: 120,
      clusterIp: '203.0.113.10',
    });

    await coordinator.synchronize('node-1', {
      subdomain: 'node-1',
      accessMode: 'direct',
      publicIp: '198.51.100.5',
    });

    expect(upsertRecord).toHaveBeenCalledWith({
      domain: 'cluster.example',
      subdomain: 'node-1',
      type: 'A',
      value: '198.51.100.5',
      ttl: 120,
    });
  });

  it('falls back to ipv4 field when publicIp is missing', async () => {
    const coordinator = new EdgeNodeDnsCoordinator({
      provider: mockProvider as any,
      rootDomain: 'cluster.example',
      ttl: 300,
      clusterIp: '203.0.113.10',
    });

    await coordinator.synchronize('node-2', {
      subdomain: 'node-2',
      accessMode: 'direct',
      ipv4: '203.0.113.42',
    });

    expect(upsertRecord).toHaveBeenCalledWith({
      domain: 'cluster.example',
      subdomain: 'node-2',
      type: 'A',
      value: '203.0.113.42',
      ttl: 300,
    });
  });

  it('points proxy nodes to the cluster ingress IP', async () => {
    const coordinator = new EdgeNodeDnsCoordinator({
      provider: mockProvider as any,
      rootDomain: 'cluster.example',
      ttl: 60,
      clusterIp: '192.0.2.55',
    });

    await coordinator.synchronize('node-proxy', {
      subdomain: 'node-proxy',
      accessMode: 'proxy',
    });

    expect(upsertRecord).toHaveBeenCalledWith({
      domain: 'cluster.example',
      subdomain: 'node-proxy',
      type: 'A',
      value: '192.0.2.55',
      ttl: 60,
    });
  });

  it('skips proxy nodes when cluster ingress IP is missing', async () => {
    const coordinator = new EdgeNodeDnsCoordinator({
      provider: mockProvider as any,
      rootDomain: 'cluster.example',
    });

    await coordinator.synchronize('node-skip', {
      subdomain: 'node-skip',
      accessMode: 'proxy',
    });

    expect(upsertRecord).not.toHaveBeenCalled();
  });

  it('falls back to legacy dns hints when access mode is unknown', async () => {
    const coordinator = new EdgeNodeDnsCoordinator({
      provider: mockProvider as any,
      rootDomain: 'cluster.example',
    });

    await coordinator.synchronize('node-legacy', {
      dns: {
        subdomain: 'legacy',
        target: 'legacy.edge.example.com',
      },
    } as any);

    expect(upsertRecord).toHaveBeenCalledWith({
      domain: 'cluster.example',
      subdomain: 'legacy',
      type: 'CNAME',
      value: 'legacy.edge.example.com.',
      ttl: undefined,
    });
  });
});
