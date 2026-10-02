import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { XPOD_AVATAR } from '../src/provider-visuals'

const DATA_URI_PREFIX = 'data:image/svg+xml;base64,'

describe('Xpod visual', () => {
  it('uses the same selected Xpod mark as the login', () => {
    expect(XPOD_AVATAR.startsWith(DATA_URI_PREFIX)).toBe(true)
    // The capability package cannot import an application asset at runtime.
    const appMark = readFileSync(new URL('../../../ui/src/assets/xpod-app.svg', import.meta.url), 'utf8')
    expect(Buffer.from(XPOD_AVATAR.slice(DATA_URI_PREFIX.length), 'base64').toString('utf8')).toBe(appMark)
  })
})
