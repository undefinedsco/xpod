import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ResourceIdentifier } from '@solid/community-server/dist/http/representation/ResourceIdentifier';
import type { SizeReporter } from '@solid/community-server/dist/storage/size-reporter/SizeReporter';
import { UNIT_BYTES } from '@solid/community-server/dist/storage/size-reporter/Size';
import type { QuotaService } from '../../../src/quota/QuotaService';
import { PerAccountQuotaStrategy } from '../../../src/storage/quota/PerAccountQuotaStrategy';

const usageRepoInstances: Array<{
  getAccountUsage: ReturnType<typeof vi.fn>;
}> = [];
const podLookupInstances: Array<{ findByResourceIdentifier: ReturnType<typeof vi.fn> }> = [];
const quotaServiceInstances: Array<QuotaService & {
  getAccountLimit: ReturnType<typeof vi.fn>;
  getPodLimit: ReturnType<typeof vi.fn>;
  setAccountLimit: ReturnType<typeof vi.fn>;
  setPodLimit: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('../../../src/storage/quota/UsageRepository', () => ({
  UsageRepository: vi.fn().mockImplementation(() => {
    const instance = {
      getAccountUsage: vi.fn(),
    };
    usageRepoInstances.push(instance);
    return instance;
  }),
}));

vi.mock('../../../src/identity/drizzle/PodLookupRepository', () => ({
  PodLookupRepository: vi.fn().mockImplementation(() => {
    const instance = {
      findByResourceIdentifier: vi.fn(),
    };
    podLookupInstances.push(instance);
    return instance;
  }),
}));

vi.mock('../../../src/identity/drizzle/db', () => ({
  getIdentityDatabase: vi.fn(() => ({})),
}));

function last<T>(arr: T[]): T {
  if (arr.length === 0) {
    throw new Error('依赖未初始化');
  }
  return arr[arr.length - 1];
}

function createQuotaService(): QuotaService & {
  getAccountLimit: ReturnType<typeof vi.fn>;
  getPodLimit: ReturnType<typeof vi.fn>;
  setAccountLimit: ReturnType<typeof vi.fn>;
  setPodLimit: ReturnType<typeof vi.fn>;
} {
  const service = {
    getAccountLimit: vi.fn(),
    getPodLimit: vi.fn(),
    setAccountLimit: vi.fn(),
    setPodLimit: vi.fn(),
  } as unknown as QuotaService & {
    getAccountLimit: ReturnType<typeof vi.fn>;
    getPodLimit: ReturnType<typeof vi.fn>;
    setAccountLimit: ReturnType<typeof vi.fn>;
    setPodLimit: ReturnType<typeof vi.fn>;
  };
  quotaServiceInstances.push(service);
  return service;
}

function createStrategy(defaultQuota = 1_000) {
  const reporter = {
    getSize: vi.fn(async () => ({ amount: 0, unit: UNIT_BYTES })),
  } as unknown as SizeReporter<unknown> & { getSize: ReturnType<typeof vi.fn> };
  const quotaService = createQuotaService();
  const strategy = new PerAccountQuotaStrategy(reporter, {
    identityDbUrl: 'postgres://localhost/test',
    defaultAccountQuotaBytes: defaultQuota,
    quotaService,
  });
  return {
    strategy,
    reporter,
    quotaService,
    usageRepo: last(usageRepoInstances),
    podLookup: last(podLookupInstances),
  };
}

describe('PerAccountQuotaStrategy', () => {
  beforeEach(() => {
    usageRepoInstances.splice(0, usageRepoInstances.length);
    podLookupInstances.splice(0, podLookupInstances.length);
    quotaServiceInstances.splice(0, quotaServiceInstances.length);
  });

  it('找不到 Pod 时返回无限可用空间', async () => {
    const { strategy, podLookup, reporter } = createStrategy();
    const identifier = { path: 'https://pods.example.com/alice/profile/card' } as ResourceIdentifier;
    podLookup.findByResourceIdentifier.mockResolvedValueOnce(undefined);
    reporter.getSize.mockResolvedValueOnce({ amount: 100, unit: UNIT_BYTES });

    const result = await strategy.getAvailableSpace(identifier);
    expect(result.amount).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('根据账户配额与已用空间计算剩余容量', async () => {
    const { strategy, podLookup, usageRepo, reporter, quotaService } = createStrategy();
    const identifier = { path: 'https://pods.example.com/alice/private/data.ttl' } as ResourceIdentifier;
    podLookup.findByResourceIdentifier.mockResolvedValueOnce({ accountId: 'acc-1', podId: 'pod-1', baseUrl: 'https://pods.example.com/alice/' });
    quotaService.getAccountLimit.mockResolvedValueOnce(2_000);
    reporter.getSize.mockResolvedValueOnce({ amount: 150, unit: UNIT_BYTES });
    usageRepo.getAccountUsage.mockResolvedValueOnce({
      accountId: 'acc-1',
      storageBytes: 800,
      ingressBytes: 0,
      egressBytes: 0,
    });

    const result = await strategy.getAvailableSpace(identifier);
    expect(quotaService.getAccountLimit).toHaveBeenCalledWith('acc-1');
    expect(usageRepo.getAccountUsage).toHaveBeenCalledWith('acc-1');
    expect(result.amount).toBe(1_350);
  });

  it('配额未设置时回退到默认值', async () => {
    const { strategy, podLookup, usageRepo, reporter, quotaService } = createStrategy(1_500);
    const identifier = { path: 'https://pods.example.com/carl/' } as ResourceIdentifier;
    podLookup.findByResourceIdentifier.mockResolvedValueOnce({ accountId: 'acc-2', podId: 'pod-2', baseUrl: 'https://pods.example.com/carl/' });
    quotaService.getAccountLimit.mockResolvedValueOnce(undefined);
    reporter.getSize.mockResolvedValueOnce({ amount: 50, unit: UNIT_BYTES });
    usageRepo.getAccountUsage.mockResolvedValueOnce({
      accountId: 'acc-2',
      storageBytes: 500,
      ingressBytes: 0,
      egressBytes: 0,
    });

    const result = await strategy.getAvailableSpace(identifier);
    expect(result.amount).toBe(1_050);
  });

  it('无 usageRepo 时返回无限配额', async () => {
    const reporter = {
      getSize: vi.fn(async () => ({ amount: 10, unit: UNIT_BYTES })),
    } as unknown as SizeReporter<unknown> & { getSize: ReturnType<typeof vi.fn> };
    const quotaService = createQuotaService();
    const strategy = new PerAccountQuotaStrategy(reporter, {
      identityDbUrl: undefined,
      defaultAccountQuotaBytes: 500,
      quotaService,
    });
    const identifier = { path: 'https://pods.example.com/delta/resource' } as ResourceIdentifier;

    const result = await strategy.getAvailableSpace(identifier);
    expect(result.amount).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('未找到 Pod 时总使用量返回无限', async () => {
    const { strategy, podLookup, reporter } = createStrategy();
    const identifier = { path: 'https://pods.example.com/ghost/' } as ResourceIdentifier;
    podLookup.findByResourceIdentifier.mockResolvedValueOnce(undefined);
    reporter.getSize.mockResolvedValueOnce({ amount: 10, unit: UNIT_BYTES });

    const result = await strategy.getTotalSpaceUsed(identifier);
    expect(result.amount).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('总使用量取自账户记录', async () => {
    const { strategy, podLookup, usageRepo, reporter } = createStrategy();
    const identifier = { path: 'https://pods.example.com/dora/data/' } as ResourceIdentifier;
    podLookup.findByResourceIdentifier.mockResolvedValueOnce({ accountId: 'acc-4', podId: 'pod-4', baseUrl: 'https://pods.example.com/dora/' });
    usageRepo.getAccountUsage.mockResolvedValueOnce({
      accountId: 'acc-4',
      storageBytes: 720,
      ingressBytes: 0,
      egressBytes: 0,
    });
    reporter.getSize.mockResolvedValueOnce({ amount: 0, unit: UNIT_BYTES });

    const result = await strategy.getTotalSpaceUsed(identifier);
    expect(usageRepo.getAccountUsage).toHaveBeenCalledWith('acc-4');
    expect(result.amount).toBe(720);
  });
});
