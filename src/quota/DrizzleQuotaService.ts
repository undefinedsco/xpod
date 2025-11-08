import { getIdentityDatabase } from '../identity/drizzle/db';
import { AccountRepository } from '../identity/drizzle/AccountRepository';
import { UsageRepository } from '../storage/quota/UsageRepository';
import type { QuotaService } from './QuotaService';

interface DrizzleQuotaServiceOptions {
  identityDbUrl: string;
  defaultAccountQuotaBytes?: number;
}

export class DrizzleQuotaService implements QuotaService {
  private readonly accountRepo: AccountRepository;
  private readonly usageRepo: UsageRepository;
  private readonly defaultQuota: number;

  public constructor(options: DrizzleQuotaServiceOptions) {
    const db = getIdentityDatabase(options.identityDbUrl);
    this.accountRepo = new AccountRepository(db);
    this.usageRepo = new UsageRepository(db);
    this.defaultQuota = options.defaultAccountQuotaBytes ?? 10 * 1024 * 1024 * 1024;
  }

  public async getAccountLimit(accountId: string): Promise<number | null | undefined> {
    const usage = await this.usageRepo.getAccountUsage(accountId);
    if (usage && usage.storageLimitBytes !== undefined) {
      return usage.storageLimitBytes;
    }
    return this.defaultQuota;
  }

  public async getPodLimit(podId: string): Promise<number | null | undefined> {
    const usage = await this.usageRepo.getPodUsage(podId);
    return usage?.storageLimitBytes;
  }

  public async setAccountLimit(accountId: string, limit: number | null): Promise<void> {
    await this.usageRepo.setAccountStorageLimit(accountId, limit);
  }

  public async setPodLimit(podId: string, limit: number | null): Promise<void> {
    const podInfo = await this.accountRepo.getPodInfo(podId);
    if (!podInfo?.accountId) {
      throw new Error(`无法更新 Pod ${podId} 的配额：未找到关联账号。`);
    }
    await this.usageRepo.setPodStorageLimit(podId, podInfo.accountId, limit);
  }
}
