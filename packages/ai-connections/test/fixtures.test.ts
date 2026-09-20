import { describe, expect, it } from 'vitest'
import type { AiConnectionsProvider } from '../src/ai-connections-client'
import { PROVIDER_OFFERINGS } from '../src/provider-catalog'
import { providerDisplayName } from '../src/display-wording'
import {
  catalogOffering,
  catalogOfferings,
  catalogProvider,
  makeCredential,
  makeOffering,
  makeProvider,
} from './fixtures'

const PROVIDERS = Object.keys(PROVIDER_OFFERINGS) as AiConnectionsProvider[]

describe('catalog fixtures', () => {
  it('reaches every offering the catalog publishes', () => {
    for (const provider of PROVIDERS) {
      const offerings = catalogOfferings(provider)
      expect(offerings.length, `${provider} offerings`).toBeGreaterThan(0)
      for (const offering of offerings) {
        expect(catalogOffering(provider, offering.id)).toEqual(offering)
      }
    }
  })

  it('fails loudly when the catalog stops publishing an offering', () => {
    expect(() => catalogOffering('openai', 'retired-offering'))
      .toThrow(/publishes no openai\/retired-offering/)
  })

  it('hands out copies, so a test cannot edit the catalog through a fixture', () => {
    const offering = catalogOffering('openai', 'api-platform')
    const endpointCount = offering.endpoints?.length
    offering.label = 'mutated'
    offering.endpoints?.push({ protocol: 'chatCompletions', baseUrl: 'https://example.invalid' })

    const fresh = catalogOffering('openai', 'api-platform')
    expect(fresh.label).toBe('API Platform')
    expect(fresh.endpoints).toHaveLength(endpointCount ?? 0)
  })

  it('keeps every published offering self-describing', () => {
    for (const provider of PROVIDERS) {
      for (const offering of catalogOfferings(provider)) {
        const where = `${provider}/${offering.id}`
        // A missing label makes the UI fall back to a kind name or the raw id,
        // which is how one offering ended up reading differently per entry point.
        expect(offering.label?.trim(), `${where} label`).toBeTruthy()
        expect(offering.kind, `${where} kind`).toBeTruthy()
        expect(
          (offering.authModes ?? []).length + (offering.authorizationMethods ?? []).length,
          `${where} authorization`,
        ).toBeGreaterThan(0)
      }
    }
  })

  it('derives provider summaries from the catalog instead of a hand-written copy', () => {
    const openai = catalogProvider('openai')
    expect(openai.name).toBe(providerDisplayName('openai'))
    expect(openai.offerings.map((offering) => offering.id))
      .toEqual(catalogOfferings('openai').map((offering) => offering.id))
    expect(openai.status).toBe('unconfigured')

    // The desktop import path is a catalog variant, not something a test invents.
    const desktop = catalogProvider('openai', { offerings: catalogOfferings('openai', true) })
    expect(desktop.offerings[0]?.authorizationMethods?.map((method) => method.id))
      .toEqual(['device-code', 'local-session-import'])
  })

  it('builds synthetic fixtures with the traits the test names', () => {
    const provider = makeProvider({ id: 'kimi', status: 'available', offerings: [makeOffering({ id: 'api-platform' })] })
    expect(provider).toMatchObject({ id: 'kimi', name: 'Kimi', status: 'available', credentials: [], selectedModels: [] })
    expect(provider.offerings[0]).toMatchObject({ id: 'api-platform', lifecycle: 'active' })

    const credential = makeCredential({ offeringId: 'api-platform', authMode: 'oauth', health: 'healthy' })
    expect(credential).toMatchObject({
      id: 'api-platform-credential', offeringId: 'api-platform', authMode: 'oauth',
      enabled: true, priority: 10, health: 'healthy', version: 1,
    })
  })
})
