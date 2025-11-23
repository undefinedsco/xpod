import { DrizzleAccountLoginStorage } from './DrizzleAccountLoginStorage';

export interface DrizzleAccountStorageOptions {
  identityDbUrl: string;
  tablePrefix?: string;
  expirationSeconds?: number;
}

/**
 * Account storage backed by PostgreSQL via Drizzle.
 * Alias of {@link DrizzleAccountLoginStorage} for Components.js wiring convenience.
 */
export class DrizzleAccountStorage extends DrizzleAccountLoginStorage {
  public constructor(options: DrizzleAccountStorageOptions) {
    super({
      identityDbUrl: options.identityDbUrl,
      tablePrefix: options.tablePrefix,
      expirationSeconds: options.expirationSeconds,
    });
  }
}
