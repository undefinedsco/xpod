import {
  unsupportedQuotaSnapshot,
  type NormalizedQuotaSnapshot,
  type ProviderQuotaAdapter,
  type ProviderQuotaFetchInput,
} from './ProviderQuotaAdapter';

export class UnsupportedQuotaAdapter implements ProviderQuotaAdapter {
  public readonly provider = 'metadata';
  public readonly capability = { protocol: 'unsupported-quota' } as const;

  public async fetch(input: ProviderQuotaFetchInput): Promise<NormalizedQuotaSnapshot> {
    return unsupportedQuotaSnapshot({
      credential: input.credential.credentialIri,
      source: `${input.credential.provider}:${input.credential.offeringId ?? 'unknown'}:quota-unsupported`,
      now: input.now,
      metadata: { reason: 'The selected Offering does not expose a credential-scoped quota API.' },
    });
  }
}
