import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { XPOD_AVATAR } from '../src/provider-visuals'

const DATA_URI_PREFIX = 'data:image/svg+xml;base64,'

describe('Xpod visual', () => {
  it('inlines the repository Xpod shield as an SVG data URI', () => {
    expect(XPOD_AVATAR.startsWith(DATA_URI_PREFIX)).toBe(true)
    const svg = atob(XPOD_AVATAR.slice(DATA_URI_PREFIX.length))
    expect(svg).toContain('<svg')
    expect(svg).toContain('stroke="#8A72BE"')
    expect(svg).toContain('M32 7 51 16.5v13.8c0 12.4-7.4 21.2-19 27.7')
  })

  it('stays in step with ui/src/assets/xpod-shield.svg', () => {
    // The package cannot import from the ui app, so the mark is inlined; this
    // guard fails when the repository shield changes without re-inlining it.
    const shield = readFileSync(new URL('../../../ui/src/assets/xpod-shield.svg', import.meta.url), 'utf8')
    expect(atob(XPOD_AVATAR.slice(DATA_URI_PREFIX.length))).toBe(shield)
  })
})
