import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntitlementProvider } from '../../src/quota/EntitlementProvider';
import { DrizzleQuotaService } from '../../src/quota/DrizzleQuotaService';

const usageRepoInstances: Array<{
  getAccountUsage: ReturnType<typeof vi.fn>;
  getPodUsage: ReturnType<typeof vi.fn>;
  setAccountStorageLimit: ReturnType<typeof vi.fn>;
  setAccountBandwidthLimit: ReturnType<typeof vi.fn>;
  setAccountComputeLimit: ReturnType<typeof vi.fn>;
  setAccountTokenLimit: ReturnType<typeof vi.fn>;
  setPodStorageLimit: ReturnType<typeof vi.fn>;
  setPodBandwidthLimit: ReturnType<typeof vi.fn>;
  setPodComputeLimit: ReturnType<typeof vi.fn>;
  setPodTokenLimit: ReturnType<typeof vi.fn>;
}> = [];

const accountRepoInstances: Array<{
  getPodInfo: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('../../src/identity/drizzle/db', () => ({
  getIdentityDatabase: vi.fn(() => ({})),
}));

vi.mock('../../src/storage/quota/UsageRepository', () => ({
  UsageRepository: vi.fn().mockImplementation(() => {
    const instance = {
      getAccountUsage: vi.fn(),
      getPodUsage: vi.fn(),
      setAccountStorageLimit: vi.fn(),
      setAccountBandwidthLimit: vi.fn(),
      setAccountComputeLimit: vi.fn(),
      setAccountTokenLimit: vi.fn(),
      setPodStorageLimit: vi.fn(),
      setPodBandwidthLimit: vi.fn(),
      setPodComputeLimit: vi.fn(),
      setPodTokenLimit: vi.fn(),
    };
    usageRepoInstances.push(instance);
    return instance;
  }),
}));

vi.mock('../../src/identity/drizzle/AccountRepository', () => ({
  AccountRepository: vi.fn().mockImplementation(() => {
    const instance = {
      getPodInfo: vi.fn(),
    };
    accountRepoInstances.push(instance);
    return instance;
  }),
}));

function last<T>(list: T[]): T {
  if (list.length === 0) {
    throw new Error('依赖未初始化');
  }
  return list[list.length - 1];
}

function createEntitlementProvider(): EntitlementProvider & {
  getAccountEntitlement: ReturnType<typeof vi.fn>;
} {
  return {
    getAccountEntitlement: vi.fn(),
  };
}

describe('DrizzleQuotaService', () => {
  beforeEach(() => {
    usageRepoInstances.splice(0, usageRepoInstances.length);
    accountRepoInstances.splice(0, accountRepoInstances.length);
    delete process.env.XPOD_DEFAULT_STORAGE_LIMIT_BYTES;
    delete process.env.XPOD_DEFAULT_BANDWIDTH_LIMIT_BPS;
    delete process.env.XPOD_DEFAULT_COMPUTE_LIMIT_SECONDS;
    delete process.env.XPOD_DEFAULT_TOKEN_LIMIT_MONTHLY;
  });

  it('账户未配置本地配额时回退到 entitlement', async () => {
    process.env.XPOD_DEFAULT_STORAGE_LIMIT_BYTES = '100';
    const entitlementProvider = createEntitlementProvider();
    const service = new DrizzleQuotaService({
      identityDbUrl: 'postgres://localhost/test',
      entitlementProvider,
    });
    const usageRepo = last(usageRepoInstances);

    usageRepo.getAccountUsage.mockResolvedValueOnce(undefined);
    entitlementProvider.getAccountEntitlement.mockResolvedValueOnce({
      accountId: 'acc-1',
      quota: {
        storageLimitBytes: 2048,
        bandwidthLimitBps: 4096,
      },
    });

    const quota = await service.getAccountQuota('acc-1');
    expect(quota.storageLimitBytes).toBe(2048);
    expect(quota.bandwidthLimitBps).toBe(4096);
    expect(quota.computeLimitSeconds).toBeNull();
    expect(quota.tokenLimitMonthly).toBeNull();
  });

  it('本地账户配额覆盖 entitlement，同步保留缺失字段的远端值', async () => {
    const entitlementProvider = createEntitlementProvider();
    const service = new DrizzleQuotaService({
      identityDbUrl: 'postgres://localhost/test',
      entitlementProvider,
    });
    const usageRepo = last(usageRepoInstances);

    usageRepo.getAccountUsage.mockResolvedValueOnce({
      accountId: 'acc-2',
      storageBytes: 0,
      ingressBytes: 0,
      egressBytes: 0,
      storageLimitBytes: 512,
      bandwidthLimitBps: null,
      computeSeconds: 0,
      tokensUsed: 0,
      computeLimitSeconds: 60,
      tokenLimitMonthly: null,
    });
    entitlementProvider.getAccountEntitlement.mockResolvedValueOnce({
      accountId: 'acc-2',
      quota: {
        storageLimitBytes: 2048,
        bandwidthLimitBps: 8192,
        computeLimitSeconds: 600,
        tokenLimitMonthly: 99_999,
      },
    });

    const quota = await service.getAccountQuota('acc-2');
    expect(quota).toEqual({
      storageLimitBytes: 512,
      bandwidthLimitBps: 8192,
      computeLimitSeconds: 60,
      tokenLimitMonthly: 99_999,
    });
  });

  it('本地四类配额都已设置时不再拉远端 entitlement', async () => {
    const entitlementProvider = createEntitlementProvider();
    const service = new DrizzleQuotaService({
      identityDbUrl: 'postgres://localhost/test',
      entitlementProvider,
    });
    const usageRepo = last(usageRepoInstances);

    usageRepo.getAccountUsage.mockResolvedValueOnce({
      accountId: 'acc-3',
      storageBytes: 0,
      ingressBytes: 0,
      egressBytes: 0,
      storageLimitBytes: 1,
      bandwidthLimitBps: 2,
      computeSeconds: 0,
      tokensUsed: 0,
      computeLimitSeconds: 3,
      tokenLimitMonthly: 4,
    });

    const quota = await service.getAccountQuota('acc-3');
    expect(quota).toEqual({
      storageLimitBytes: 1,
      bandwidthLimitBps: 2,
      computeLimitSeconds: 3,
      tokenLimitMonthly: 4,
    });
    expect(entitlementProvider.getAccountEntitlement).not.toHaveBeenCalled();
  });
});

