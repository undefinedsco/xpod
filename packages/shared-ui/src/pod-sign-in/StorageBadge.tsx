import { Cloud, Laptop } from 'lucide-react'
import type { StorageLocationKind } from './types'

export interface StorageBadgeProps {
  kind: StorageLocationKind
  /** Announced by screen readers and shown on hover. */
  label: string
}

/** Avatar corner badge: neutral icon for where the data lives (cloud or edge). */
export function StorageBadge({ kind, label }: StorageBadgeProps) {
  const Icon = kind === 'cloud' ? Cloud : Laptop
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-storage-kind={kind}
      className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-background bg-card text-foreground"
    >
      <Icon aria-hidden="true" className="h-3 w-3" />
    </span>
  )
}
