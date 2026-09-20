import type { GatewayDeployment } from '../auth/InvocationTokenCodec';
import type { AuthContext } from '../../auth/AuthContext';
import {
  EmbeddingModelPolicy,
  EmbeddingModelNotAllowedError,
} from '../../../ai/service/EmbeddingModelPolicy';
import {
  customModelsFromMetadata,
  type ConnectCredentialRecord,
  type CustomProviderModel,
  type PodCredentialRepository,
} from '../connect';
import { normalizeProvider } from '../quota/ProviderQuotaAdapter';
import { createDefaultProviderRegistry, type ProviderRegistry } from '../providers/ProviderRegistry';

export interface ProviderCustomModelsServiceOptions {
  credentialRepository: PodCredentialRepository;
  /** Provider catalog; decides which providers this deployment offers at all. */
  registry?: ProviderRegistry;
  /**
   * Deployment policy for embedding declarations. A cloud deployment only
   * provides embedding models from the ai-gateway catalog, so a custom model may
   * not claim embedding capability for a model the catalog does not provide.
   */
  embeddingModelPolicy?: EmbeddingModelPolicy;
}

export class ProviderCustomModelsService {
  private readonly credentialRepository: PodCredentialRepository;
  private readonly embeddingModelPolicy: EmbeddingModelPolicy;
  private readonly registry: ProviderRegistry;

  public constructor(options: ProviderCustomModelsServiceOptions) {
    this.credentialRepository = options.credentialRepository;
    this.embeddingModelPolicy = options.embeddingModelPolicy ?? EmbeddingModelPolicy.allowAll();
    this.registry = options.registry ?? createDefaultProviderRegistry();
  }

  public async upsert(input: {
    webId: string;
    deployment: GatewayDeployment;
    provider: string;
    model: CustomProviderModel;
    auth?: AuthContext;
  }): Promise<CustomProviderModel[]> {
    const credential = await this.requireCredential(input);
    if (!this.registry.isProvidedInDeployment(input.provider, input.deployment)) {
      throw new Error('provider_not_available_in_deployment');
    }
    const customModels = customModelsFromMetadata(credential.metadata);
    const entry = serializeCustomModel(input.model);
    this.assertEmbeddingDeclarationAllowed(input.provider, entry);
    const index = customModels.findIndex((model) => model.id === entry.id);
    if (index === -1) {
      customModels.push(entry);
    } else {
      customModels[index] = entry;
    }
    await this.persistMetadata(input, credential, customModels);
    return customModels;
  }

  public async remove(input: {
    webId: string;
    deployment: GatewayDeployment;
    provider: string;
    modelId: string;
    auth?: AuthContext;
  }): Promise<CustomProviderModel[]> {
    const credential = await this.requireCredential(input);
    const customModels = customModelsFromMetadata(credential.metadata)
      .filter((model) => model.id !== input.modelId);
    await this.persistMetadata(input, credential, customModels);
    return customModels;
  }

  /**
   * A custom model may only declare embedding capability when the deployment
   * provides that exact provider/model as an embedding model. Local deployments
   * allow any declaration; cloud deployments do not.
   */
  private assertEmbeddingDeclarationAllowed(provider: string, model: CustomProviderModel): void {
    const declaresEmbedding = (model.capabilities ?? [])
      .some((capability) => capability.trim().toLowerCase() === 'embedding');
    if (!declaresEmbedding) {
      return;
    }
    if (!this.embeddingModelPolicy.isAllowed({ provider, model: model.id })) {
      throw new EmbeddingModelNotAllowedError(provider, model.id);
    }
  }

  private async requireCredential(input: {
    webId: string;
    deployment: GatewayDeployment;
    provider: string;
    auth?: AuthContext;
  }): Promise<ConnectCredentialRecord> {
    const credential = await this.credentialRepository.getCredential?.({
      webId: input.webId,
      provider: normalizeProvider(input.provider),
      deployment: input.deployment,
      auth: input.auth,
    });
    if (!credential || credential.status !== 'active') {
      throw new Error('models_credential_not_found');
    }
    return credential;
  }

  private async persistMetadata(
    input: { auth?: AuthContext },
    credential: ConnectCredentialRecord,
    customModels: CustomProviderModel[],
  ): Promise<void> {
    const metadata = { ...(credential.metadata ?? {}) };
    if (customModels.length > 0) {
      metadata.customModels = customModels.map(serializeCustomModel);
    } else {
      delete metadata.customModels;
    }
    await this.credentialRepository.upsertConnectedCredential(
      {
        ...credential,
        metadata,
        expectedVersion: credential.version,
      },
      { auth: input.auth },
    );
  }
}

function serializeCustomModel(model: CustomProviderModel): CustomProviderModel {
  const capabilities = model.capabilities?.filter(Boolean);
  const inputModalities = model.inputModalities?.filter(Boolean);
  const outputModalities = model.outputModalities?.filter(Boolean);
  return {
    id: model.id,
    ...(model.displayName ? { displayName: model.displayName } : {}),
    ...(inputModalities && inputModalities.length > 0 ? { inputModalities: [...inputModalities] } : {}),
    ...(outputModalities && outputModalities.length > 0 ? { outputModalities: [...outputModalities] } : {}),
    ...(capabilities && capabilities.length > 0 ? { capabilities: [...capabilities] } : {}),
  };
}
