import type { GatewayDeployment } from '../auth/GatewayApiKey';
import type { PodCredentialRepository } from '../connect';
import type { CredentialVault } from '../credentials/CredentialVault';
import { normalizeProvider } from '../quota/ProviderQuotaAdapter';
import {
  type DiscoveredProviderModel,
  type ModelsCredentialRecord,
  type ProviderModelsAdapter,
} from './ProviderModelsAdapter';

export interface ProviderModelDiscovery {
  provider: string;
  credential: string;
  models: DiscoveredProviderModel[];
  observedAt: string;
  source: string;
}

export interface ProviderModelsServiceOptions {
  vault: CredentialVault;
  adapters: ProviderModelsAdapter[];
  credentialRepository?: PodCredentialRepository;
  credentials?: ModelsCredentialRecord[];
  now?: () => Date;
}

export class ProviderModelsService {
  private readonly vault: CredentialVault;
  private readonly adapters = new Map<string, ProviderModelsAdapter>();
  private readonly credentialRepository?: PodCredentialRepository;
  private readonly credentials: ModelsCredentialRecord[];
  private readonly now: () => Date;

  public constructor(options: ProviderModelsServiceOptions) {
    this.vault = options.vault;
    this.credentialRepository = options.credentialRepository;
    this.credentials = options.credentials ?? [];
    this.now = options.now ?? (() => new Date());
    for (const adapter of options.adapters) {
      this.adapters.set(normalizeProvider(adapter.provider), adapter);
    }
  }

  public async list(input: {
    webId: string;
    deployment: GatewayDeployment;
    provider: string;
    credentialIri?: string;
    signal?: AbortSignal;
  }): Promise<ProviderModelDiscovery> {
    const provider = normalizeProvider(input.provider);
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`models_adapter_not_found:${provider}`);
    }
    const credential = await this.resolveCredential({
      webId: input.webId,
      deployment: input.deployment,
      provider,
      credentialIri: input.credentialIri,
    });
    const secret = await this.vault.open(
      { webId: input.webId },
      credential.credentialIri,
      provider,
      credential.credentialSecret,
    );
    const models = await adapter.fetch({
      credential,
      secret,
      signal: input.signal,
    });
    return {
      provider,
      credential: credential.credentialIri,
      models,
      observedAt: this.now().toISOString(),
      source: `${provider}:/models`,
    };
  }

  private async resolveCredential(input: {
    webId: string;
    deployment: GatewayDeployment;
    provider: string;
    credentialIri?: string;
  }): Promise<ModelsCredentialRecord> {
    const listed = this.credentials.find((candidate) =>
      candidate.webId === input.webId
      && candidate.deployment === input.deployment
      && normalizeProvider(candidate.provider) === input.provider
      && (!input.credentialIri || candidate.credentialIri === input.credentialIri));
    if (listed) {
      return listed;
    }

    const active = await this.credentialRepository?.getActiveCredential({
      webId: input.webId,
      deployment: input.deployment,
      provider: input.provider,
    });
    if (
      active
      && (!input.credentialIri || active.credentialIri === input.credentialIri)
    ) {
      return active as ModelsCredentialRecord;
    }
    throw new Error('models_credential_not_found');
  }
}
