import { DisclosureSummary } from '@undefineds.co/shared-ui'
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Tooltip, TooltipContent, TooltipTrigger, cn } from '@undefineds.co/shared-ui'
import { AiRowAction } from './AiRowAction'
import { Pause, Pencil, Play, PlugZap, Trash2 } from 'lucide-react'
import type { AiProviderCredentialSummary, AiProviderOffering } from './contract/ai-connections-client'
import { credentialDisplayLabel, credentialFailurePresentation, healthLabel, healthTone } from './credential-labels'

export function AiCredentialRow({
  credential,
  offering,
  onReconnect,
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
  offering?: AiProviderOffering
  onReconnect?: () => void
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
  const [now, setNow] = useState(Date.now)
  const [showReason, setShowReason] = useState(false)
  useEffect(() => {
    const reset = credential.rateLimitResetAt ? new Date(credential.rateLimitResetAt).getTime() : 0
    if (reset <= Date.now() || !Number.isFinite(reset)) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(reset - Date.now() + 1, 2_147_483_647))
    return () => clearTimeout(timer)
  }, [credential.rateLimitResetAt])
  const failure = credentialFailurePresentation(credential, Math.max(now, Date.now()))
  const rechargeUrl = offering?.subscriptionUrl ?? offering?.consoleUrl
  const actionDisabled = disabled || busy
  const tone = healthTone(credential.health)
  const stateLabel = `${credential.enabled ? '已启用' : '已停用'} · ${healthLabel(credential.health)}`
  return (
    <div
      data-credential-state={credential.enabled ? 'enabled' : 'disabled'}
      className={cn(
        // The list owns the box and the dividers, so a row carries only its own
        // tint: `rounded-[inherit]` keeps the first and last tint inside the
        // container's corners.
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[inherit] px-4 py-3 transition-colors',
        credential.enabled ? tone.row : 'bg-muted/40 opacity-70',
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
      {failure ? (
        <div role="alert" className="order-last flex w-full flex-wrap items-center gap-2 text-sm text-destructive">
          <span>{failure.message}</span>
          {failure.action === 'key' || failure.action === 'login' ? <Button size="sm" variant="outline" disabled={actionDisabled}
            onClick={failure.action === 'key' ? onEdit : onReconnect}>
            {failure.action === 'key' ? '换一把 Key' : '重新登录'}
          </Button> : null}
          {failure.action === 'charge' && rechargeUrl ? <a href={rechargeUrl} target="_blank" rel="noreferrer" className="text-primary">去充值 ↗</a> : null}
          {failure.action === 'reason' ? <Button size="sm" variant="outline" onClick={() => setShowReason((value) => !value)}>查看原因</Button> : null}
          {showReason && failure.action === 'reason' ? <span className="w-full text-xs text-muted-foreground">服务商未允许这条连接访问所请求的模型，请在控制台检查模型权限和可用地区。</span> : null}
        </div>
      ) : null}
      <div className="flex shrink-0 items-center gap-1">
        {offering?.consoleUrl || offering?.subscriptionUrl ? <details className="relative text-sm">
          <DisclosureSummary aria-label={`${label} 更多操作`} className="cursor-pointer px-2 py-1">⋯</DisclosureSummary>
          <div className="absolute right-0 z-10 min-w-32 rounded-md border bg-popover p-2 shadow-md">
            {offering.consoleUrl ? <a className="block py-1" href={offering.consoleUrl} target="_blank" rel="noreferrer">控制台 ↗</a> : null}
            {offering.subscriptionUrl ? <a className="block py-1" href={offering.subscriptionUrl} target="_blank" rel="noreferrer">订阅与账单 ↗</a> : null}
          </div>
        </details> : null}
        {onTest ? (
          <AiRowAction label={`测试连接 ${label}`} disabled={actionDisabled} onClick={() => onTest(credential)}>
            <PlugZap aria-hidden="true" className="h-3.5 w-3.5" />
          </AiRowAction>
        ) : null}
        {onEdit ? (
          <AiRowAction label={`编辑 ${label}`} disabled={actionDisabled} onClick={onEdit}>
            <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
          </AiRowAction>
        ) : null}
        {onToggle ? (
          <AiRowAction
            label={`${credential.enabled ? '停用' : '启用'} ${label}`}
            disabled={actionDisabled}
            onClick={() => onToggle(credential, { enabled: !credential.enabled })}
          >
            {credential.enabled
              ? <Pause aria-hidden="true" className="h-3.5 w-3.5" />
              : <Play aria-hidden="true" className="h-3.5 w-3.5" />}
          </AiRowAction>
        ) : null}
        {onDelete ? (
          <AiRowAction label={deleteAriaLabel ?? `删除 ${label}`} disabled={actionDisabled} onClick={onDelete}>
            <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
          </AiRowAction>
        ) : null}
      </div>
    </div>
  )
}

