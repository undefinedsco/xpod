import type { ReactNode } from 'react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@undefineds.co/shared-ui'
import { Info } from 'lucide-react'

/**
 * The ⓘ affordance that explains a provider-style page.
 *
 * It owns its `TooltipProvider` on purpose. Radix keeps one "pointer in transit"
 * flag per provider, and every trigger inside that provider ignores pointer
 * moves while the flag is set. Sharing a provider with the model list below the
 * header meant that leaving a capability glyph silently swallowed the next hover
 * of the ⓘ, so it never opened on the pages whose catalog carries capability
 * metadata. An island per ⓘ keeps that state out of everyone else's way.
 */
export function AiInfoTooltip({ label, lines }: { label: string; lines: ReactNode[] }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className="cursor-help rounded-sm text-muted-foreground/50 focus:outline-none focus-visible:text-foreground"
          >
            <Info aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs space-y-2 text-xs">
          {lines.map((line, index) => <p key={index}>{line}</p>)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
