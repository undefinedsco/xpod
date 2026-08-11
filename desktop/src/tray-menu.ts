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

export interface TrayIdentity {
  label: string
  webId?: string
  podUrl?: string
}

export function normalizeTrayIdentity(value: unknown, targetOrigin: string): TrayIdentity | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as { label?: unknown; webId?: unknown; podUrl?: unknown }
  if (typeof candidate.label !== 'string') return undefined

  const label = Array.from(candidate.label, (character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint < 0x20
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x2069)
      ? ' '
      : character
  }).join('').replace(/\s+/g, ' ').trim()
  const boundedLabel = Array.from(label).slice(0, 80).join('').trim()
  if (!boundedLabel) return undefined

  const webId = normalizeIdentityUrl(candidate.webId, targetOrigin)
  const podUrl = normalizeIdentityUrl(candidate.podUrl, targetOrigin)
  if ((candidate.webId !== undefined && !webId) || (candidate.podUrl !== undefined && !podUrl)) {
    return undefined
  }
  return {
    label: boundedLabel,
    ...(webId ? { webId } : {}),
    ...(podUrl ? { podUrl } : {}),
  }
}

function normalizeIdentityUrl(value: unknown, targetOrigin: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 2_048) return undefined
  try {
    const url = new URL(value)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username
      || url.password
      || url.origin !== targetOrigin
    ) return undefined
    return url.toString()
  } catch {
    return undefined
  }
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
  identity?: TrayIdentity
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
  )
  if (identity?.podUrl) {
    items.push({ label: 'Open Pod', action: { type: 'open-pod' } })
  }
  items.push(
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

  items.push(separator())
  if (identity) {
    items.push({ label: `Signed in as ${identity.label}`, enabled: false })
  }
  items.push({ label: 'Account…', action: { type: 'open-route', route: '/status/overview?account=open' } })

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
