export interface QuotaService {
  getAccountLimit(accountId: string): Promise<number | null | undefined>;

  getPodLimit(podId: string): Promise<number | null | undefined>;

  setAccountLimit(accountId: string, limit: number | null): Promise<void>;

  setPodLimit(podId: string, limit: number | null): Promise<void>;
}
