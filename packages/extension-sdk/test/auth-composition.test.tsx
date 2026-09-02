// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createSolidSessionRuntime,
  type SolidSessionRuntime,
  type WebIdAuthState,
} from '@undefineds.co/solid-sdk'
import { SolidAuthBoundary } from '../src/react'

afterEach(() => cleanup())

function WebIdOnlyProfile({ session }: { session: SolidSessionRuntime }) {
  const state: WebIdAuthState = session.getSnapshot().status === 'authenticated'
    ? { status: 'authenticated', webId: session.getSnapshot().webId }
    : { status: 'anonymous' }
  return (
    <SolidAuthBoundary
      state={state}
      routes={[{
        id: 'identity-only',
        label: 'Identity only',
        identityProvider: { url: 'https://id.example', label: 'Identity provider' },
        availability: 'ready',
      }]}
      onLogin={() => undefined}
    >
      <output>webid-ready</output>
    </SolidAuthBoundary>
  )
}

describe('public Solid authentication boundary', () => {
  it('supports WebID-only consumers with a SolidSessionRuntime and no Account controller', () => {
    const session = createSolidSessionRuntime()
    render(<WebIdOnlyProfile session={session} />)
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy()
  })
})
