import type { IdentityDatabase } from './db';
import { PodLookupRepository } from './PodLookupRepository';

/**
 * Reads account/pod ownership data from the CSS identity facts.
 * Quota values live in identity_usage and are managed by UsageRepository.
 */
export class AccountRepository {
  private readonly podLookupRepo: PodLookupRepository;

  public constructor(
    db: IdentityDatabase,
    kvTableName?: string,
  ) {
    this.podLookupRepo = new PodLookupRepository(db, kvTableName);
  }

  public async getPodInfo(podId: string): Promise<{ accountId: string; baseUrl?: string } | undefined> {
    const pod = await this.podLookupRepo.findById(podId)
      ?? await this.podLookupRepo.findByResourceIdentifier(podId);
    if (!pod) {
      return undefined;
    }
    return {
      accountId: pod.accountId,
      baseUrl: pod.baseUrl,
    };
  }
}
