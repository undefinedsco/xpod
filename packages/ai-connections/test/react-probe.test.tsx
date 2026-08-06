// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import * as React from 'react'
import { createRequire } from 'node:module'

describe('probe', () => {
  it('catches which instance renders', async () => {
    const req = createRequire(import.meta.url)
    const nodeReact = req('react')
    const nodeInternals = (nodeReact as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
    const TL = await import('@testing-library/react')
    function Inner() { const [x] = React.useState(1); return <span>{x}</span> }
    try {
      TL.render(<Inner />)
      console.log('PROBE render OK')
    } catch (e) {
      console.log('PROBE render failed:', (e as Error).message.slice(0, 60))
    }
    console.log('PROBE node-react H:', nodeInternals.H ? 'SET' : 'NULL')
    const viteInternals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
    console.log('PROBE vite-react === node-react internals:', viteInternals === nodeInternals)
    expect(true).toBe(true)
  })
})
