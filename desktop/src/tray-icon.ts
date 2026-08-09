import type { TrayAggregateState } from './tray-menu.js'

export function trayIconAssetName(state: TrayAggregateState, retina: boolean): string {
  return `tray-${state}Template${retina ? '@2x' : ''}.png`
}
