import { randomUUID } from 'node:crypto';
import type { GatewayDeployment } from '../auth/GatewayApiKey';
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
  randomId?: () => string;
}

export class OAuthConnectCredentialStore {
  private readonly provider: string;
  private readonly credentialRepository: PodCredentialRepository;
  private readonly vault: CredentialVault;
  private readonly randomId: () => string;

  public constructor(options: OAuthConnectCredentialStoreOptions) {
    this.provider = options.provider.toLowerCase();
    this.credentialRepository = options.credentialRepository;
    this.vault = options.vault;
    this.randomId = options.randomId ?? randomUUID;
  }

  public async createSiblingOAuthCredential(input: {
    webId: string;
    deployment: GatewayDeployment;
    secret: ProviderSecret;
    expiresAt?: Date;
    expectedVersion?: number;
    auth?: AuthContext;
    metadata?: Record<string, unknown>;
  }): Promise<ConnectCredentialRecord> {
    const credentialIri = this.createCredentialIri(input.webId, input.deployment);
    const encryptedSecret = await this.vault.seal(
      { webId: input.webId },
      credentialIri,
      this.provider,
      input.secret,
    );
    return this.credentialRepository.createCredential({
      credentialIri,
      webId: input.webId,
      provider: this.provider,
      deployment: input.deployment,
      authMode: 'deviceCodeOAuth',
      encryptedSecret,
      status: 'active',
      expiresAt: input.expiresAt,
      expectedVersion: input.expectedVersion,
      offeringId: 'official-subscription',
      priority: 100,
      enabled: true,
      health: 'healthy',
      accountLabel: 'OAuth',
      metadata: {
        offeringId: 'official-subscription',
        priority: 100,
        enabled: true,
        health: 'healthy',
        ...input.metadata,
      },
    }, { auth: input.auth });
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

  private createCredentialIri(webId: string, deployment: GatewayDeployment): string {
    const credentialId = `${deployment}-${this.provider}-oauth-${this.randomId()}`;
    try {
      const url = new URL(webId);
      const profileIndex = url.pathname.indexOf('/profile/');
      const podPath = profileIndex >= 0 ? url.pathname.slice(0, profileIndex) : '';
      url.pathname = `${podPath}/settings/credentials/${this.provider}.ttl`;
      url.hash = credentialId;
      url.search = '';
      return url.toString();
    } catch {
      return `${webId.replace(/[#/]*$/u, '')}/settings/credentials/${this.provider}.ttl#${credentialId}`;
    }
  }
}
