import { describe, expect, it } from 'vitest'
import { modelCatalogId, withCatalogModelId } from '../src/AiModelCatalog'

/**
 * A Pod stores a picked model as the resource it selected, so catalog entries
 * arrive either as the model id or as that resource reference. Both surfaces
 * list models by id, and a reference must fold onto the model it names.
 */
describe('model catalog identity', () => {
  it('keeps an id that is already a model id', () => {
    expect(modelCatalogId({ id: 'gpt-6-astra' })).toBe('gpt-6-astra')
    expect(modelCatalogId({ id: 'openai/gpt-6-astra' })).toBe('openai/gpt-6-astra')
  })

  it('folds a stored resource reference onto the model it names', () => {
    expect(modelCatalogId({
      id: 'https://pod.example/alice/settings/providers/openai-official-subscription.ttl#gpt-6-astra',
    })).toBe('gpt-6-astra')
    expect(modelCatalogId({ id: 'openai.ttl#gpt-6-astra' })).toBe('gpt-6-astra')
  })

  it('leaves a reference without a model fragment as it is', () => {
    expect(modelCatalogId({ id: 'https://pod.example/alice/settings/providers/openai.ttl' }))
      .toBe('https://pod.example/alice/settings/providers/openai.ttl')
  })

  it('folds an entry without mutating it', () => {
    const entry = {
      id: 'https://pod.example/alice/settings/providers/openai.ttl#gpt-6-astra',
      provider: 'openai',
      resourceId: 'https://pod.example/alice/settings/providers/openai.ttl#gpt-6-astra',
    }

    expect(withCatalogModelId(entry)).toEqual({ ...entry, id: 'gpt-6-astra' })
    expect(entry.id).toBe('https://pod.example/alice/settings/providers/openai.ttl#gpt-6-astra')
    // The stored reference stays on the entry: the card keeps every selection
    // id so unpicking the model releases the reference as well.
    expect(withCatalogModelId(entry).resourceId).toBe(entry.resourceId)
    expect(withCatalogModelId({ id: 'gpt-6-astra' })).toEqual({ id: 'gpt-6-astra' })
  })
})
