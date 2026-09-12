import type { ReactNode } from 'react'
import { Button, Tooltip, TooltipContent, TooltipTrigger, cn } from '@undefineds.co/shared-ui'
import { Pause, Pencil, Play, PlugZap, Trash2 } from 'lucide-react'
import type { AiProviderCredentialSummary } from './ai-connections-client'
import { credentialDisplayLabel, healthLabel, healthTone } from './credential-labels'

export function AiCredentialRow({
  credential,
  label,
  busy,
  disabled,
  dragHandle,
  kindLabel,
  quota,
  onToggle,
  onTest,
  onEdit,
  onDelete,
  deleteAriaLabel,
}: {
  credential: AiProviderCredentialSummary
  label: string
  busy: boolean
  disabled: boolean
  dragHandle?: ReactNode
  kindLabel?: string
  quota?: ReactNode
  onToggle?: (credential: AiProviderCredentialSummary, patch: { enabled?: boolean }) => void
  onTest?: (credential: AiProviderCredentialSummary) => void
  onEdit?: () => void
  onDelete?: () => void
  deleteAriaLabel?: string
}) {
  const actionDisabled = disabled || busy
  const tone = healthTone(credential.health)
  const stateLabel = `${credential.enabled ? '已启用' : '已停用'} · ${healthLabel(credential.health)}`
  return (
    <div
      data-credential-state={credential.enabled ? 'enabled' : 'disabled'}
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2.5 transition-colors',
        credential.enabled ? tone.row : 'border-border/50 bg-muted/40 opacity-70',
      )}
    >
      {dragHandle}
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            aria-label={stateLabel}
            className={cn(
              'h-2 w-2 shrink-0 rounded-full',
              credential.enabled ? tone.dot : 'bg-muted-foreground/40',
            )}
          />
        </TooltipTrigger>
        <TooltipContent className="text-xs">{stateLabel}</TooltipContent>
      </Tooltip>
      <div className="min-w-0 flex-1 basis-24">
        <p className="truncate text-sm font-medium text-foreground">{label}</p>
        {kindLabel ? <p className="text-xs text-muted-foreground">{kindLabel}</p> : null}
        {credential.maskedHint && !label.includes(credential.maskedHint)
          ? <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{credential.maskedHint}</p>
          : null}
      </div>
      <div className="order-last w-full min-w-0 sm:order-none sm:w-auto sm:max-w-[45%]" role="group" aria-label={`${credentialDisplayLabel(credential)}额度`}>{quota}</div>
      <div className="flex shrink-0 items-center gap-1">
        {onTest ? (
          <RowAction label={`测试连接 ${label}`} disabled={actionDisabled} onClick={() => onTest(credential)}>
            <PlugZap aria-hidden="true" className="h-3.5 w-3.5" />
          </RowAction>
        ) : null}
        {onEdit ? (
          <RowAction label={`编辑 ${label}`} disabled={actionDisabled} onClick={onEdit}>
            <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
          </RowAction>
        ) : null}
        {onToggle ? (
          <RowAction
            label={`${credential.enabled ? '停用' : '启用'} ${label}`}
            disabled={actionDisabled}
            onClick={() => onToggle(credential, { enabled: !credential.enabled })}
          >
            {credential.enabled
              ? <Pause aria-hidden="true" className="h-3.5 w-3.5" />
              : <Play aria-hidden="true" className="h-3.5 w-3.5" />}
          </RowAction>
        ) : null}
        {onDelete ? (
          <RowAction label={deleteAriaLabel ?? `删除 ${label}`} disabled={actionDisabled} onClick={onDelete}>
            <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
          </RowAction>
        ) : null}
      </div>
    </div>
  )
}

function RowAction({
  label,
  disabled,
  onClick,
  children,
}: {
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
