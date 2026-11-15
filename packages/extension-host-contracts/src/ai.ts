export type AiClientId = 'codex' | 'claude-code' | 'pi' | 'codebuddy';

export interface AiClientConfigurationStatus {
  status: 'notConfigured' | 'configured' | 'drifted' | 'unavailable' | 'unverifiable' | 'failedAndRestored';
  message?: string;
  appliedKeyFingerprint?: string;
}

export interface AiClientConfigurationConfirmation {
  required: boolean;
  token: string;
  targetHash: string;
  message?: string;
}

export interface AiClientConfigurationPlan {
  planId: string;
  client: AiClientId;
  confirmation?: AiClientConfigurationConfirmation;
  changes: Array<{
    target: string;
    action: 'update' | 'createOrUpdate' | 'delete';
    backup: boolean;
  }>;
}

export interface AiClientConfigurationModel {
  id: string;
  displayName?: string;
  availability?: 'available' | 'unavailable';
  contextWindow?: number;
  inputModalities?: string[];
  capabilities?: string[];
}

export interface AiClientConfigurationCapability {
  readonly available?: boolean;
  readonly authority?: 'local-filesystem';
  readonly manualInstructions?: string;
  inspect(client: AiClientId): Promise<AiClientConfigurationStatus>;
  plan(input: {
    client: AiClientId;
    endpoint: string;
    activeModels?: AiClientConfigurationModel[];
  }): Promise<AiClientConfigurationPlan>;
  apply(input: {
    client: AiClientId;
    planId: string;
    apiKey: string;
    confirmation?: {
      token: string;
      targetHash: string;
    };
  }): Promise<{ applied: true }>;
  verify(input: {
    client: AiClientId;
    planId: string;
  }): Promise<AiClientConfigurationStatus>;
  launch?(client: AiClientId): Promise<{ launched: true }>;
  restore(client: AiClientId): Promise<AiClientConfigurationStatus>;
}

export interface AiConnectionsPodStore {
  listProviders(): Promise<unknown[]>;
  listModels?(): Promise<unknown[]>;
  /**
   * `settings/credentials.ttl`: the document credential rows live in, and
   * therefore the live-update topic of the credentials table.
   */
  credentialsTableDocument?(): string;
  /**
   * The document a provider's own row and its model rows live in
   * (`providers/<provider>.ttl`), and therefore that table's live-update topic.
   *
   * `instanceId` selects the document of a user-defined provider instance,
   * which owns its own document; catalog providers ignore it.
   */
  providerTableDocument?(provider: string, instanceId?: string): string;
  createApiKeyCredential?(provider: string, input: {
    offeringId?: string;
    apiKey: string;
    label?: string;
    baseUrl?: string;
    proxyUrl?: string;
    priority?: number;
    compatibility?: 'auto' | 'openai' | 'anthropic';
    /**
     * The row this credential must be written at.
     *
     * A live collection creates the row optimistically from the models
     * descriptor and then asks the store for the complete row at that id: the
     * secret envelope and the columns the descriptor does not declare are the
     * store's to write. The row already exists then, so the store updates it in
     * place instead of inserting a second one. Omitted = create a new id.
     */
    id?: string;
  }): Promise<unknown>;
  createLocalCredential?(provider: string, input: {
    authorizationMethodId?: string;
    offeringId?: string;
    label?: string;
    baseUrl?: string;
    priority?: number;
    /** See {@link AiConnectionsPodStore.createApiKeyCredential}. */
    id?: string;
  }): Promise<unknown>;
  saveOAuthCredential?(provider: string, input: AiConnectionsOAuthCredential): Promise<unknown>;
  updateOAuthCredential?(
    provider: string,
    credentialId: string,
    expectedVersion: number,
    input: AiConnectionsOAuthCredential,
  ): Promise<unknown>;
  updateProviderCredential?(provider: string, credentialId: string, input: {
    apiKey?: string;
    expectedVersion: number;
    label?: string;
    enabled?: boolean;
    priority?: number;
    baseUrl?: string;
    proxyUrl?: string;
  }): Promise<unknown>;
  markCredentialHealth?(
    provider: string,
    credentialId: string,
    health: 'healthy' | 'invalid' | 'expired' | 'unknown',
    expectedVersion: number,
  ): Promise<unknown>;
  deleteProviderCredential?(provider: string, credentialId: string): Promise<unknown | undefined>;
  readCredentialSecret?(provider: string, credentialId: string): Promise<Record<string, unknown>>;
  saveDiscoveredModels?(provider: string, credentialId: string, models: unknown[]): Promise<void>;
  saveModelSelection?(provider: string, models: AiConnectionsModelSelection[], credentialId?: string): Promise<void>;
}

/**
 * A durable model reference selected by an applet.
 *
 * `id` stays the upstream/public model id. `resourceId` is the canonical Pod
 * resource when one exists; `offeringId` disambiguates identical upstream ids
 * exposed by different commercial offerings.
 */
export interface AiConnectionsModelSelection {
  id: string;
  offeringId?: string;
  resourceId?: string;
}

export interface AiConnectionsOAuthCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt?: string;
  scope?: string;
  idToken?: string;
  accountSubject?: string;
  accountId?: string;
  accountLabel?: string;
  offeringId?: string;
  authorizationMethodId?: string;
  expectedVersion?: number;
}

export interface AiClientCredentialSummary {
  /** CSS label, i.e. the `client_id` inside the `sk-` wrapper. */
  clientId: string
  label?: string
  webId?: string
  /** Account resource used to destroy the credential. */
  resource: string
}

export interface AiClientCredentialsCapability {
  /**
   * Issues one Account client credential. `apiKey` is the ephemeral
   * `sk-<base64(client_id:client_secret)>` wrapper and is only ever returned
   * here; `clientId` is the Account identity the credential is revoked by.
   */
  create(input: { name: string; webId: string }): Promise<{ apiKey: string; clientId: string; resource: string }>;
  /** Credentials the Account still knows about; the secret is never returned. */
  list(): Promise<AiClientCredentialSummary[]>;
  revoke(input: { clientId: string; resource: string; webId: string }): Promise<void>;
}

