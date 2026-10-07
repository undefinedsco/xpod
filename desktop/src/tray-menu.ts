import { formatUpdateProgress } from './self-updater.js'
import type { DesktopUpdateProgress } from './update-manager.js'

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

export interface TrayUpdateState {
  status: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'not-available' | 'downloaded' | 'error'
  version?: string
  message?: string
  progress?: DesktopUpdateProgress
  downloadPath?: string
}

export type TrayMenuAction =
  | { type: 'open-xpod' }
  | { type: 'copy-webid' }
  | { type: 'decide-approval'; approvalId: string; decision: 'approved' | 'rejected'; route: string }
  | { type: 'stop' }
  | { type: 'open-pod' }
  | { type: 'open-route'; route: string }
  | { type: 'refresh' }
  | { type: 'restart' }
  | { type: 'start' }
  | { type: 'toggle-launch-at-login' }
  | { type: 'check-update' }
  | { type: 'install-update' }
  | { type: 'reveal-update' }
  | { type: 'open-release-download' }
  | { type: 'about' }
  | { type: 'quit' }

export interface TrayMenuItemModel {
  type?: 'separator'
  label?: string
  enabled?: boolean
  checked?: boolean
  action?: TrayMenuAction
  submenu?: TrayMenuItemModel[]
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

export function normalizeTrayIdentity(value: unknown, _targetOrigin?: string): TrayIdentity | undefined {
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

  const webId = normalizeIdentityUrl(candidate.webId)
  const podUrl = normalizeIdentityUrl(candidate.podUrl)
  if ((candidate.webId !== undefined && !webId) || (candidate.podUrl !== undefined && !podUrl)) {
    return undefined
  }
  return {
    label: boundedLabel,
    ...(webId ? { webId } : {}),
    ...(podUrl ? { podUrl } : {}),
  }
}

function normalizeIdentityUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 2_048 || /[\x00-\x20\x7f-\x9f]/.test(value)) return undefined
  try {
    const url = new URL(value)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username
      || url.password
    ) return undefined
    return url.toString()
  } catch {
    return undefined
  }
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

export interface TrayAttentionItem { id: string; title: string; href: string; kind?: string; approvalId?: string }
export interface TrayProgressItem { id: string; title: string; href: string }

export function buildTrayMenuModel({ services, identity, update, attention = [], inProgress = [], localOnly = false }: {
  services: readonly TrayServiceSnapshot[]
  launchAtLogin?: boolean
  identity?: TrayIdentity
  update?: TrayUpdateState
  attention?: readonly TrayAttentionItem[]
  inProgress?: readonly TrayProgressItem[]
  localOnly?: boolean
}): TrayMenuModel {
  const aggregate = aggregateTrayStatus(services)
  const status = aggregate.state === 'stopped' ? '已停止' : aggregate.state === 'starting' ? '启动中' : aggregate.state === 'failed' ? '运行异常' : localOnly || aggregate.state === 'degraded' ? '仅本机可用' : '运行中'
  const items: TrayMenuItemModel[] = [
    identity ? { label: `${identity.label}${identity.webId ? ` · ${identity.webId}` : ''}`, enabled: Boolean(identity.webId), action: identity.webId ? { type: 'copy-webid' } : undefined } : { label: '登录', action: { type: 'open-xpod' } },
    { label: status, enabled: false },
  ]
  if (attention.length) items.push(separator(), { label: '需要你处理', enabled: false }, ...attention.slice(0, 3).map((item): TrayMenuItemModel => item.kind === 'approval' && item.approvalId ? { label: item.title, submenu: [
    { label: '查看申请', action: { type: 'open-route', route: item.href } },
    { label: '允许', action: { type: 'decide-approval', approvalId: item.approvalId, decision: 'approved', route: item.href } },
    { label: '拒绝', action: { type: 'decide-approval', approvalId: item.approvalId, decision: 'rejected', route: item.href } },
  ] } : { label: item.title, action: { type: 'open-route', route: item.href } }), { label: '全部查看 ›', action: { type: 'open-route', route: '/tasks?attention=open' } })
  if (inProgress.length) items.push(separator(), { label: '进行中', enabled: false }, ...inProgress.slice(0, 3).map((item): TrayMenuItemModel => ({ label: item.title, action: { type: 'open-route', route: item.href } })))
  items.push(separator(), { label: '打开 Xpod', action: { type: 'open-xpod' } }, separator(),
    aggregate.state === 'stopped' ? { label: '启动 Xpod', action: { type: 'start' } } : { label: '停止 Xpod', action: { type: 'stop' } },
    ...updateMenuItems(update), { label: '关于 Xpod', action: { type: 'about' } }, { label: '退出 Xpod', action: { type: 'quit' } })
  return { aggregate, tooltip: `Xpod · ${status}${attention.length ? ` · ${attention.length} 项需要处理` : ''}`, items }
}

