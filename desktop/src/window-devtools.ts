import type { DesktopWindowMode } from './window-mode.js'

export interface DesktopDevToolsInput {
  key?: string
  control?: boolean
  meta?: boolean
  alt?: boolean
  shift?: boolean
}

export interface DesktopDevToolsEvent {
  preventDefault(): void
}

export interface DesktopDevToolsWebContents {
  isDevToolsOpened(): boolean
  closeDevTools(): void
  on(event: 'devtools-opened', listener: () => void): unknown
  on(event: 'before-input-event', listener: (event: DesktopDevToolsEvent, input: DesktopDevToolsInput) => void): unknown
}

export interface CompactWindowDevToolsGuard {
  sync(): void
}

export interface DesktopDevToolsMenu {
  items?: DesktopDevToolsMenuItem[]
}

export interface DesktopDevToolsMenuItem {
  id?: string
  label?: string
  role?: string
  enabled?: boolean
  submenu?: DesktopDevToolsMenu
}

export function installCompactWindowDevToolsGuard(
  webContents: DesktopDevToolsWebContents,
  currentMode: () => DesktopWindowMode | null,
): CompactWindowDevToolsGuard {
  const shouldBlockDevTools = (): boolean => isCompactDesktopWindowMode(currentMode())
  const sync = (): void => {
    if (shouldBlockDevTools() && webContents.isDevToolsOpened()) webContents.closeDevTools()
  }

  webContents.on('before-input-event', (event, input) => {
    if (!shouldBlockDevTools() || !isDesktopDevToolsShortcut(input)) return
    event.preventDefault()
    sync()
  })
  webContents.on('devtools-opened', sync)

  return { sync }
}

export function isCompactDesktopWindowMode(mode: DesktopWindowMode | null): boolean {
  return mode === 'auth' || mode === 'account'
}

export function isDesktopDevToolsShortcut(input: DesktopDevToolsInput): boolean {
  const key = input.key?.toUpperCase()
  if (key === 'F12') return true
  if (!key) return false
  if ((key === 'I' || key === 'J') && input.meta && input.alt) return true
  if (key === 'C' && input.meta && input.shift) return true
  if (!input.shift) return false
  if ((key === 'I' || key === 'J' || key === 'C') && input.control) return true
  return false
}

export function setDesktopDevToolsMenuEnabled(menu: DesktopDevToolsMenu | null, enabled: boolean): boolean {
  let changed = false
  for (const item of menu?.items ?? []) {
    if (isDesktopDevToolsMenuItem(item) && item.enabled !== enabled) {
      item.enabled = enabled
      changed = true
    }
    if (setDesktopDevToolsMenuEnabled(item.submenu ?? null, enabled)) changed = true
  }
  return changed
}

function isDesktopDevToolsMenuItem(item: DesktopDevToolsMenuItem): boolean {
  const role = item.role?.toLowerCase()
  if (role === 'toggledevtools') return true

  const id = item.id?.toLowerCase()
  if (id?.includes('devtools') || id?.includes('inspect')) return true

  const label = item.label?.replace(/&/g, '').toLowerCase()
  return label?.includes('developer tools') === true || label?.includes('inspect element') === true
}
