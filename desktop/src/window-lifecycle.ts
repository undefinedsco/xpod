export interface WindowCloseEvent {
  preventDefault(): void
}

export interface WindowLifecycleWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  isFocused(): boolean
  show(): void
  hide(): void
  focus(): void
  on(event: 'closed', listener: () => void): unknown
}

export interface EnsureWindowOptions {
  focus?: boolean
}

/**
 * Owns the one currently presented desktop window without owning the app.
 *
 * A user closing the window is deliberately different from quitting Xpod.
 * Match LinX/macOS tray semantics: hide the existing BrowserWindow so its
 * renderer and two live auth sessions remain intact. Only the explicit quit
 * path lets Electron close the window and stop the owned runtime.
 */
export class WindowLifecycle<W extends WindowLifecycleWindow> {
  private current: W | null = null
  private quitting = false

  public constructor(private readonly create: () => W) {}

  public currentWindow(): W | null {
    return this.current
  }

  public isQuitting(): boolean {
    return this.quitting
  }

  public markQuitting(): void {
    this.quitting = true
  }

  /** Hide the retained UI surface while keeping the desktop host alive. */
  public hideWindow(): void {
    const current = this.current
    if (!current || current.isDestroyed()) return
    current.hide()
  }

  public ensureWindow({ focus = true }: EnsureWindowOptions = {}): W {
    const current = this.current
    if (current && !current.isDestroyed()) {
      // Electron/macOS can retain stale visibility and focus flags after the
      // last app window is hidden. Re-presenting an already visible window is
      // idempotent, so always ask the native window to show and focus when the
      // user opens Xpod from the Dock, tray, or a second launch.
      current.show()
      if (focus) current.focus()
      return current
    }

    const created = this.create()
    this.current = created
    created.on('closed', () => {
      // Electron can deliver a delayed `closed` event after a replacement
      // window has already been created. Never clear the replacement.
      if (this.current === created) this.current = null
    })
    return created
  }

  public handleClose(window: W, event: WindowCloseEvent): void {
    if (this.quitting) return
    event.preventDefault()
    window.hide()
  }

  public handleActivate(): W {
    return this.ensureWindow()
  }

  public handleTrayOpen(): W {
    return this.ensureWindow()
  }

  public handleSecondInstance(): W {
    return this.ensureWindow()
  }
}