/** Only same-product paths and bounded plain labels may enter the native menu. */
export function normalizeTrayAttention(value: unknown): { attention: TrayAttentionItem[]; inProgress: TrayProgressItem[] } {
  if (!value || typeof value !== 'object') return { attention: [], inProgress: [] }
  const snapshot = value as Record<string, unknown>
  const normalize = (rows: unknown): TrayAttentionItem[] => !Array.isArray(rows) ? [] : rows.slice(0, 100).flatMap((row: unknown) => {
    if (!row || typeof row !== 'object') return []
    const item = row as Record<string, unknown>
    if (typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.href !== 'string' || !/^\/(?!\/)/.test(item.href) || /[\\\r\n]/.test(item.href)) return []
    const title = item.title.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, 160)
    return title ? [{ id: item.id.slice(0, 200), title, href: item.href.slice(0, 2048), ...(item.kind === 'approval' && typeof item.approvalId === 'string' && item.approvalId.length <= 2048 && !/[\x00-\x1f\x7f]/.test(item.approvalId) ? { kind: 'approval', approvalId: item.approvalId } : {}) }] : []
  })
  return { attention: normalize(snapshot.attention), inProgress: normalize(snapshot.inProgress) }
}

function normalizedServices(snapshots: readonly TrayServiceSnapshot[]): Array<{ name: TrayServiceName; status: TrayServiceStatus }> {
  return XPOD_TRAY_SERVICES.map((name) => ({
    name,
    status: snapshots.find((snapshot) => snapshot.name === name)?.status ?? 'stopped',
  }))
}

function separator(): TrayMenuItemModel {
  return { type: 'separator' }
}

function updateMenuItems(update: TrayUpdateState | undefined): TrayMenuItemModel[] {
  if (!update || update.status === 'disabled') return []
  const reveal: TrayMenuItemModel[] = update.downloadPath ? [{ label: '显示更新包…', action: { type: 'reveal-update' } }] : []
  switch (update.status) {
    case 'idle':
      return [{ label: '检查更新…', action: { type: 'check-update' } }]
    case 'checking':
      return [{ label: '正在检查更新…', enabled: false }]
    case 'available':
      return [{
        label: update.version ? `正在下载 Xpod ${update.version}…` : '正在下载更新…',
        enabled: false,
      }]
    case 'downloading':
      return [{ label: `${update.version ? `正在下载 Xpod ${update.version}…` : '正在下载更新…'} ${update.progress ? formatUpdateProgress(update.progress).replace(' of ', ' / ') : '正在开始…'}`, enabled: false }]
    case 'not-available':
      return [
        { label: '已是最新版本', enabled: false },
        { label: '重新检查更新', action: { type: 'check-update' } },
      ]
    case 'downloaded':
      return [{
        label: update.version ? `重启并安装 Xpod ${update.version}` : '重启并安装更新',
        action: { type: 'install-update' },
      }, ...reveal]
    case 'error':
      return [
        {
          label: '更新失败',
          enabled: false,
        },
        ...reveal,
        { label: '下载最新版 Xpod…', action: { type: 'open-release-download' } },
        { label: '重新检查更新', action: { type: 'check-update' } },
      ]
  }
}
