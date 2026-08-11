export const XPOD_TRAY_SERVICES = ['gateway', 'css', 'api'] as const

export type TrayServiceName = (typeof XPOD_TRAY_SERVICES)[number]
export type TrayServiceStatus = 'stopped' | 'starting' | 'running' | 'crashed'
export type TrayAggregateState = 'healthy' | 'starting' | 'degraded' | 'failed' | 'stopped'

export interface TrayServiceSnapshot {
  name: TrayServiceName | string
  status: TrayServiceStatus
}

export interface TrayAggregateStatus {
  state: TrayAggregateState
  running: number
  total: 3
}

export type TrayMenuAction =
  | { type: 'open-xpod' }
  | { type: 'open-pod' }
  | { type: 'open-route'; route: string }
  | { type: 'refresh' }
  | { type: 'restart' }
  | { type: 'start' }
  | { type: 'toggle-launch-at-login' }
  | { type: 'about' }
  | { type: 'quit' }

export interface TrayMenuItemModel {
  type?: 'separator'
  label?: string
  enabled?: boolean
  checked?: boolean
  action?: TrayMenuAction
}

export interface TrayMenuModel {
  aggregate: TrayAggregateStatus
  tooltip: string
  items: TrayMenuItemModel[]
}

const servicePresentation: Record<TrayServiceName, { label: string; route: string }> = {
  gateway: { label: 'Gateway', route: '/status/services/gateway' },
  css: { label: 'Solid Server', route: '/status/services/solid-server' },
  api: { label: 'API Server', route: '/status/services/api-server' },
}

export function aggregateTrayStatus(snapshots: readonly TrayServiceSnapshot[]): TrayAggregateStatus {
  const services = normalizedServices(snapshots)
  const statuses = services.map((service) => service.status)
  const running = statuses.filter((status) => status === 'running').length

  if (statuses.includes('crashed')) return { state: 'failed', running, total: 3 }
  if (statuses.includes('starting')) return { state: 'starting', running, total: 3 }
  if (running === 3) return { state: 'healthy', running, total: 3 }
  if (running === 0 && statuses.every((status) => status === 'stopped')) {
    return { state: 'stopped', running, total: 3 }
  }
  return { state: 'degraded', running, total: 3 }
}

export function buildTrayMenuModel({
  services,
  launchAtLogin,
  identity,
}: {
  services: readonly TrayServiceSnapshot[]
  launchAtLogin: boolean
  identity?: { label: string }
}): TrayMenuModel {
  const normalized = normalizedServices(services)
  const aggregate = aggregateTrayStatus(normalized)
  const items: TrayMenuItemModel[] = [
    { label: aggregateLabel(aggregate.state), enabled: false },
    { label: `${aggregate.running}/${aggregate.total} services running`, enabled: false },
    separator(),
    ...normalized.map(serviceMenuItem),
  ]

  const crashed = normalized.find((service) => service.status === 'crashed')
  if (crashed) {
    const presentation = servicePresentation[crashed.name]
    items.push({
      label: `Open ${presentation.label} Logs`,
      action: { type: 'open-route', route: `/status/logs?source=${encodeURIComponent(crashed.name)}` },
    })
  }

  items.push(
    separator(),
    { label: 'Open Xpod', action: { type: 'open-xpod' } },
    { label: 'Open Pod', action: { type: 'open-pod' } },
    separator(),
    { label: 'Status', action: { type: 'open-route', route: '/status/overview' } },
    { label: 'Network', action: { type: 'open-route', route: '/network' } },
    { label: 'AI Config', action: { type: 'open-route', route: '/ai-config/model-assignments' } },
    { label: 'Settings', action: { type: 'open-route', route: '/settings/pod' } },
    separator(),
    { label: 'Check Status Again', action: { type: 'refresh' } },
    {
      label: aggregate.state === 'stopped' ? 'Start Xpod' : 'Restart Xpod…',
      action: { type: aggregate.state === 'stopped' ? 'start' : 'restart' },
    },
  )

  if (identity) {
    items.push(
      separator(),
      { label: `Signed in as ${identity.label}`, enabled: false },
      { label: 'Account…', action: { type: 'open-route', route: '/status/overview?account=open' } },
    )
  }

  items.push(
    separator(),
    { label: 'Launch at Login', checked: launchAtLogin, action: { type: 'toggle-launch-at-login' } },
    { label: 'About Xpod', action: { type: 'about' } },
    { label: 'Quit Xpod', action: { type: 'quit' } },
  )

  return {
    aggregate,
    tooltip: `Xpod · ${aggregate.running}/${aggregate.total} services running`,
    items,
  }
}

function normalizedServices(snapshots: readonly TrayServiceSnapshot[]): Array<{ name: TrayServiceName; status: TrayServiceStatus }> {
  return XPOD_TRAY_SERVICES.map((name) => ({
    name,
    status: snapshots.find((snapshot) => snapshot.name === name)?.status ?? 'stopped',
  }))
}

function serviceMenuItem(service: { name: TrayServiceName; status: TrayServiceStatus }): TrayMenuItemModel {
  const presentation = servicePresentation[service.name]
  return {
    label: `${statusMark(service.status)} ${presentation.label} — ${statusLabel(service.status)}`,
    action: { type: 'open-route', route: presentation.route },
  }
}

function aggregateLabel(state: TrayAggregateState): string {
  switch (state) {
    case 'healthy': return '● Xpod healthy'
    case 'starting': return '◌ Xpod starting…'
    case 'degraded': return '▲ Xpod degraded'
    case 'failed': return '▲ Xpod failed'
    case 'stopped': return '○ Xpod stopped'
  }
}

function statusMark(status: TrayServiceStatus): string {
  switch (status) {
    case 'running': return '●'
    case 'starting': return '◌'
    case 'crashed': return '▲'
    case 'stopped': return '○'
  }
}

function statusLabel(status: TrayServiceStatus): string {
  switch (status) {
    case 'running': return 'Running'
    case 'starting': return 'Starting'
    case 'crashed': return 'Crashed'
    case 'stopped': return 'Stopped'
  }
}

function separator(): TrayMenuItemModel {
  return { type: 'separator' }
}
