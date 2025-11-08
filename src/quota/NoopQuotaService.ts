import type { QuotaService } from './QuotaService';

export class NoopQuotaService implements QuotaService {
  public async getAccountLimit(): Promise<number | null | undefined> {
    return Number.POSITIVE_INFINITY;
  }

  public async getPodLimit(): Promise<number | null | undefined> {
    return null;
  }

  public async setAccountLimit(): Promise<void> {}

  public async setPodLimit(): Promise<void> {}
}
