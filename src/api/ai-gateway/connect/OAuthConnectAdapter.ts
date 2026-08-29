import type { GatewayDeployment } from '../auth/InvocationTokenCodec';
import type { CredentialVault, ProviderSecret } from '../credentials/CredentialVault';
import type { AuthContext } from '../../auth/AuthContext';
import type {
  ConnectCredentialRecord,
  PodCredentialRepository,
} from './index';

export interface OAuthConnectCredentialStoreOptions {
  provider: string;
  deployment: GatewayDeployment;
  credentialRepository: PodCredentialRepository;
  vault: CredentialVault;
}

export class OAuthConnectCredentialStore {
  private readonly provider: string;
  private readonly credentialRepository: PodCredentialRepository;
  private readonly vault: CredentialVault;

  public constructor(options: OAuthConnectCredentialStoreOptions) {
    this.provider = options.provider.toLowerCase();
    this.credentialRepository = options.credentialRepository;
    this.vault = options.vault;
  }

  public async updateOAuthCredential(input: {
    current: ConnectCredentialRecord;
    webId: string;
    deployment: GatewayDeployment;
    secret: ProviderSecret;
    expiresAt?: Date;
    auth?: AuthContext;
    metadata?: Record<string, unknown>;
  }): Promise<ConnectCredentialRecord | undefined> {
    const encryptedSecret = await this.vault.seal(
      { webId: input.webId },
      input.current.credentialIri,
      this.provider,
      input.secret,
    );
    return this.credentialRepository.updateCredential({
      webId: input.webId,
      provider: this.provider,
      deployment: input.deployment,
      credentialId: input.current.id,
      expectedVersion: input.current.version,
      auth: input.auth,
      patch: {
        encryptedSecret,
        expiresAt: input.expiresAt,
        status: 'active',
        reauthRequired: false,
        enabled: true,
        health: 'healthy',
        metadata: {
          ...(input.current.metadata ?? {}),
          ...input.metadata,
          offeringId: 'official-subscription',
          enabled: true,
          health: 'healthy',
        },
      },
    });
  }

}
