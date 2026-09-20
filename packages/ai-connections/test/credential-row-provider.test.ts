import { describe, expect, it } from 'vitest'
import {
  credentialSummariesForProvider,
  providerOfCredentialRow,
  type CredentialRow,
} from '../src/collections'
import { providerOfCredentialKey } from '../src/credential-storage'

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
      expect.objectContaining({ id: 'credential-1', provider: 'openai', label: 'Work key' }),
    ])
    expect(credentialSummariesForProvider('kimi', [attributed, otherProvidersRow])).toEqual([
      expect.objectContaining({ id: 'openai-2', provider: 'kimi' }),
    ])
  })
})
