import { IdentityProviderFactory, type IdentityProviderFactoryArgs } from '@solid/community-server';
import type { Configuration } from 'oidc-provider';
import { XPOD_DESKTOP_CLIENT_ID } from './RememberedClientGrantStore';

/** Retain the IdP session boundary while allowing Desktop to renew online access. */
export class SessionBoundIdentityProviderFactory extends IdentityProviderFactory {
  /**
   * @param config - JSON config for the OIDC library @range {json}
   * @param args - Remaining parameters required for the factory.
   */
  public constructor(config: Configuration, args: IdentityProviderFactoryArgs) {
    super({
      ...config,
      issueRefreshToken: config.issueRefreshToken ?? (async (_ctx, client, code) =>
        client.grantTypeAllowed('refresh_token') && (
          code.scopes.has('offline_access') ||
          (client.clientId === XPOD_DESKTOP_CLIENT_ID && 'expiresWithSession' in code && code.expiresWithSession === true)
        )),
    }, args);
  }
}
