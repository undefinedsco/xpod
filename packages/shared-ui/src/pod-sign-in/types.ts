import type { ReactNode } from 'react'

export type SignInPresentation = 'window' | 'dialog' | 'page'

/** Application-side source mark. The component never hard-codes an application. */
export interface AppIdentity {
  name: string
  icon?: ReactNode
}

/** Where a Pod lives: Xpod Cloud, or an edge device (this computer, a NAS...). */
export type StorageLocationKind = 'cloud' | 'edge'

export interface StorageLocation {
  kind: StorageLocationKind
  /** Announced by screen readers and shown on hover. */
  label: string
}
