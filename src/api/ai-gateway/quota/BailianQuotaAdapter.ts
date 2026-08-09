import {
  unsupportedQuotaSnapshot,
  type NormalizedQuotaSnapshot,
  type ProviderQuotaAdapter,
  type ProviderQuotaFetchInput,
} from './ProviderQuotaAdapter';

export class BailianQuotaAdapter implements ProviderQuotaAdapter {
  public readonly provider: string;

  public constructor(provider = 'bailian') {
    this.provider = provider;
  }

  public async fetch(input: ProviderQuotaFetchInput): Promise<NormalizedQuotaSnapshot> {
    return unsupportedQuotaSnapshot({
      credential: input.credential.credentialIri,
      source: `${this.provider}:console-only`,
      now: input.now,
      metadata: {
        reason: 'Bailian quota is console-only for first phase gateway credentials.',
      },
    });
  }
}
