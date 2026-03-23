/**
 * Load AI provider configuration from the user's Solid Pod.
 *
 * Uses drizzle-solid to query Credential + Provider tables,
 * following the same protocol as API/ChatKit.
 */

import { drizzle } from '@undefineds.co/drizzle-solid';
import { ApiKeyCredential, OAuthCredential } from '../../credential/schema/tables';
import { Provider } from '../../ai/schema/provider';
import { Model } from '../../ai/schema/model';
import { ServiceType, CredentialStatus } from '../../credential/schema/types';
import type { Session } from '@inrupt/solid-client-authn-node';
import { ensureOAuthTokenValid } from './oauth-credential-manager';

export interface PodAiConfig {
  provider: string;      // provider id, e.g. 'openrouter'
  modelId: string;       // e.g. 'claude-sonnet-4-20250514'
  apiKey: string;
  baseUrl?: string;
  proxyUrl?: string;
  credentialId?: string;
  authType?: 'api-key' | 'oauth';  // 认证类型
}

/**
 * Fetch AI configuration from the user's Pod.
 *
 * Queries ApiKeyCredential + OAuthCredential + Provider tables using drizzle-solid.
 * Credential.provider (uri) references Provider's subject URI.
 * Returns the first active AI credential with a matching provider.
 *
 * Priority: ApiKeyCredential > OAuthCredential (API Key 优先)
 */
export async function loadPodAiConfig(session: Session): Promise<PodAiConfig | null> {
  try {
    const db: any = drizzle({
      fetch: session.fetch,
      info: session.info,
    } as any);

    // Workaround: drizzle-solid places FILTER inside OPTIONAL blocks,
    // causing eq() on string columns to return 0 results.
    // Fetch all and filter in JS. See docs/cli-dev-testing.md#known-issues.

    // 1. 尝试读取 API Key credentials
    const allApiKeyCredentials = await db.select().from(ApiKeyCredential) as any[];
    const apiKeyCredentials = allApiKeyCredentials.filter((c: any) =>
      c.service === ServiceType.AI && c.status === CredentialStatus.ACTIVE,
    );

    // 2. 尝试读取 OAuth credentials
    const allOAuthCredentials = await db.select().from(OAuthCredential) as any[];
    const oauthCredentials = allOAuthCredentials.filter((c: any) =>
      c.service === ServiceType.AI && c.status === CredentialStatus.ACTIVE,
    );

    // 3. 合并所有凭据，API Key 优先
    const allCredentials = [...apiKeyCredentials, ...oauthCredentials];

    if (allCredentials.length === 0) {
      return null;
    }

    // Build provider lookup by subject URI (@id)
    const allProviders = await db.select().from(Provider) as any[];
    const providerByUri = new Map(allProviders.map(p => [p['@id'], p]));

    // Match: cred.provider (uri) === provider['@id'] (subject URI)
    for (let cred of allCredentials) {
      if (!cred.provider) continue;

      const provider = providerByUri.get(cred.provider);
      if (!provider) continue;

      const baseUrl = provider.baseUrl;
      if (!baseUrl) continue;

      // 判断凭据类型
      const isApiKey = 'apiKey' in cred && cred.apiKey;
      const isOAuth = 'oauthAccessToken' in cred && cred.oauthAccessToken;

      if (!isApiKey && !isOAuth) continue;

      // OAuth token 需要检查过期并自动刷新
      if (isOAuth) {
        const providerId = provider.id as string;
        const tokenValid = await ensureOAuthTokenValid(session, cred.id, providerId);
        if (!tokenValid) {
          console.warn(`OAuth token invalid for credential ${cred.id}, skipping`);
          continue;
        }

        // 重新读取 credential（可能已刷新）
        const refreshedCreds = await db.select().from(OAuthCredential) as any[];
        const refreshedCred = refreshedCreds.find((c: any) => c.id === cred.id);
        if (refreshedCred) {
          cred = refreshedCred as any;
        }
      }

      const defaultModelRef = provider.defaultModel ?? provider.hasModel;
      const defaultModel = defaultModelRef
        ? (await db.findByIri(Model, defaultModelRef))?.id ?? ''
        : '';

      return {
        provider: provider.id as string,
        modelId: defaultModel,
        apiKey: isApiKey ? (cred as any).apiKey : (cred as any).oauthAccessToken,
        baseUrl,
        proxyUrl: provider.proxyUrl || undefined,
        credentialId: cred.id,
        authType: isApiKey ? 'api-key' : 'oauth',
      };
    }

    return null;
  } catch (error) {
    console.error('Failed to load AI config from Pod:', error);
    return null;
  }
}
