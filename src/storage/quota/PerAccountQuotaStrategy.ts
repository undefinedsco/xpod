import {
  QuotaStrategy,
  UNIT_BYTES,
} from '@solid/community-server';
import type {
  ResourceIdentifier,
  SizeReporter,
  Size,
} from '@solid/community-server';
import type { QuotaService } from '../../quota/QuotaService';
import { getIdentityDatabase } from '../../identity/drizzle/db';
import { PodLookupRepository } from '../../identity/drizzle/PodLookupRepository';
import { UsageRepository } from './UsageRepository';

interface PerAccountQuotaStrategyOptions {
  identityDbUrl?: string;
  defaultAccountQuotaBytes: number;
  quotaService: QuotaService;
}

export class PerAccountQuotaStrategy extends QuotaStrategy {
  private readonly quotaService: QuotaService;
  private readonly usageRepo?: UsageRepository;
  private readonly podLookup?: PodLookupRepository;
  private readonly defaultQuota: number;

  public constructor(reporter: SizeReporter<unknown>, options: PerAccountQuotaStrategyOptions) {
    super(reporter, { amount: options.defaultAccountQuotaBytes, unit: UNIT_BYTES });
    this.defaultQuota = options.defaultAccountQuotaBytes;
    if (options.identityDbUrl) {
      const db = getIdentityDatabase(options.identityDbUrl);
      this.usageRepo = new UsageRepository(db);
      this.podLookup = new PodLookupRepository(db);
    }
    this.quotaService = options.quotaService;
  }

  public override async getAvailableSpace(identifier: ResourceIdentifier): Promise<Size> {
    const context = await this.resolveContext(identifier);
    if (!context) {
      return { amount: Number.MAX_SAFE_INTEGER, unit: UNIT_BYTES };
    }

    const { accountId } = context;
    const currentResource = (await this.reporter.getSize(identifier)).amount;
    if (!this.usageRepo) {
      return { amount: Number.MAX_SAFE_INTEGER, unit: UNIT_BYTES };
    }

    const limit = await this.quotaService.getAccountLimit(accountId);
    const accountLimit = (limit ?? this.defaultQuota);
    if (!Number.isFinite(accountLimit)) {
      return { amount: Number.MAX_SAFE_INTEGER, unit: UNIT_BYTES };
    }
    const accountRecord = await this.usageRepo.getAccountUsage(accountId);
    const totalUsed = accountRecord?.storageBytes ?? 0;
    const available = accountLimit - Math.max(0, totalUsed - currentResource);
    return { amount: available, unit: UNIT_BYTES };
  }

  protected override async getTotalSpaceUsed(identifier: ResourceIdentifier): Promise<Size> {
    const context = await this.resolveContext(identifier);
    if (!context) {
      return { amount: Number.MAX_SAFE_INTEGER, unit: UNIT_BYTES };
    }
    if (!this.usageRepo) {
      return { amount: Number.MAX_SAFE_INTEGER, unit: UNIT_BYTES };
    }
    const accountRecord = await this.usageRepo.getAccountUsage(context.accountId);
    const used = accountRecord?.storageBytes ?? 0;
    return { amount: used, unit: UNIT_BYTES };
  }

  private async resolveContext(identifier: ResourceIdentifier): Promise<{ accountId: string; podId: string } | undefined> {
    if (!this.podLookup) {
      return undefined;
    }
    const pod = await this.podLookup.findByResourceIdentifier(identifier.path);
    if (!pod) {
      return undefined;
    }
    return { accountId: pod.accountId, podId: pod.podId };
  }
}
