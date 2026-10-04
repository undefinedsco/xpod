import { describe, expect, it } from 'vitest'
import {
  credentialCarriers,
  credentialSummariesForProvider,
  providerOfCredentialRow,
  type CredentialRow,
} from '../src/collections'
import type { AiProviderCredentialSummary } from '../src/contract/ai-connections-client'
import { providerOfCredentialKey } from '../src/contract/ai-connections-client'

/**
 * A credential row's own `provider` relation is the authority for which provider
 * it belongs to.
 *
 * This is a behavioural test because a type check cannot catch the failure it
 * guards: `RowOf` carries an index signature (models types `fields` as
 * `Record<string, PodModelFieldDescriptor>`), so reading an attribute the
 * descriptor no longer declares - `row.providerId` after the 0.2.57 rename to
 * `provider` - compiles cleanly and yields `undefined` at runtime. The reader
 * then silently falls through to the key heuristic, which answers correctly only
 * while the row key happens to embed the provider, and the row is dropped from
 * its provider's list when it does not.
 */

const PROVIDER_RELATION = 'https://pod.example/alice/settings/providers/openai.ttl#this'

function credentialRow(patch: Partial<CredentialRow> & { id: string }): CredentialRow {
  return {
    service: 'ai',
    authMode: 'apiKey',
    status: 'active',
    ...patch,
  } as CredentialRow
}

describe('providerOfCredentialRow', () => {
  it('reads the row relation even when the key names another provider', () => {
    const row = credentialRow({ id: 'kimi-7f21', provider: PROVIDER_RELATION })

    // The fallback would answer `kimi`; only the relation knows the truth.
    expect(providerOfCredentialKey(String(row.id))).toBe('kimi')
    expect(providerOfCredentialRow(row)).toBe('openai')
  })

  it('attributes a row whose key carries no provider at all', () => {
    const row = credentialRow({ id: 'credential-1', provider: 'https://pod.example/alice/settings/providers/zhipu.ttl#this' })

    expect(providerOfCredentialKey(String(row.id))).toBeUndefined()
    expect(providerOfCredentialRow(row)).toBe('zhipu')
  })

  it('keeps the key heuristic for rows written before the relation existed', () => {
    expect(providerOfCredentialRow(credentialRow({ id: 'deepseek-1' }))).toBe('deepseek')
    expect(providerOfCredentialRow(credentialRow({ id: 'custom-instance-abc.ttl#this' }))).toBe('custom')
    expect(providerOfCredentialRow(credentialRow({ id: 'credential-1' }))).toBeUndefined()
  })
})

