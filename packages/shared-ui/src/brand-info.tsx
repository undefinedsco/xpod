import * as React from 'react'
import { Info } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipPortal, TooltipProvider, TooltipTrigger } from './tooltip'
import { cn } from './utils'
import { buttonFocusClass } from './focus'

export interface BrandInfoProps {
  logo: React.ReactNode
  info?: React.ReactNode
  infoLabel?: string
  className?: string
}

/** A host-provided brand with optional, progressively disclosed details. */
export function BrandInfo({ logo, info, infoLabel = 'Details', className }: BrandInfoProps) {
  const [open, setOpen] = React.useState(false)
  const triggerRef = React.useRef<HTMLButtonElement>(null)

  return (
    <div className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      {logo}
      {info != null && info !== false ? (
        <TooltipProvider delayDuration={150}>
          <Tooltip open={open} onOpenChange={setOpen}>
            <TooltipTrigger asChild>
              <button
                ref={triggerRef}
                type="button"
                aria-label={infoLabel}
                aria-expanded={open}
                className={`inline-flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-primary/10 hover:text-primary focus-visible:bg-primary/10 focus-visible:text-primary ${buttonFocusClass}`}
                onPointerDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  // Preserve click/touch toggling instead of Radix's close-on-click default.
                  event.preventDefault()
                  setOpen((value) => !value)
                }}
              >
                <Info className="h-4 w-4" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent
                side="bottom"
                align="center"
                collisionPadding={12}
                onPointerDownOutside={(event) => {
                  // The trigger's subsequent click owns toggling; dismissing here would reopen it.
                  if (event.target instanceof Node && triggerRef.current?.contains(event.target)) event.preventDefault()
                }}
                className="max-w-[min(320px,calc(100vw-24px))] space-y-2 p-3 text-left leading-relaxed [overflow-wrap:anywhere]"
              >
                {info}
              </TooltipContent>
            </TooltipPortal>
          </Tooltip>
        </TooltipProvider>
      ) : null}
    </div>
  )
}
