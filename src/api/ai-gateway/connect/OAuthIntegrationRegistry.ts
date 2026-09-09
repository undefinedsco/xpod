export interface OAuthIntegration {
  provider: 'kimi';
  integrationId: typeof XPOD_KIMI_OAUTH_INTEGRATION_ID;
  issuedBy: 'xpod';
  clientId: string;
}

export interface OAuthIntegrationRegistryConfig {
  kimi?: {
    integrationId?: string;
    issuedBy?: string;
    clientId?: string;
  };
}

export const XPOD_KIMI_OAUTH_INTEGRATION_ID = 'xpod-kimi-oauth';

export class OAuthIntegrationRegistry {
  private readonly integrations = new Map<string, OAuthIntegration>();

  public static fromServerConfig(config: OAuthIntegrationRegistryConfig): OAuthIntegrationRegistry {
    const registry = new OAuthIntegrationRegistry();
    const kimi = config.kimi;
    const kimiClientId = requireKimiOAuthClientId(kimi);
    registry.register({
      provider: 'kimi',
      integrationId: XPOD_KIMI_OAUTH_INTEGRATION_ID,
      issuedBy: 'xpod',
      clientId: kimiClientId,
    });
    return registry;
  }

  public register(integration: OAuthIntegration): void {
    this.integrations.set(integration.provider, integration);
  }

  public require(provider: string): OAuthIntegration {
    const integration = this.integrations.get(provider.toLowerCase());
    if (!integration) {
      throw new Error('auth_not_available');
    }
    return integration;
  }
}

export function requireKimiOAuthClientId(value: OAuthIntegrationRegistryConfig['kimi'] | OAuthIntegration | undefined): string {
  const clientId = normalizeClientId(value?.clientId);
  if (
    !clientId
    || value?.integrationId !== XPOD_KIMI_OAUTH_INTEGRATION_ID
    || value?.issuedBy !== 'xpod'
  ) {
    throw new Error('auth_not_available');
  }
  return clientId;
}

function normalizeClientId(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