describe('credentialSummariesForProvider', () => {
  it('projects persisted failure and cooldown fields and clears them when the live row clears them', () => {
    const carrier: AiProviderCredentialSummary = {
      id: 'credentials.ttl#openai-1', provider: 'openai', authMode: 'apiKey', offeringId: 'api-platform',
      enabled: true, priority: 7, health: 'healthy', version: 4,
      lastFailureCode: 'authentication', failCount: 2,
    }
    const failed = credentialRow({
      id: 'openai-1', provider: PROVIDER_RELATION,
      lastFailureCode: 'rate_limited', lastFailureAt: new Date('2026-10-05T00:00:00Z'),
      rateLimitResetAt: new Date('2026-10-05T00:01:00Z'), failCount: 3,
    })
    expect(credentialSummariesForProvider('openai', [failed], [carrier])[0]).toMatchObject({
      lastFailureCode: 'rate_limited', lastFailureAt: '2026-10-05T00:00:00.000Z',
      rateLimitResetAt: '2026-10-05T00:01:00.000Z', failCount: 3,
    })
    const recovered = credentialRow({
      id: 'openai-1', provider: PROVIDER_RELATION,
      lastFailureCode: null, lastFailureAt: null, rateLimitResetAt: null, failCount: 0,
    })
    expect(credentialSummariesForProvider('openai', [recovered], [carrier])[0]).toMatchObject({
      lastFailureCode: undefined, lastFailureAt: undefined, rateLimitResetAt: undefined, failCount: 0,
    })
  })

  it.each(['openai-1', 'credentials.ttl#openai-1'])(
    'joins a live row to its exact carrier using the models resource id (%s)',
    (carrierId) => {
      const row = credentialRow({ id: 'openai-1', provider: PROVIDER_RELATION })
      const carrier: AiProviderCredentialSummary = {
        id: carrierId,
        provider: 'openai',
        authMode: 'apiKey',
        offeringId: 'api-platform',
        enabled: true,
        priority: 7,
        health: 'healthy',
        baseUrl: 'http://127.0.0.1:39220/v1',
        proxyUrl: 'http://127.0.0.1:7890',
        version: 4,
      }

      expect(credentialSummariesForProvider('openai', [row], [carrier])).toEqual([
        expect.objectContaining({ ...carrier, id: 'credentials.ttl#openai-1' }),
      ])
    },
  )

  it('does not borrow an endpoint or health from a different credential or Pod', () => {
    const row = credentialRow({ id: 'openai-1', provider: PROVIDER_RELATION })
    const carriers: AiProviderCredentialSummary[] = [
      {
        id: 'credentials.ttl#openai-2',
        provider: 'openai', authMode: 'apiKey', offeringId: 'api-platform',
        enabled: true, priority: 7, health: 'healthy', version: 4,
        baseUrl: 'https://wrong.example/v1',
      },
      {
        id: 'https://other.example/settings/credentials.ttl#openai-1',
        provider: 'openai', authMode: 'apiKey', offeringId: 'api-platform',
        enabled: true, priority: 7, health: 'healthy', version: 4,
        baseUrl: 'https://other.example/v1',
      },
    ]

    expect(credentialSummariesForProvider('openai', [row], carriers)).toEqual([
      expect.objectContaining({ baseUrl: undefined, health: 'unknown' }),
    ])
  })

  it('lists a row its relation attributes to the provider, not the rows its key would', () => {
    const attributed = credentialRow({
      id: 'credential-1',
      provider: PROVIDER_RELATION,
      accountLabel: 'Work key',
    })
    const otherProvidersRow = credentialRow({
      id: 'openai-2',
      provider: 'https://pod.example/alice/settings/providers/kimi.ttl#this',
    })

    expect(credentialSummariesForProvider('openai', [attributed, otherProvidersRow])).toEqual([
      expect.objectContaining({ id: 'credentials.ttl#credential-1', provider: 'openai', label: 'Work key' }),
    ])
    expect(credentialSummariesForProvider('kimi', [attributed, otherProvidersRow])).toEqual([
      expect.objectContaining({ id: 'credentials.ttl#openai-2', provider: 'kimi' }),
    ])
  })
})

describe('credentialCarriers', () => {
  it('lets newer mutation health reach a live row, then accepts a newer store echo', () => {
    const overlay: AiProviderCredentialSummary = {
      id: 'openai-1', provider: 'openai', authMode: 'apiKey', offeringId: 'api-platform',
      enabled: true, priority: 100, health: 'invalid', version: 2,
      baseUrl: 'https://old.example/v1',
    }
    const store = { ...overlay, id: 'credentials.ttl#openai-1', health: 'healthy' as const, version: 1, baseUrl: 'https://current.example/v1' }
    const product = (credential: AiProviderCredentialSummary) => ({
      id: 'openai' as const, name: 'OpenAI', offerings: [], selectedModels: [],
      status: 'configured' as const, credentials: [credential],
    })

    expect(credentialCarriers({ openai: product(store) }, { openai: product(overlay) }).openai).toEqual([overlay])
    const echo = { ...store, version: 3 }
    expect(credentialCarriers({ openai: product(echo) }, { openai: product(overlay) }).openai).toEqual([echo])
    expect(credentialCarriers({ openai: product({ ...store, version: 2 }) }, { openai: product(overlay) }).openai).toEqual([overlay])
  })
})
