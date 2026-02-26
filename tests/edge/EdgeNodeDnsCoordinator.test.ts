import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EdgeNodeDnsCoordinator } from '../../src/edge/EdgeNodeDnsCoordinator';

describe('EdgeNodeDnsCoordinator', () => {
  const upsertRecord = vi.fn();
  const deleteRecord = vi.fn();
  const mockProvider = {
    upsertRecord,
    deleteRecord,
  };

  beforeEach(() => {
    upsertRecord.mockReset();
    deleteRecord.mockReset();
  });

  it('synchronizes node to its publicIp', async () => {
    const coordinator = new EdgeNodeDnsCoordinator({
      provider: mockProvider as any,
      rootDomain: 'undefineds.site',
      ttl: 120,
    });

    await coordinator.synchronize('node-1', {
      subdomain: 'node-1',
      publicIp: '198.51.100.5',
    });

    expect(upsertRecord).toHaveBeenCalledWith({
      domain: 'undefineds.site',
      subdomain: 'node-1',
      type: 'A',
      value: '198.51.100.5',
      ttl: 120,
    });
  });

  it('falls back to ipv4 field when publicIp is missing', async () => {
    const coordinator = new EdgeNodeDnsCoordinator({
      provider: mockProvider as any,
      rootDomain: 'undefineds.site',
      ttl: 300,
    });

    await coordinator.synchronize('node-2', {
      subdomain: 'node-2',
      ipv4: '203.0.113.42',
    });

    expect(upsertRecord).toHaveBeenCalledWith({
      domain: 'undefineds.site',
      subdomain: 'node-2',
      type: 'A',
      value: '203.0.113.42',
      ttl: 300,
    });
  });

  it('skips when no address is provided', async () => {
    const coordinator = new EdgeNodeDnsCoordinator({
      provider: mockProvider as any,
      rootDomain: 'undefineds.site',
    });

    await coordinator.synchronize('node-skip', {
      subdomain: 'node-skip',
    });

    expect(upsertRecord).not.toHaveBeenCalled();
  });

  it('falls back to legacy dns hints', async () => {
    const coordinator = new EdgeNodeDnsCoordinator({
      provider: mockProvider as any,
      rootDomain: 'undefineds.site',
    });

    await coordinator.synchronize('node-legacy', {
      dns: {
        subdomain: 'legacy',
        target: 'legacy.edge.example.com',
      },
    } as any);

    expect(upsertRecord).toHaveBeenCalledWith({
      domain: 'undefineds.site',
      subdomain: 'legacy',
      type: 'CNAME',
      value: 'legacy.edge.example.com.',
      ttl: undefined,
    });
  });

  it('deletes DNS record when connectivityStatus is unreachable', async () => {
    const coordinator = new EdgeNodeDnsCoordinator({
      provider: mockProvider as any,
      rootDomain: 'undefineds.site',
      ttl: 120,
    });

    await coordinator.synchronize('node-down', {
      subdomain: 'node-down',
      publicIp: '198.51.100.5',
      connectivityStatus: 'unreachable',
    });

    expect(upsertRecord).not.toHaveBeenCalled();
    expect(deleteRecord).toHaveBeenCalledWith({
      domain: 'undefineds.site',
      subdomain: 'node-down',
      type: 'A',
    });
  });

  it('creates DNS record when connectivityStatus is reachable', async () => {
    const coordinator = new EdgeNodeDnsCoordinator({
      provider: mockProvider as any,
      rootDomain: 'undefineds.site',
      ttl: 120,
    });

    await coordinator.synchronize('node-up', {
      subdomain: 'node-up',
      publicIp: '198.51.100.10',
      connectivityStatus: 'reachable',
    });

    expect(upsertRecord).toHaveBeenCalledWith({
      domain: 'undefineds.site',
      subdomain: 'node-up',
      type: 'A',
      value: '198.51.100.10',
      ttl: 120,
    });
    expect(deleteRecord).not.toHaveBeenCalled();
  });

  it('uses FRP entrypoint IP when node reports it as publicIp', async () => {
    const coordinator = new EdgeNodeDnsCoordinator({
      provider: mockProvider as any,
      rootDomain: 'undefineds.site',
      ttl: 60,
    });

    // 节点没有公网 IP，报的是 FRP 入口地址
    await coordinator.synchronize('node-frp', {
      subdomain: 'node-frp',
      publicIp: '10.0.0.99',
    });

    expect(upsertRecord).toHaveBeenCalledWith({
      domain: 'undefineds.site',
      subdomain: 'node-frp',
      type: 'A',
      value: '10.0.0.99',
      ttl: 60,
    });
  });
});
