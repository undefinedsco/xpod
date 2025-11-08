import { BaseLoginAccountStorage } from '@solid/community-server';
import { DrizzleIndexedStorage } from './DrizzleIndexedStorage';

export interface DrizzleAccountLoginStorageOptions {
  identityDbUrl: string;
  tablePrefix?: string;
  expirationSeconds?: number;
}

export class DrizzleAccountLoginStorage extends BaseLoginAccountStorage<any> {
  public constructor(options: DrizzleAccountLoginStorageOptions) {
    const storage = new DrizzleIndexedStorage<any>(
      options.identityDbUrl,
      options.tablePrefix ?? 'identity_',
    );
    super(storage, options.expirationSeconds);
  }
}
