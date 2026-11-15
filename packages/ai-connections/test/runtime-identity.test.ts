import { describe, expect, it } from 'vitest'
import * as legacy from '../src/contract/ai-connections-client'
import * as runtime from '@undefineds.co/ai-connections-runtime/client'
import { PROVIDER_OFFERINGS as legacyOfferings } from '../src/contract/provider-catalog'
import { PROVIDER_OFFERINGS as runtimeOfferings } from '@undefineds.co/ai-connections-runtime/provider-catalog'
import { AiClientConfigTransaction as legacyTransaction } from '../src/contract/client-config'
import { AiClientConfigTransaction as runtimeTransaction } from '@undefineds.co/ai-connections-runtime/client-config'

describe('legacy AI capability paths', () => {
  it('shares classes, request functions and catalog instances with the canonical runtime', () => {
    expect(legacy.AiConnectionsRequestError).toBe(runtime.AiConnectionsRequestError)
    expect(legacy.createAiConnectionsClient).toBe(runtime.createAiConnectionsClient)
    expect(legacyOfferings).toBe(runtimeOfferings)
    expect(legacyTransaction).toBe(runtimeTransaction)
  })
})
