import { Session } from '@inrupt/solid-client-authn-node';
import { drizzle, eq, and } from 'drizzle-solid';
import { getLoggerFor } from 'global-logger-factory';
import type { ClientCredentialsStore } from '../auth/ClientCredentialsAuthenticator';
import { isSolidAuth, type AuthContext } from '../auth/AuthContext';

// 使用新的 schema
import { Credential } from '../../credential/schema/tables';
import { Provider, Model } from '../../embedding/schema/tables';
import { ServiceType, CredentialStatus } from '../../credential/schema/types';

const schema = {
  credential: Credential,
  provider: Provider,
  model: Model,
};

export interface InternalPodServiceOptions {
  tokenEndpoint: string;
  apiKeyStore: ClientCredentialsStore;
}

/**
 * AI 配置结果
 */
export interface AiConfig {
  providerId: string;
  apiKey: string;
  baseUrl?: string;
  proxyUrl?: string;
}

/**
 * Model 信息
 */
export interface ModelInfo {
  id: string;
  displayName?: string;
  modelType?: string;
  dimension?: number;
  status?: string;
  providerId?: string;
}

/**
 * Service for accessing user Pod data from the backend.
 * Dynamically logs in using the caller's API Key (Client Credentials).
 * 
 * Uses the new schema:
 * - providerTable: /settings/ai/providers.ttl
 * - modelTable: /settings/ai/models.ttl
 * - credentialTable: /settings/credentials.ttl
 */
export class InternalPodService {
  private readonly logger = getLoggerFor(this);

  public constructor(private readonly options: InternalPodServiceOptions) {}

  /**
   * Get authenticated fetcher for a user
   */
  private async getAuthenticatedFetcher(auth: AuthContext): Promise<{ fetcher: typeof fetch; webId: string } | null> {
    if (isSolidAuth(auth) && auth.clientId) {
      // API Key Mode: The caller provided a Client ID.
      this.logger.debug(`Resolving session for client ${auth.clientId}`);
      
      const creds = await this.options.apiKeyStore.findByClientId(auth.clientId);
      if (!creds) {
        this.logger.warn(`No credentials found for client ${auth.clientId}`);
        return null;
      }

      const session = new Session();
      try {
        await session.login({
          oidcIssuer: new URL(this.options.tokenEndpoint).origin,
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
        });
        
        if (!session.info.isLoggedIn || !session.info.webId) {
          throw new Error('Login returned false or no webId');
        }
        return { fetcher: session.fetch, webId: session.info.webId };
      } catch (error) {
        this.logger.error(`Failed to login as client ${auth.clientId}: ${error}`);
        return null;
      }
    } else {
      // Solid Token Mode: We cannot reuse the DPoP token for a different URL.
      this.logger.debug('Solid Token auth detected; skipping Pod config fetch (DPoP limitation).');
      return null;
    }
  }

  /**
   * Get drizzle database instance for Pod access
   */
  private async getPodDb(auth: AuthContext) {
    const authResult = await this.getAuthenticatedFetcher(auth);
    if (!authResult) {
      return null;
    }

    const { fetcher, webId } = authResult;
    return drizzle({ fetch: fetcher, info: { webId, isLoggedIn: true } } as any, { schema });
  }

