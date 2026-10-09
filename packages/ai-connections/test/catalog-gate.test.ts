import { describe, expect, it } from 'vitest'
import { AI_CONNECTIONS_PINNED_SECTIONS } from '../src/controller'

describe('desktop AI navigation', () => {
  it('has a single downstream key surface', () => {
    expect(AI_CONNECTIONS_PINNED_SECTIONS).toEqual([{ id: 'keys', label: 'Xpod', title: 'Xpod' }])
  })
})
