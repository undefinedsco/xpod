import {
  unsupportedQuotaSnapshot,
  type NormalizedQuotaSnapshot,
  type ProviderQuotaAdapter,
  type ProviderQuotaFetchInput,
} from './ProviderQuotaAdapter';

export class OpenAiQuotaAdapter implements ProviderQuotaAdapter {
  public readonly provider = 'openai';

  public async fetch(input: ProviderQuotaFetchInput): Promise<NormalizedQuotaSnapshot> {
    return unsupportedQuotaSnapshot({
      credential: input.credential.credentialIri,
      source: 'openai:no-credential-quota-api',
      now: input.now,
      metadata: {
        reason: 'OpenAI does not expose a normal API-key credential balance endpoint for this gateway.',
      },
    });
  }
}
