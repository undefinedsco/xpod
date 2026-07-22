import {
  unsupportedQuotaSnapshot,
  type NormalizedQuotaSnapshot,
  type ProviderQuotaAdapter,
  type ProviderQuotaFetchInput,
} from './ProviderQuotaAdapter';

export class AnthropicQuotaAdapter implements ProviderQuotaAdapter {
  public readonly provider = 'anthropic';

  public async fetch(input: ProviderQuotaFetchInput): Promise<NormalizedQuotaSnapshot> {
    return unsupportedQuotaSnapshot({
      credential: input.credential.credentialIri,
      source: 'anthropic:no-credential-quota-api',
      now: input.now,
      metadata: {
        reason: 'Anthropic does not expose a normal API-key credential balance endpoint for this gateway.',
      },
    });
  }
}
