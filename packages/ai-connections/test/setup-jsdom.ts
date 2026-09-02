import { JSDOM } from 'jsdom'

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
