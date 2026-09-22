import { JSDOM } from 'jsdom'

/**
 * jsdom has no `PointerEvent`, so `fireEvent.pointer*` falls back to a plain
 * `Event`: `clientX`/`clientY` never arrive, and code that computes a pointer's
 * position - Radix's tooltip "pointer in transit" bookkeeping, for one - divides
 * by a missing rect and throws from an event handler nobody awaits. A
 * `MouseEvent`-based shim carries the coordinates the handlers expect.
 */
function pointerEventShim(mouseEvent: typeof MouseEvent): typeof PointerEvent {
  return class PointerEvent extends mouseEvent {
    public readonly pointerId: number
    public readonly pointerType: string
    public readonly isPrimary: boolean

    public constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 1
      this.pointerType = init.pointerType ?? 'mouse'
      this.isPrimary = init.isPrimary ?? true
    }
  } as unknown as typeof PointerEvent
}

/** Give the current window (whoever created it) a usable `PointerEvent`. */
export function installPointerEvent(): void {
  const target = globalThis as typeof globalThis & { window?: Window & typeof globalThis }
  const win = target.window
  if (!win || typeof win.MouseEvent !== 'function') return
  const existing = (win as Window & { PointerEvent?: typeof PointerEvent }).PointerEvent
  const shim = existing ?? pointerEventShim(win.MouseEvent)
  Object.defineProperty(win, 'PointerEvent', { value: shim, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'PointerEvent', { value: shim, configurable: true, writable: true })
}

installPointerEvent()

if (typeof window === 'undefined' || typeof document === 'undefined') {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://app.example/',
  })
  const win = dom.window
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    HTMLButtonElement: win.HTMLButtonElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    HTMLAnchorElement: win.HTMLAnchorElement,
    Node: win.Node,
    Event: win.Event,
    KeyboardEvent: win.KeyboardEvent,
    MouseEvent: win.MouseEvent,
    CustomEvent: win.CustomEvent,
    MutationObserver: win.MutationObserver,
    getComputedStyle: win.getComputedStyle.bind(win),
    localStorage: win.localStorage,
    sessionStorage: win.sessionStorage,
  })
}
