import { Session } from '@inrupt/solid-client-authn-node';
import { drizzle, eq } from 'drizzle-solid';
import { getLoggerFor } from 'global-logger-factory';
import { modelProviderTable } from '../models/model-provider.schema';
import type { ClientCredentialsStore } from '../auth/ClientCredentialsAuthenticator';
import { isSolidAuth, type AuthContext } from '../auth/AuthContext';

export interface InternalPodServiceOptions {
  tokenEndpoint: string;
  apiKeyStore: ClientCredentialsStore;
}

/**
 * Service for accessing user Pod data from the backend.
 * Dynamically logs in using the caller's API Key (Client Credentials).
 */
export class InternalPodService {
  private readonly logger = getLoggerFor(this);

  public constructor(private readonly options: InternalPodServiceOptions) {}

  /**
   * Retrieves AI model provider configuration from a user's Pod
   */
  public async getAiConfig(webId: string, auth: AuthContext): Promise<any> {
    let fetcher: typeof fetch;

    if (isSolidAuth(auth) && auth.clientId) {
      // API Key Mode: The caller provided a Client ID.
      // We look up the secret and create a session for THIS client.
      this.logger.debug(`Resolving session for client ${auth.clientId} to access ${webId}`);
      
      const creds = await this.options.apiKeyStore.findByClientId(auth.clientId);
      if (!creds) {
        this.logger.warn(`No credentials found for client ${auth.clientId}`);
        return undefined;
      }

      // Create a fresh session for this request/client
      // TODO: Consider caching sessions to avoid login round-trip on every request
      const session = new Session();
      try {
        await session.login({
          oidcIssuer: new URL(this.options.tokenEndpoint).origin,
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
        });
        
        if (!session.info.isLoggedIn) {
          throw new Error('Login returned false');
        }
        fetcher = session.fetch;
      } catch (error) {
        this.logger.error(`Failed to login as client ${auth.clientId}: ${error}`);
        return undefined;
      }
    } else {
      // Solid Token Mode: We cannot reuse the DPoP token for a different URL.
      // For now, we return undefined, falling back to system defaults.
      this.logger.debug('Solid Token auth detected; skipping Pod config fetch (DPoP limitation).');
      return undefined;
    }

    // Use drizzle-solid with our authenticated session
    const db = drizzle({ fetch: fetcher, info: { webId, isLoggedIn: true } } as any);

    try {
      const providers = await db.select()
        .from(modelProviderTable)
        .where(eq((modelProviderTable as any).enabled, true)); // Cast to any to bypass TS error

      console.log(`[InternalPodService] Found ${providers.length} enabled providers:`, providers.map(p => ({ id: p.id, proxy: p.proxy, baseUrl: p.baseUrl })));

      if (providers.length === 0) {
        return undefined;
      }

      // Prefer provider with proxy configured (for external APIs like Google)
      const withProxy = providers.find(p => p.proxy);
      if (withProxy) {
        console.log(`[InternalPodService] Using provider with proxy: ${withProxy.id}`);
        return withProxy;
      }

      return providers[0];
    } catch (error) {
      this.logger.warn(`Failed to read AI config from Pod for ${webId}: ${error}`);
      return undefined;
    }
  }
}
