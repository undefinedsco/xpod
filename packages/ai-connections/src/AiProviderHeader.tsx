import type { ReactNode } from 'react'
import {
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
  badge?: ReactNode
}) {
  return (
    <header className="flex items-start justify-between gap-4">
      <div className="flex items-center gap-3">
        <Avatar
          className="h-9 w-9 shrink-0 rounded-lg border border-border/50 bg-muted/50 shadow-sm"
          style={avatarBackground ? { backgroundColor: avatarBackground } : undefined}
        >
          <AvatarImage src={avatar} className="object-cover" />
          <AvatarFallback className="rounded-lg bg-transparent text-sm font-bold uppercase text-muted-foreground">
            {mark}
          </AvatarFallback>
        </Avatar>
        <div className="flex flex-col justify-center gap-0.5">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold leading-none tracking-tight text-foreground">{name}</h2>
            <AiInfoTooltip label={infoLabel} lines={infoLines} />
          </div>
          <a
            href={link.href}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-0.5 text-[10px] leading-none text-muted-foreground transition-colors hover:text-primary"
          >
            {link.label} <ExternalLink aria-hidden="true" className="h-2.5 w-2.5" />
          </a>
        </div>
      </div>
      {badge}
    </header>
  )
}
