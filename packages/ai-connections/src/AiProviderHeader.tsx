import type { ReactNode } from 'react'
import {
  interactiveFocusClass,
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@undefineds.co/shared-ui'
import { ExternalLink } from 'lucide-react'
import { AiInfoTooltip } from './AiInfoTooltip'

export interface AiProviderHeaderLink {
  href: string
  label: string
}

/**
 * Header shared by every provider-style page: the provider pages and the Xpod
 * API KEYS page differ only in mark, copy, link and badge, so the mark/name/ⓘ
 * anatomy lives here once instead of being re-typed per page.
 */
export function AiProviderHeader({
  name,
  mark,
  avatar,
  avatarBackground,
  infoLabel,
  infoLines,
  link,
  links = [],
  badge,
}: {
  name: string
  /** Initials shown while (or instead of) the mark image. */
  mark: string
  avatar?: string
  avatarBackground?: string
  infoLabel: string
  infoLines: ReactNode[]
  link: AiProviderHeaderLink
  links?: AiProviderHeaderLink[]
  badge?: ReactNode
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar
          className="h-9 w-9 shrink-0 rounded-lg border border-border/50 bg-muted/50 shadow-sm"
          style={avatarBackground ? { backgroundColor: avatarBackground } : undefined}
        >
          <AvatarImage src={avatar} className="object-cover" />
          <AvatarFallback className="rounded-lg bg-transparent text-sm font-bold uppercase text-muted-foreground">
            {mark}
          </AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col justify-center gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="text-base font-semibold leading-none tracking-tight text-foreground">{name}</h2>
            <AiInfoTooltip label={infoLabel} lines={infoLines} />
          </div>
          <div role="group" aria-label={`${name}官方链接`} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {[link, ...links].map((item) => (
              <a
                key={item.href}
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                className={`inline-flex min-h-9 min-w-9 items-center gap-0.5 text-xs leading-normal text-muted-foreground transition-colors hover:text-primary ${interactiveFocusClass}`}
              >
                {item.label} <ExternalLink aria-hidden="true" className="h-2.5 w-2.5" />
              </a>
            ))}
          </div>
        </div>
      </div>
      {badge ? <div className="shrink-0 whitespace-nowrap">{badge}</div> : null}
    </header>
  )
}
