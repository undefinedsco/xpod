import {
  unsupportedQuotaSnapshot,
  type NormalizedQuotaSnapshot,
  type ProviderQuotaAdapter,
  type ProviderQuotaFetchInput,
} from './ProviderQuotaAdapter';

export class BailianQuotaAdapter implements ProviderQuotaAdapter {
  public readonly provider = 'bailian';

  public async fetch(input: ProviderQuotaFetchInput): Promise<NormalizedQuotaSnapshot> {
    return unsupportedQuotaSnapshot({
      credential: input.credential.credentialIri,
      source: 'bailian:console-only',
      now: input.now,
      metadata: {
        reason: 'Bailian quota is console-only for first phase gateway credentials.',
      },
    });
  }
}
