import type {
  AuthorizationCodeOAuthIntegration,
  AuthorizationCodeProtocolDescriptor,
  DeviceCodeOAuthIntegration,
  DeviceCodeProtocolDescriptor,
  OAuthConnectMode,
  OAuthIntegration,
} from './DeviceCodeProtocol';

export type {
  AuthorizationCodeOAuthIntegration,
  AuthorizationCodeProtocolDescriptor,
  DeviceCodeOAuthIntegration,
  DeviceCodeProtocolDescriptor,
  OAuthConnectMode,
  OAuthIntegration,
} from './DeviceCodeProtocol';

export interface OAuthIntegrationRegistryConfig {
  integrations?: Array<{
    provider: string;
    offeringId: string;
    mode?: OAuthConnectMode;
    integrationId: string;
    issuedBy: string;
    clientId?: string;
    protocol: DeviceCodeProtocolDescriptor | AuthorizationCodeProtocolDescriptor;
    accountLabel?: string;
    accountId?: string;
  }>;
}

export class OAuthIntegrationRegistry {
  private readonly integrations = new Map<string, OAuthIntegration>();

  public static fromServerConfig(config: OAuthIntegrationRegistryConfig): OAuthIntegrationRegistry {
    const registry = new OAuthIntegrationRegistry();
    for (const integration of config.integrations ?? []) {
      registry.register(requireTrustedOAuthIntegration(integration));
    }
    if (registry.integrations.size === 0) {
      throw new Error('auth_not_available');
    }
    return registry;
  }

  public register(integration: OAuthIntegration): void {
    this.integrations.set(integrationKey(integration.provider, integration.offeringId, integration.mode), integration);
  }

  public require(provider: string, offeringId?: string, mode?: 'deviceCodeOAuth'): DeviceCodeOAuthIntegration;
  public require(provider: string, offeringId: string | undefined, mode: 'authorizationCodeOAuth'): AuthorizationCodeOAuthIntegration;
  public require(provider: string, offeringId?: string, mode: OAuthConnectMode = 'deviceCodeOAuth'): OAuthIntegration {
    const integration = offeringId
      ? this.integrations.get(integrationKey(provider, offeringId, mode))
      : this.onlyIntegration(provider, mode);
    if (!integration) {
      throw new Error('auth_not_available');
    }
    return integration;
  }

  private onlyIntegration(provider: string, mode: OAuthConnectMode): OAuthIntegration | undefined {
    const candidates = [...this.integrations.values()].filter((integration) =>
      integration.provider === provider.trim().toLowerCase() && integration.mode === mode);
    return candidates.length === 1 ? candidates[0] : undefined;
  }
}

type OAuthIntegrationConfigRecord = NonNullable<OAuthIntegrationRegistryConfig['integrations']>[number];

export function requireTrustedOAuthIntegration(value: OAuthIntegrationConfigRecord | OAuthIntegration): OAuthIntegration {
  const clientId = normalizeClientId(value.clientId);
  const mode = value.mode ?? 'deviceCodeOAuth';
  if (
    !clientId
    || !normalizeClientId(value.issuedBy)
    || !value.provider.trim()
    || !value.offeringId.trim()
    || !value.integrationId.trim()
    || !isTrustedProtocolForMode(value.protocol, mode)
  ) {
    throw new Error('auth_not_available');
  }
  return {
    provider: value.provider.trim().toLowerCase(),
    offeringId: value.offeringId.trim(),
    mode,
    integrationId: value.integrationId.trim(),
    issuedBy: normalizeClientId(value.issuedBy)!,
    clientId,
    protocol: value.protocol,
    accountLabel: normalizeOptionalString(value.accountLabel),
    accountId: normalizeOptionalString(value.accountId),
  } as OAuthIntegration;
}

function isTrustedProtocolForMode(
  protocol: DeviceCodeProtocolDescriptor | AuthorizationCodeProtocolDescriptor,
  mode: OAuthConnectMode,
): boolean {
  if (mode === 'deviceCodeOAuth') {
    return 'begin' in protocol && 'poll' in protocol;
  }
  return 'authorization' in protocol
    && 'token' in protocol
    && protocol.authorization.redirectUris.length > 0
    && protocol.token.codec === 'authorizationCodeForm';
}

function normalizeClientId(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = normalizeClientId(value);
  return normalized;
}

function integrationKey(provider: string, offeringId: string, mode: OAuthConnectMode): string {
  return `${provider.trim().toLowerCase()}:${offeringId.trim().toLowerCase()}:${mode}`;
}
