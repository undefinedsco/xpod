import { type ReactNode } from 'react'
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@undefineds.co/shared-ui'

/**
 * One icon action on a list row, carrying its own tooltip.
 *
 * Model rows and credential rows offer the same kind of trailing actions, so
 * the button shape, its 28px hit area and the tooltip that names the action are
 * defined once here instead of being re-built per row type.
 */
export function AiRowAction({
  label,
  disabled,
  onClick,
  children,
}: {
  /** Also the accessible name and the tooltip text. */
  label: string
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="text-xs">{label}</TooltipContent>
    </Tooltip>
  )
}
