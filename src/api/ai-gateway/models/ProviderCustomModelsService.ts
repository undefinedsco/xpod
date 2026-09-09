import type { GatewayDeployment } from '../auth/InvocationTokenCodec';
import type { AuthContext } from '../../auth/AuthContext';
import {
  customModelsFromMetadata,
  type ConnectCredentialRecord,
  type CustomProviderModel,
  type PodCredentialRepository,
} from '../connect';
import { normalizeProvider } from '../quota/ProviderQuotaAdapter';

export interface ProviderCustomModelsServiceOptions {
  credentialRepository: PodCredentialRepository;
}

export class ProviderCustomModelsService {
  private readonly credentialRepository: PodCredentialRepository;

  public constructor(options: ProviderCustomModelsServiceOptions) {
    this.credentialRepository = options.credentialRepository;
  }

  public async upsert(input: {
    webId: string;
    deployment: GatewayDeployment;
    provider: string;
    model: CustomProviderModel;
    auth?: AuthContext;
  }): Promise<CustomProviderModel[]> {
    const credential = await this.requireCredential(input);
    const customModels = customModelsFromMetadata(credential.metadata);
    const entry = serializeCustomModel(input.model);
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
