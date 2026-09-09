import type { TrayAggregateState } from './tray-menu.js'

/** Stable identity lets macOS preserve the user's chosen menu-bar position. */
export const XPOD_TRAY_GUID = '5e58d7b4-bf0d-4a0c-83a8-6bb48c2d7dc4'

/**
 * Return the base macOS template asset.
 *
 * Electron discovers the adjacent `@2x` representation only when the base
 * path is loaded. Loading the `@2x` file directly leaves the status item with
 * no 1x representation and can make it disappear when the menu bar moves to a
 * non-Retina display.
 */
export function trayIconAssetName(state: TrayAggregateState): string {
  return `tray-${state}Template.png`
}
