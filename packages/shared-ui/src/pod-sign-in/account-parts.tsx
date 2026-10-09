import { Cloud, Laptop } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../utils'
import type { PodSignInCopy } from './copy'
import { Hostname } from './parts'
import type { StorageLocationKind } from './types'

/** ok = healthy; unreachable = other devices cannot reach it; stopped = device online, Xpod not running. */
export type DeviceStatus = 'ok' | 'unreachable' | 'stopped' | 'offline'

/** One place a Pod can live: Xpod Cloud, or an edge device. Presentation data only. */
export interface DeviceSummary {
  id: string
  name: string
  kind: StorageLocationKind
  /** e.g. `node-7f3a.undefineds.co` */
  address?: string
  podCount?: number
  status: DeviceStatus
  /** Overrides the default cloud / computer icon. */
  icon?: ReactNode
}

const statusDotClass: Record<DeviceStatus, string> = {
  ok: 'bg-success',
  unreachable: 'bg-warning',
  stopped: 'bg-muted-foreground',
  offline: 'bg-border',
}

export function deviceStatusLabel(status: DeviceStatus, copy: PodSignInCopy): string {
  switch (status) {
    case 'ok': return copy.deviceStatusOk
    case 'unreachable': return copy.deviceStatusUnreachable
    case 'stopped': return copy.deviceStatusStopped
    case 'offline': return copy.deviceStatusOffline
  }
}

export function deviceKindLabel(kind: StorageLocationKind, copy: PodSignInCopy): string {
  return kind === 'cloud' ? copy.deviceCloud : copy.deviceEdge
}

/** Icon, name, kind, address and a status dot with its word (never colour alone). */
export function DeviceIdentity({ device, copy, showStatus = true }: { device: DeviceSummary; copy: PodSignInCopy; showStatus?: boolean }) {
  const Icon = device.kind === 'cloud' ? Cloud : Laptop
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3 text-left" data-device-id={device.id}>
      <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
        {device.icon ?? <Icon className="h-4 w-4" />}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{device.name}</span>
          <span className="shrink-0 rounded bg-muted px-1.5 text-xs text-muted-foreground">{deviceKindLabel(device.kind, copy)}</span>
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {device.address ? <Hostname className="truncate">{device.address}</Hostname> : null}
          {device.podCount !== undefined ? <span>{copy.podCount.replace('{count}', String(device.podCount))}</span> : null}
          {showStatus ? (
            <span className="flex items-center gap-1">
              <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', statusDotClass[device.status])} />
              {deviceStatusLabel(device.status, copy)}
            </span>
          ) : null}
        </span>
      </span>
    </span>
  )
}

export const sectionClass = 'pod-sign-in flex flex-col gap-3 text-foreground'
export const listRowClass = 'flex min-h-14 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2'
export const sectionTitleClass = 'text-[17px] font-semibold text-foreground'

/** Section title row: an 18px icon, the title, and one sentence saying what the section is for. */
export function SectionHeader({ id, icon: Icon, title, hint, actions }: {
  id: string
  icon: LucideIcon
  title: string
  hint: string
  actions?: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2">
        <Icon aria-hidden="true" className="mt-0.5 h-[18px] w-[18px] shrink-0 text-primary" />
        <div className="min-w-0">
          <h2 id={id} className={sectionTitleClass}>{title}</h2>
          <p className="text-[13px] text-muted-foreground">{hint}</p>
        </div>
      </div>
      {actions}
    </div>
  )
}
