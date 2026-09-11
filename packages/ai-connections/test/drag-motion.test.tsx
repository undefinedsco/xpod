// @vitest-environment jsdom
import './setup-jsdom'
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiCredentialPoolSection } from '../src/AiCredentialPoolSection'
import { PROVIDERS } from '../src/controller'

let frames: Map<number, FrameRequestCallback>
let sequence = 0
beforeEach(() => {
  frames = new Map()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function frame() {
  act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0)) })
}
function pointer(handle: HTMLElement, type: string, y: number, pointerType = 'mouse') {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { pointerId: 1, pointerType, button: 0, clientY: y })
  fireEvent(handle, event)
}
function setup() {
  const move = vi.fn()
  const credentials = ['First', 'Second', 'Third'].map((label, index) => ({
    id: label, label, offeringId: 'api', authMode: 'apiKey' as const,
    enabled: true, priority: index * 10, health: 'healthy' as const, version: 1,
  }))
  const props = {
    definition: PROVIDERS[0]!, product: { id: 'openai' as const, name: 'OpenAI', status: 'available' as const,
      offerings: [{ id: 'api', authModes: ['apiKey' as const] }], credentials, selectedModels: [] },
    status: 'configured' as const, apiKey: '', busy: false, onApiKeyChange: vi.fn(), onBeginApiKey: vi.fn(),
    onBeginBrowser: vi.fn(), onSaveApiKey: vi.fn(), onDisconnect: vi.fn(), onReorderCredentials: move,
  }
  const rendered = render(<AiCredentialPoolSection {...props} />)
  const rows = Array.from(rendered.container.querySelectorAll<HTMLElement>('[data-sortable-credential]'))
  const heights = [80, 120, 60]
  let top = 0
  const reads = rows.map((row, index) => {
    const y = top; top += heights[index]! + 8
    return vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ top: y, bottom: y + heights[index]!, height: heights[index], left: 0, width: 300, right: 300, x: 0, y, toJSON() {} } as DOMRect)
  })
  const handle = screen.getByRole('button', { name: '拖动排序 First' })
  Object.assign(handle, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() })
  return { ...rendered, rows, reads, handle, move, props }
}

