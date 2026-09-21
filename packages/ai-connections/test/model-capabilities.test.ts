import { describe, expect, it } from 'vitest'
import { modelIconTokens } from '../src/AiModelCatalog'
// `parseGatewayModel` is an internal payload parser on purpose - the published
// `/client` barrel lists its surface explicitly - so this test reads the core's
// source directly rather than widening the contract for a test.
import { parseGatewayModel } from '../src/contract/client/normalize'

describe('model capability surfacing', () => {
  it('turns catalog capability flags into the tokens a row renders', () => {
    const model = parseGatewayModel({
      id: 'deepseek-v4.1-flash',
      provider: 'deepseek',
      capabilities: { toolCalls: true, reasoningEffort: true, imageInput: true, fast: true },
      modalities: { input: ['text', 'image'] },
    })
    // `image` arrives from both the modality list and the flag, and is folded
    // into one mark.
    expect(modelIconTokens(model!)).toEqual(['image', 'tool_call', 'reasoning', 'fast'])
  })

  it('folds a modality and its matching flag into one mark', () => {
    // `image` arrives both as an input modality and as `imageInput`. The row maps
    // one element per token under a React key, so the duplicate is not cosmetic.
    const model = parseGatewayModel({
      id: 'gpt-5',
      provider: 'openai',
      capabilities: { imageInput: true },
      modalities: { input: ['text', 'image'] },
    })
    expect(modelIconTokens(model!)).toEqual(['image'])
  })

  it('shows no marks rather than inventing them when there is no evidence', () => {
    const model = parseGatewayModel({ id: 'mystery-model', provider: 'openai' })
    expect(modelIconTokens(model!)).toEqual([])
  })

  it('has a glyph for every token the wire mapper can emit', () => {
    // The mapping and the row renderer used to own separate lists, so a token
    // the mapper produced (`embedding`, or a `pdf` input modality) reached the
    // row with nothing to draw and vanished. This walks the whole vocabulary.
    const model = parseGatewayModel({
      id: 'everything',
      provider: 'openai',
      capabilities: { imageInput: true, toolCalls: true, reasoningEffort: true, embedding: true },
      modalities: { input: ['text', 'image', 'pdf', 'audio', 'video'] },
    })
    expect(modelIconTokens(model!)).toEqual([
      'image', 'pdf', 'audio', 'video', 'tool_call', 'reasoning', 'embedding',
    ])
  })

  it('drops a custom token it cannot draw instead of leaving a hole in the row', () => {
    // A custom model declares its own tokens, which reach the row as
    // `custom_capabilities` and never pass through the catalog's vocabulary.
    const model = parseGatewayModel({
      id: 'custom-thing',
      provider: 'openai',
      custom_capabilities: ['tool_call', 'something-new'],
    })
    expect(modelIconTokens(model!)).toEqual(['tool_call'])
  })
})
