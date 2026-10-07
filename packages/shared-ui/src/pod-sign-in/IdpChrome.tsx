import type { ReactNode } from 'react'
import { resolvePodSignInCopy, type PodSignInLocale } from './copy'
import { XpodMark } from './XpodMark'

export interface IdpChromeProps {
  /** The sign-in service, e.g. "Xpod". */
  serviceName: string
  /** Shown in monospace; this row is what tells a user which service's page this is. */
  serviceHost?: string
  /** Defaults to the Xpod mark. */
  icon?: ReactNode
  /** Word after the name (default "账号服务" / "Sign-in service"). */
  serviceLabel?: string
  locale?: PodSignInLocale
}

/** Service identity stays readable above the form, even on a narrow host. */
export function IdpChrome({ serviceName, serviceHost, icon, serviceLabel, locale }: IdpChromeProps) {
  const label = serviceLabel ?? resolvePodSignInCopy(locale).serviceLabel
  return (
    <div
      data-pod-sign-in="idp-chrome"
      className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border bg-[hsl(var(--sunken))] px-6 py-2 text-[13px] text-foreground min-[400px]:px-8"
    >
      <span className="flex shrink-0 items-center justify-center">
        {icon ?? <XpodMark size={24} />}
      </span>
      <span className="min-w-0 max-w-[50%] shrink-0 truncate font-medium">{serviceName} · {label}</span>
      {serviceHost ? <span className="ml-auto truncate font-mono text-xs text-muted-foreground">{serviceHost}</span> : null}
    </div>
  )
}