  /**
   * Retrieves AI configuration from a user's Pod using new schema
   * Reads from /settings/credentials.ttl and /settings/ai/providers.ttl
   */
  public async getAiConfig(webId: string, auth: AuthContext): Promise<AiConfig | undefined> {
    const db = await this.getPodDb(auth);
    if (!db) {
      return undefined;
    }

    try {
      // 获取 Pod 的 base URL
      const podBaseUrl = this.getPodBaseUrl(webId);

      // 查询所有 active 的 AI credentials
      const credentials = await db.query.credential.findMany({
        where: and(
          eq(Credential.service, ServiceType.AI),
          eq(Credential.status, CredentialStatus.ACTIVE),
        ),
      });

      this.logger.debug(`Found ${credentials.length} active AI credentials for ${webId}`);

      if (credentials.length === 0) {
        return undefined;
      }

      // 获取所有 providers
      const providers = await db.select().from(Provider);
      this.logger.debug(`Found ${providers.length} providers: ${JSON.stringify(providers.map(p => ({ id: p.id, baseUrl: p.baseUrl })))}`);
      
      // 创建多种格式的 provider map，支持相对和绝对 URL
      const providerMap = new Map<string, typeof providers[0]>();
      for (const p of providers) {
        // 绝对 URL 格式
        const absoluteUrl = `${podBaseUrl}settings/ai/providers.ttl#${p.id}`;
        providerMap.set(absoluteUrl, p);
        // 相对 URL 格式（从 settings/ 开始）
        providerMap.set(`ai/providers.ttl#${p.id}`, p);
        // 仅 fragment 格式
        providerMap.set(`#${p.id}`, p);
        // 仅 id
        providerMap.set(p.id, p);
      }

      // 选择一个 credential（优先选择有 provider 配置的）
      let selectedCredential = credentials[0];
      let selectedProvider: typeof providers[0] | undefined;

      for (const cred of credentials) {
        this.logger.debug(`Checking credential ${cred.id}, provider ref: ${cred.provider}`);
        if (cred.provider) {
          const provider = providerMap.get(cred.provider);
          if (provider) {
            selectedCredential = cred;
            selectedProvider = provider;
            this.logger.debug(`Matched provider: ${provider.id}`);
            break;
          }
        }
      }

      this.logger.info(`Using credential ${selectedCredential.id} for ${webId}, provider: ${selectedProvider?.id || 'none'}, baseUrl: ${selectedProvider?.baseUrl || 'default'}, proxyUrl: ${selectedProvider?.proxyUrl || 'none'}`);

      return {
        providerId: selectedProvider?.id || selectedCredential.id,
        apiKey: selectedCredential.apiKey!,
        baseUrl: selectedCredential.baseUrl || selectedProvider?.baseUrl || undefined,
        proxyUrl: selectedProvider?.proxyUrl || undefined,
      };
    } catch (error) {
      this.logger.warn(`Failed to read AI config from Pod for ${webId}: ${error}`);
      return undefined;
    }
  }

  /**
   * List all models from user's Pod
   */
  public async listModels(auth: AuthContext): Promise<ModelInfo[]> {
    const db = await this.getPodDb(auth);
    if (!db) {
      return [];
    }

    try {
      const models = await db.select().from(Model);
      return models.map(m => ({
        id: m.id,
        displayName: m.displayName || undefined,
        modelType: m.modelType || undefined,
        dimension: m.dimension || undefined,
        status: m.status || undefined,
        providerId: m.isProvidedBy ? this.extractIdFromUri(m.isProvidedBy) : undefined,
      }));
    } catch (error) {
      this.logger.error(`Failed to list models: ${error}`);
      return [];
    }
  }

  /**
   * Extract Pod base URL from webId
   * e.g., https://pod.example.com/user/profile/card#me -> https://pod.example.com/user/
   * 
   * Standard Solid Pod structure:
   * - Pod root: /user/
   * - Profile: /user/profile/card#me
   * - Settings: /user/settings/
   */
  private getPodBaseUrl(webId: string): string {
    const url = new URL(webId);
    url.hash = '';
    let path = url.pathname;
    
    // Remove standard profile path suffix if present
    // /user/profile/card -> /user/
    if (path.endsWith('/profile/card')) {
      path = path.slice(0, -'/profile/card'.length);
    } else if (path.endsWith('/profile/card/')) {
      path = path.slice(0, -'/profile/card/'.length);
    }
    
    if (!path.endsWith('/')) {
      path = path + '/';
    }
    return `${url.origin}${path}`;
  }

  /**
   * Extract ID from URI
   * e.g., https://pod.example.com/settings/ai/providers.ttl#google -> google
   */
  private extractIdFromUri(uri: string): string {
    const hashIndex = uri.lastIndexOf('#');
    if (hashIndex !== -1) {
      return uri.slice(hashIndex + 1);
    }
    const slashIndex = uri.lastIndexOf('/');
    if (slashIndex !== -1) {
      return uri.slice(slashIndex + 1);
    }
    return uri;
  }
}