describe('credential drag motion', () => {
  it('keeps the sorting handle visible but disabled for a single credential', () => {
    const { rerender, props, move } = setup()
    rerender(<AiCredentialPoolSection {...props} product={{ ...props.product, credentials: props.product.credentials.slice(0, 1) }} />)
    const handle = screen.getByRole('button', { name: '拖动排序 First' })
    expect(handle).toHaveProperty('disabled', true)
    expect(handle.getAttribute('title')).toContain('两条')
    pointer(handle, 'pointerdown', 20)
    pointer(handle, 'pointermove', 240)
    pointer(handle, 'pointerup', 240)
    expect(move).not.toHaveBeenCalled()
  })

  it.each(['mouse', 'touch'])('lifts and follows %s, smoothly moving unequal-height siblings with fixed hit targets', (type) => {
    const { rows, reads, handle, move } = setup()
    pointer(handle, 'pointerdown', 20, type)
    pointer(handle, 'pointermove', 240, type)
    frame()
    expect(rows[0]!.dataset.dragging).toBe('true')
    expect(rows[0]!.style.zIndex).toBe('10')
    expect(rows[0]!.style.transform).toBe('translateY(220px)')
    expect(rows[1]!.style.transform).toBe('translateY(-88px)')
    expect(rows[2]!.style.transform).toBe('translateY(-88px)')
    expect(rows[1]!.style.transition).toContain('160ms')
    pointer(handle, 'pointermove', 230, type)
    frame()
    reads.forEach((read) => expect(read).toHaveBeenCalledTimes(1))
    pointer(handle, 'pointerup', 230, type)
    expect(move).toHaveBeenCalledWith(expect.anything(), expect.anything(), 0, 2)
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(1)
    frame(); frame()
    expect(rows[0]!.style.transform).toBe('translateY(0px)')
    expect(rows[0]!.dataset.dragging).toBeUndefined()
  })

  it.each(['Escape', 'pointercancel', 'lostpointercapture'])('returns rows without saving on %s', (reason) => {
    const { rows, handle, move } = setup()
    pointer(handle, 'pointerdown', 20)
    pointer(handle, 'pointermove', 240)
    frame()
    if (reason === 'Escape') fireEvent.keyDown(handle, { key: reason })
    else pointer(handle, reason, 240)
    pointer(handle, 'pointerup', 240)
    frame(); frame()
    expect(move).not.toHaveBeenCalled()
    expect(rows[0]!.style.transform).toBe('translateY(0px)')
  })

  it('cancels active drag when busy and releases capture on unmount', () => {
    const { handle, move, rerender, unmount, props } = setup()
    pointer(handle, 'pointerdown', 20)
    pointer(handle, 'pointermove', 240)
    rerender(<AiCredentialPoolSection {...props} busy />)
    pointer(handle, 'pointerup', 240)
    expect(move).not.toHaveBeenCalled()
    unmount()
    expect(frames.size).toBe(0)
    expect(handle.releasePointerCapture).toHaveBeenCalled()
  })

  it('keeps the dropped preview while an async save is busy, then settles into the saved order', async () => {
    const { rows, handle, move, rerender, props } = setup()
    let resolve!: () => void
    const saved = new Promise<void>((done) => { resolve = done })
    move.mockImplementation(async () => {
      rerender(<AiCredentialPoolSection {...props} busy />)
      await saved
      rerender(<AiCredentialPoolSection {...props} product={{ ...props.product,
        credentials: [props.product.credentials[1]!, props.product.credentials[2]!, props.product.credentials[0]!]
          .map((credential, index) => ({ ...credential, priority: index * 10 })),
      }} />)
    })
    pointer(handle, 'pointerdown', 20)
    pointer(handle, 'pointermove', 240)
    frame()
    pointer(handle, 'pointerup', 240)
    frame(); frame()
    expect(rows[0]!.style.transform).toBe('translateY(196px)')
    expect(rows[1]!.style.transform).toBe('translateY(-88px)')
    expect(rows[0]!.style.backgroundColor).not.toBe('')
    await act(async () => { resolve(); await saved })
    frame(); frame()
    expect(rows[0]!.style.transform).toBe('translateY(0px)')
    expect(rows[0]!.dataset.dragging).toBeUndefined()
    expect(move).toHaveBeenCalledTimes(1)
  })

  it('clears a dropped preview even if the save remains busy indefinitely', () => {
    // Keep animation frames on the manual queue installed in beforeEach.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { rows, handle, move, rerender, props } = setup()
    move.mockImplementation(() => rerender(<AiCredentialPoolSection {...props} busy />))
    pointer(handle, 'pointerdown', 20)
    pointer(handle, 'pointermove', 240)
    frame()
    pointer(handle, 'pointerup', 240)
    frame()
    expect(rows[0]!.style.transform).toBe('translateY(196px)')
    act(() => { vi.advanceTimersByTime(10_000) })
    frame()
    act(() => { vi.advanceTimersByTime(180) })
    expect(rows[0]!.style.transform).toBe('')
    expect(rows[0]!.style.willChange).toBe('')
  })

  it('cleans active capture and scheduled painting on unmount', () => {
    const { handle, unmount, move } = setup()
    pointer(handle, 'pointerdown', 20)
    pointer(handle, 'pointermove', 240)
    unmount()
    frame()
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(1)
    expect(frames.size).toBe(0)
    expect(move).not.toHaveBeenCalled()
  })

  it('honors reduced motion and preserves keyboard sorting', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const { rows, handle, move } = setup()
    pointer(handle, 'pointerdown', 20)
    pointer(handle, 'pointermove', 240)
    frame()
    expect(rows[1]!.style.transition).toBe('none')
    fireEvent.keyDown(handle, { key: 'Escape' })
    frame(); frame()
    expect(rows[0]!.style.transition).toBe('none')
    fireEvent.keyDown(handle, { key: 'End' })
    expect(move).toHaveBeenCalledWith(expect.anything(), expect.anything(), 0, 2)
  })
})
