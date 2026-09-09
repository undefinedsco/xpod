import type { ExpiringStorage } from '@solid/community-server';
import type { Grant, Provider } from 'oidc-provider';

export const XPOD_DESKTOP_CLIENT_ID = 'https://id.undefineds.co/app/xpod-desktop-client.json';

export interface RememberedClientGrant {
  accountId: string;
  clientId: string;
  grantId: string;
  expires: number;
}

/** One authoritative account/client record, always validated against the provider's live grant. */
export class RememberedClientGrantStore {
  public constructor(private readonly storage: ExpiringStorage<string, RememberedClientGrant>) {}

  public async remember(grant: Grant): Promise<void> {
    const { accountId, clientId, jti: grantId, exp } = grant;
    if (!accountId || !clientId || !grantId || !exp || exp * 1000 <= Date.now()) {
      return;
    }
    const entry = { accountId, clientId, grantId, expires: exp * 1000 };
    await this.storage.set(this.clientKey(accountId, clientId), entry, new Date(entry.expires));
  }

  public async forget(accountId: string, clientId: string): Promise<void> {
    await this.storage.delete(this.clientKey(accountId, clientId));
  }

  public async find(provider: Provider, accountId: string, clientId: string): Promise<Grant | undefined> {
    const entry = await this.storage.get(this.clientKey(accountId, clientId));
    if (!entry || entry.accountId !== accountId || entry.clientId !== clientId || entry.expires <= Date.now()) {
      return undefined;
    }
    const grant = await provider.Grant.find(entry.grantId);
    if (!grant || grant.accountId !== accountId || grant.clientId !== clientId ||
      !grant.exp || grant.exp * 1000 <= Date.now()) {
      return undefined;
    }
    return grant;
  }

  private clientKey(accountId: string, clientId: string): string {
    return encodeURIComponent(JSON.stringify(['remembered-client', accountId, clientId]));
  }
}
