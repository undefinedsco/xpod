import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  LoginConnectingView,
  LoginFailureView,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from '@undefineds.co/shared-ui'
import {
  GripVertical,
  Eye,
  EyeOff,
  ExternalLink,
  KeyRound,
  Loader2,
  LogOut,
  Pause,
  Pencil,
  Play,
  PlugZap,
  Plus,
  RotateCw,
  Settings2,
  Trash2,
} from 'lucide-react'
import type {
  AiConnectAttempt,
  AiConnectionsMode,
  AiProviderAuthorizationMethod,
  AiProviderCredentialSummary,
  AiProviderOffering,
  AiProviderSummary,
  AiQuotaSnapshot,
} from './ai-connections-client'
import { normalizeProxyUrl } from './ai-connections-client'
import type {
  AiProviderDefinition,
} from './controller'
import type { ProviderConnectionState } from './AiProviderCard'
import { offeringTitle } from './offering-label'
import { AiQuotaCard } from './AiQuotaCard'

export interface AiOfferingActionError {
  message: string
  offeringId?: string
  authorization?: Pick<AiConnectAttempt, 'mode' | 'authorizationMethodId'>
}

export interface AiOfferingQuotaState {
  quota?: AiQuotaSnapshot
  busy: boolean
  error?: string
  credentialId?: string
}

export function AiCredentialPoolSection({
  definition,
  product,
  status,
  accountLabel,
  attempt,
  attemptOfferingId,
  apiKey,
  baseUrl = '',
  busy,
  disabled = false,
  error,
  suppressError = false,
  quotas = {},
  onApiKeyChange,
  onBaseUrlChange,
  onBeginApiKey,
  onBeginOffering,
  onCancelConnect,
  onBeginBrowser,
  onSaveApiKey,
  onDisconnect,
  onCreateApiKeyCredential,
  onCreateLocalCredential,
  onUpdateCredential,
  onDeleteCredential,
  onTestCredential,
  onReorderCredentials,
  onRefreshQuota,
  onDismissError,
}: {
  definition: AiProviderDefinition
  product?: AiProviderSummary
  status: ProviderConnectionState
  accountLabel?: string
  attempt?: AiConnectAttempt
  attemptOfferingId?: string
  apiKey: string
  baseUrl?: string
  busy: boolean
  disabled?: boolean
  error?: AiOfferingActionError
  suppressError?: boolean
  quotas?: Partial<Record<string, AiOfferingQuotaState>>
  onApiKeyChange: (value: string) => void
  onBaseUrlChange?: (value: string) => void
  onBeginApiKey: () => void
  onBeginOffering?: (offering: AiProviderOffering, mode: AiConnectionsMode, method?: AiProviderAuthorizationMethod) => void
  onCancelConnect?: (attempt: Pick<AiConnectAttempt, 'attemptId' | 'state' | 'signature' | 'offeringId'> & Partial<Pick<AiConnectAttempt, 'mode'>>) => void
  onBeginBrowser: () => void
  onSaveApiKey: () => void
  onDisconnect: (credential?: AiProviderCredentialSummary) => void
  onCreateApiKeyCredential?: (offering: AiProviderOffering, input: {
    apiKey: string
    label?: string
    baseUrl?: string
    proxyUrl?: string
    priority: number
  }) => Promise<void>
  onCreateLocalCredential?: (offering: AiProviderOffering, method?: AiProviderAuthorizationMethod) => Promise<void>
  onUpdateCredential?: (credential: AiProviderCredentialSummary, patch: {
    label?: string
    enabled?: boolean
    priority?: number
    baseUrl?: string
    proxyUrl?: string
  }) => Promise<void>
  onDeleteCredential?: (credential: AiProviderCredentialSummary) => void
  onTestCredential?: (credential: AiProviderCredentialSummary) => void
  onReorderCredentials?: (offering: AiProviderOffering, credentials: AiProviderCredentialSummary[], fromIndex: number, toIndex: number) => void
  onRefreshQuota?: (offering: AiProviderOffering, credential?: AiProviderCredentialSummary) => void
  onDismissError?: () => void
}) {
  const fallbackOfferings: AiProviderOffering[] = [{
    id: 'api-platform',
    label: 'API Key',
    kind: 'api-platform',
    authModes: ['apiKey'],
  }]
  const credentials = product?.credentials ?? []
  const offerings = product?.offerings.length ? product.offerings : fallbackOfferings

  const [editing, setEditing] = useState<AiProviderCredentialSummary>()
  const [showCreate, setShowCreate] = useState(false)
  const [authorizationOfferingId, setAuthorizationOfferingId] = useState<string>()
  const [dialogError, setDialogError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const completedAttemptRef = useRef(attempt)
  const apiOfferings = offerings.filter((offering) => authorizationMethodsForOffering(offering, definition).some((method) => method.lifecycle === 'active' && isApiKeyMethod(method)))
  const authorizationPending = isPendingAttempt(attempt) && isOAuthMode(attempt?.mode)
  const dialogOpen = showCreate || Boolean(editing) || Boolean(authorizationOfferingId)
  const closeDialog = () => {
    setShowCreate(false)
    setAuthorizationOfferingId(undefined)
    setEditing(undefined)
    setDialogError(undefined)
  }
  useEffect(() => {
    const previous = completedAttemptRef.current
    completedAttemptRef.current = attempt
    if (dialogOpen && attempt !== previous && attempt?.status === 'completed') closeDialog()
  }, [attempt, dialogOpen])
  const orderedCredentials = [...credentials].sort((a, b) => a.priority - b.priority)
  const quotaBusy = credentials.some((credential) => quotas[credential.id]?.busy)

  return (
    <TooltipProvider>
      <section className="space-y-3" aria-label="当前连接">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-medium text-foreground/90">
            <Settings2 className="h-4 w-4 text-primary" />当前连接
          </h3>
          <div className="flex flex-wrap items-center justify-end gap-2">
          {credentials.length > 1 ? (
            <Button variant="ghost" size="sm" aria-label={`刷新全部 ${definition.name}额度`}
              disabled={disabled || quotaBusy || !credentials.some((c) => c.enabled) || !onRefreshQuota}
              onClick={() => offerings.forEach((offering) => onRefreshQuota?.(offering))}>
              {quotaBusy ? '查询中' : '刷新全部额度'}
            </Button>
          ) : null}
          {offerings.map((offering) => {
            const methods = authorizationMethodsForOffering(offering, definition).filter((method) =>
              method.lifecycle === 'active' && (isOAuthMethod(method) || isLocalMethod(method)))
            if (!methods.length) return null
            return <div key={offering.id} role="group" aria-label={`${offeringTitle(offering)}快捷接入`}>
              <AuthorizationMethodActions methods={methods} offering={offering}
                hasCredentials={credentials.some((credential) => credential.offeringId === offering.id)}
                busy={busy || saving} disabled={disabled || authorizationPending}
                onBeginOffering={onBeginOffering ? (target, mode, method) => {
                  setDialogError(undefined)
                  onDismissError?.()
                  setAuthorizationOfferingId(target.id)
                  onBeginOffering(target, mode, method)
                } : undefined}
                onCreateLocalCredential={onCreateLocalCredential ? async (target, method) => {
                  setSaving(true)
                  setDialogError(undefined)
                  onDismissError?.()
                  try { await onCreateLocalCredential(target, method) }
                  catch (cause) { setDialogError(cause instanceof Error ? cause.message : '连接失败，请重试') }
                  finally { setSaving(false) }
                } : undefined} />
            </div>
          })}
          {apiOfferings.length > 0 && !offerings.some((offering) =>
            authorizationMethodsForOffering(offering, definition).some((method) =>
              method.lifecycle === 'active' && (isOAuthMethod(method) || isLocalMethod(method))))
            && definition.browserMode === 'browserAssistedApiKey' ? (
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" aria-label={`${definition.name} 登录`}
            disabled={busy || saving || disabled || authorizationPending} onClick={() => {
              setDialogError(undefined)
              onDismissError?.()
              onBeginBrowser()
            }}>
            <ExternalLink className="h-3.5 w-3.5" />{definition.browserLabel}
          </Button>
          ) : null}
          {apiOfferings.length > 0 ? (
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" aria-label="新建 API Key 连接" disabled={busy || saving || disabled || authorizationPending || (!product && status === 'pending' && !attempt)} onClick={() => {
            setDialogError(undefined)
            onDismissError?.()
            setShowCreate(true)
          }}><Plus className="h-3.5 w-3.5" />API Key</Button>
          ) : null}
          </div>
        </div>
        <div aria-label="凭据列表" className="space-y-2">
          <SortableCredentialList credentials={orderedCredentials} disabled={busy || disabled}
            onMove={onReorderCredentials ? (from, to) => {
              const offering = offerings.find((item) => item.id === orderedCredentials[from]?.offeringId)
              if (offering) onReorderCredentials(offering, orderedCredentials, from, to)
            } : undefined}>
            {(credential, handle) => {
              const offering = offerings.find((item) => item.id === credential.offeringId)
              if (!offering) return null
              const label = credential.authMode === 'apiKey' ? credentialDisplayLabel(credential)
                : credential.label ? maskAccountLabel(credential.label) : credentialDisplayLabel(credential)
              const state = quotas[credential.id]
              const quotaState = state?.credentialId === credential.id ? state : undefined
              return <CredentialRow credential={credential} label={label} dragHandle={handle}
                kindLabel={credential.authMode === 'apiKey' ? 'API Key' : offeringTitle(offering)}
                busy={busy} disabled={disabled} onToggle={onUpdateCredential} onTest={onTestCredential}
                onEdit={credential.authMode === 'apiKey' ? () => setEditing(credential) : undefined}
                onDelete={() => credential.authMode === 'apiKey' ? onDeleteCredential?.(credential) : onDisconnect(credential)}
                deleteAriaLabel={credential.authMode === 'apiKey' ? `删除 ${label}` : `${label} 移除`}
                quota={<AiQuotaCard compact providerName={definition.name} offeringName={offeringTitle(offering)}
                  credentialLabel={credentialDisplayLabel(credential)} multiple={credentials.length > 1}
                  quota={quotaState?.quota} busy={quotaState?.busy ?? false} error={quotaState?.error}
                  paused={!credential.enabled} disabled={disabled || !onRefreshQuota}
                  onRefresh={() => onRefreshQuota?.(offering, credential)} />} />
            }}
          </SortableCredentialList>
          {!credentials.length ? <p className="py-2 text-xs text-muted-foreground">{accountLabel ? maskAccountLabel(accountLabel) : '尚未添加连接'}</p> : null}
          {credentials.length === 0 && (status === 'configured' || status === 'connected') ? (
            <Button variant="ghost" size="sm" disabled={busy || disabled} onClick={() => onDisconnect()}>
              {status === 'configured' ? '移除配置' : '断开连接'}
            </Button>
          ) : null}
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => {
          if (open || saving) return
          if (attempt && isPendingAttempt(attempt) && isOAuthMode(attempt.mode)) {
            onCancelConnect?.({ mode: attempt.mode, attemptId: attempt.attemptId, state: attempt.state,
              signature: attempt.signature, ...(attempt.offeringId ? { offeringId: attempt.offeringId } : {}) })
          }
          closeDialog()
        }}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg" aria-describedby={undefined}>
            <DialogHeader><DialogTitle>{editing ? '编辑连接' : authorizationOfferingId ? '连接账号' : '新建连接'}</DialogTitle></DialogHeader>
        <div className="space-y-5" aria-label="添加连接">
          {(editing || authorizationOfferingId ? offerings.filter((offering) => offering.id === (editing?.offeringId ?? authorizationOfferingId)) : apiOfferings).map((offering) => {
            const otherAuthorizationPending = isPendingAttempt(attempt) && isOAuthMode(attempt?.mode)
              && (attemptOfferingId ?? attempt?.offeringId) !== offering.id
            const actionDisabled = disabled || saving || otherAuthorizationPending
            const methods = authorizationMethodsForOffering(offering, definition)
            const activeMethods = methods.filter((method) => method.lifecycle === 'active')
            const supportsApiKey = activeMethods.some(isApiKeyMethod)
            const offeringAttempt = attemptOfferingId === offering.id ? attempt : undefined
            const authorizationError = error?.offeringId === offering.id ? error.authorization : undefined
            const attemptedMethod = methods.find((method) => method.id === (authorizationError?.authorizationMethodId ?? offeringAttempt?.authorizationMethodId))
              ?? activeMethods.find(isOAuthMethod)
            const attemptedMode = authorizationError?.mode ?? offeringAttempt?.mode ?? (attemptedMethod ? connectModeForMethod(attemptedMethod) : modeForOffering(offering, definition))
            const offeringError = error?.offeringId === offering.id ? error.message : undefined
            if (offering.lifecycle === 'unavailable' && activeMethods.length === 0) {
              return <fieldset data-create-offering={offering.id} key={offering.id} className="space-y-2 border-t border-border/50 pt-3 first:border-t-0 first:pt-0">
                <legend className="px-1 text-sm font-medium">{offeringTitle(offering)}</legend>
                <p className="text-xs text-muted-foreground">{offering.kind === 'oauth-subscription'
                  ? '暂不可用：账号订阅需在 Xpod 桌面版中导入本机客户端（如 Codex CLI）的登录态，浏览器中无法完成。'
                  : '暂不可用：该接入方式尚未提供可用的连接流程。'}</p>
              </fieldset>
            }
            const failedAuthorizationMode = authorizationError?.mode
            if (offeringError && isOAuthMode(failedAuthorizationMode)) {
              return <fieldset data-create-offering={offering.id} key={offering.id} disabled={actionDisabled} className="space-y-3 border-t border-border/50 pt-3 first:border-t-0 first:pt-0" aria-label={`${offeringTitle(offering)}接入操作`}>
                <legend className="px-1 text-sm font-medium">{offeringTitle(offering)}</legend>
                {offeringAttempt?.status === 'unsupported'
                  ? <p className="text-sm">当前部署未启用账号授权</p>
                  : <LoginFailureView title="登录未完成" description={offeringError} primaryLabel="重试登录"
                      onPrimary={() => onBeginOffering?.(offering, failedAuthorizationMode, attemptedMethod)}
                      secondaryLabel="关闭" onSecondary={() => { onDismissError?.(); closeDialog() }} />}
              </fieldset>
            }
            if (isPendingAttempt(offeringAttempt) && isOAuthMode(attemptedMode)) {
              return <fieldset data-create-offering={offering.id} key={offering.id} disabled={actionDisabled} className="space-y-3 border-t border-border/50 pt-3 first:border-t-0 first:pt-0" aria-label={`${offeringTitle(offering)}接入操作`}>
                <legend className="px-1 text-sm font-medium">{offeringTitle(offering)}</legend>
                <LoginConnectingView title="正在连接"
                  detail={attemptedMode === 'authorizationCodeOAuth' ? '等待网页授权，请在打开的页面完成登录。' : offeringAttempt?.userCode ? `验证码：${offeringAttempt.userCode}` : '请在打开的页面完成授权。'}
                  providerLabel={attemptedMethod?.label ?? offeringTitle(offering)} providerHost={definition.name} />
                <Button variant="ghost" size="sm" disabled={disabled}
                  onClick={() => {
                    if (offeringAttempt) onCancelConnect?.({
                    mode: offeringAttempt.mode,
                    attemptId: offeringAttempt.attemptId,
                    state: offeringAttempt.state,
                    signature: offeringAttempt.signature,
                    ...(offeringAttempt.offeringId ? { offeringId: offeringAttempt.offeringId } : {}),
                    })
                    closeDialog()
                  }}>取消连接</Button>
              </fieldset>
            }
            return <fieldset data-create-offering={offering.id} key={offering.id} disabled={actionDisabled} className="space-y-3 border-t border-border/50 pt-3 first:border-t-0 first:pt-0" aria-label={`${offeringTitle(offering)}接入操作`}>
              <legend className="px-1 text-sm font-medium">{offeringTitle(offering)}</legend>
              {supportsApiKey ? <ApiKeyPool key={`${offering.id}:${editing?.id ?? ''}`}
                definition={definition} offering={offering} status={status}
                createOfferings={[offering]} initialCreate={!editing}
                credentials={credentials} initialEditing={editing?.offeringId === offering.id ? editing : undefined}
                onCloseEdit={closeDialog} onSavingChange={setSaving}
                attempt={offeringAttempt ?? (attempt?.mode === 'browserAssistedApiKey' ? attempt : undefined)}
                apiKey={apiKey} baseUrl={baseUrl} busy={busy} disabled={actionDisabled}
                onApiKeyChange={onApiKeyChange} onBaseUrlChange={onBaseUrlChange}
                onBeginApiKey={onBeginApiKey} onBeginBrowser={onBeginBrowser} onSaveApiKey={onSaveApiKey}
                onDisconnect={onDisconnect} onUpdateCredential={onUpdateCredential}
                onCreateApiKeyCredential={onCreateApiKeyCredential} /> : null}
              {authorizationOfferingId && !offeringError ? <LoginConnectingView title="正在连接"
                detail="正在启动授权，请稍候。" providerLabel={offeringTitle(offering)} providerHost={definition.name} /> : null}
              {offeringError ? <p className="w-full text-sm text-destructive">{offeringError}</p> : null}
            </fieldset>
          })}
        </div>
            {dialogError ? <p role="alert" className="text-sm text-destructive">{dialogError}</p> : null}
          </DialogContent>
        </Dialog>
        <details className="text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer">接入信息</summary>
          <div className="mt-2 space-y-3">
            {offerings.map((offering) => <OfferingItem key={offering.id} offering={offering} />)}
          </div>
        </details>
        {dialogError && !dialogOpen && dialogError !== error?.message ? <p role="alert" className="text-sm text-destructive">{dialogError}</p> : null}
        {error && (error.offeringId ? !dialogOpen : !suppressError)
          ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null}
      </section>
    </TooltipProvider>
  )
}


function SortableCredentialList({ credentials, disabled, onMove, children }: {
  credentials: AiProviderCredentialSummary[]
  disabled: boolean
  onMove?: (fromIndex: number, toIndex: number) => void
  children: (credential: AiProviderCredentialSummary, handle: ReactNode) => ReactNode
}) {
  const listRef = useRef<HTMLDivElement>(null)
  type Drag = {
    id: string; from: number; to: number; pointerId: number; startY: number; y: number
    handle: HTMLButtonElement; rows: HTMLElement[]; rects: DOMRect[]
  }
  const dragRef = useRef<Drag | null>(null)
  const frameRef = useRef<number | undefined>(undefined)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dropRef = useRef<Map<string, DOMRect> | null>(null)
  const dropOrderRef = useRef<string | undefined>(undefined)
  const busyRef = useRef(disabled)
  const [announcement, setAnnouncement] = useState('')
  const unavailable = disabled || !onMove || credentials.length < 2
  const order = credentials.map((credential) => credential.id).join('\0')
  const rows = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-sortable-credential]') ?? [])
  const clearMotion = () => {
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current)
    if (timerRef.current !== undefined) clearTimeout(timerRef.current)
    frameRef.current = undefined
    timerRef.current = undefined
    for (const row of rows()) {
      for (const key of ['transform', 'transition', 'zIndex', 'position', 'boxShadow', 'willChange', 'backgroundColor'] as const) row.style[key] = ''
      delete row.dataset.dragging
    }
  }
  const settle = () => {
    const positions = dropRef.current
    if (!positions) return
    dropRef.current = null
    clearMotion()
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const elements = rows()
    for (const row of elements) {
      const previous = positions.get(row.dataset.sortableCredential!)
      if (!previous || reduced) continue
      const rect = row.getBoundingClientRect()
      row.style.transition = 'none'
      row.style.transform = `translateY(${previous.top - rect.top}px)`
    }
    // Commit the inverse positions before animating to the new document order.
    listRef.current?.getBoundingClientRect()
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = undefined
      for (const row of elements) {
        row.style.transition = reduced ? 'none' : 'transform 160ms ease-out, box-shadow 160ms ease-out'
        row.style.transform = 'translateY(0px)'
      }
      timerRef.current = setTimeout(clearMotion, reduced ? 0 : 180)
    })
  }
  const finish = (commit: boolean) => {
    const drag = dragRef.current
    if (!drag) return
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current)
    dropRef.current = new Map(drag.rows.map((row) => [row.dataset.sortableCredential!, row.getBoundingClientRect()]))
    dropOrderRef.current = order
    if (commit && drag.from !== drag.to && !unavailable) {
      const source = drag.rects[drag.from]!
      const destination = drag.rects[drag.to]!
      const gap = Math.max(0, drag.rects[1]!.top - drag.rects[0]!.bottom)
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      drag.rows.forEach((row, index) => {
        const shift = index === drag.from
          ? drag.from < drag.to ? destination.bottom - source.bottom : destination.top - source.top
          : drag.from < index && index <= drag.to ? -(source.height + gap)
            : drag.to <= index && index < drag.from ? source.height + gap : 0
        row.style.transition = reduced ? 'none' : 'transform 160ms ease-out'
        row.style.transform = `translateY(${shift}px)`
        const rect = drag.rects[index]!
        dropRef.current!.set(row.dataset.sortableCredential!, { ...rect, top: rect.top + shift, bottom: rect.bottom + shift } as DOMRect)
      })
    }

    dragRef.current = null
    if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture?.(drag.pointerId)
    if (commit && !unavailable && credentials[drag.from]?.id === drag.id) move(drag.from, drag.to)
    // React's layout effect handles synchronous reorder; this handles no-op/async saves.
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = undefined
      if (!commit || !busyRef.current) settle()
    })
    // A stalled save must not leave transformed rows indefinitely.
    timerRef.current = setTimeout(settle, 10_000)
  }
  const move = (from: number, to: number) => {
    if (unavailable || from === to || to < 0 || to >= credentials.length) return
    onMove?.(from, to)
    setAnnouncement(`已请求将${credentialDisplayLabel(credentials[from])}移至第 ${to + 1} 位`)
  }
  const lifecycleRef = useRef({ finish, settle, clearMotion })
  useLayoutEffect(() => {
    lifecycleRef.current = { finish, settle, clearMotion }
    busyRef.current = disabled
  })
  useLayoutEffect(() => {
    if (dragRef.current) lifecycleRef.current.finish(false)
    if (dropRef.current && (dropOrderRef.current !== order || !disabled)) lifecycleRef.current.settle()
  }, [order, unavailable, disabled])
  useEffect(() => () => {
    const drag = dragRef.current
    dragRef.current = null
    dropRef.current = null
    if (drag?.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture?.(drag.pointerId)
    lifecycleRef.current.clearMotion()
  }, [])
  const paintDrag = () => {
    frameRef.current = undefined
    const drag = dragRef.current
    if (!drag) return
    const source = drag.rects[drag.from]!
    const gap = drag.rects.length > 1
      ? Math.max(0, drag.rects[1]!.top - drag.rects[0]!.bottom) : 0
    drag.rows.forEach((row, index) => {
      const shift = index === drag.from ? drag.y - drag.startY
        : drag.from < index && index <= drag.to ? -(source.height + gap)
          : drag.to <= index && index < drag.from ? source.height + gap : 0
      row.style.transform = `translateY(${shift}px)`
    })
  }

  return (
    <div ref={listRef} className="space-y-2">
      <span className="sr-only" role="status">{announcement}</span>
      {credentials.map((credential, index) => (
        <div key={credential.id} data-sortable-credential={credential.id}
          className="rounded-lg">
          {children(credential, onMove ? (
            <button type="button" disabled={unavailable}
              aria-label={`拖动排序 ${credentialDisplayLabel(credential)}`}
              title={credentials.length < 2 ? '至少添加两条连接后可拖动排序' : '拖动调整优先级，或使用方向键、Home / End 排序'}
              className="flex h-8 w-6 shrink-0 touch-none select-none items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40 enabled:cursor-grab active:cursor-grabbing"
              onKeyDown={(event) => {
                if (event.key === 'Escape') { finish(false); return }
                const next = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1
                  : event.key === 'Home' ? 0 : event.key === 'End' ? credentials.length - 1 : undefined
                if (next === undefined) return
                event.preventDefault()
                move(index, next)
              }}
              onPointerDown={(event) => {
                if (unavailable || event.button !== 0 || dragRef.current) return
                event.preventDefault()
                dropRef.current = null
                clearMotion()
                event.currentTarget.focus()
                event.currentTarget.setPointerCapture?.(event.pointerId)
                const elements = rows()
                const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
                dragRef.current = { id: credential.id, from: index, to: index, pointerId: event.pointerId,
                  startY: event.clientY, y: event.clientY, handle: event.currentTarget, rows: elements,
                  rects: elements.map((row) => row.getBoundingClientRect()) }
                for (const [rowIndex, row] of elements.entries()) {
                  row.style.willChange = 'transform'
                  row.style.transition = reduced || rowIndex === index ? 'none' : 'transform 160ms ease-out'
                  if (rowIndex === index) {
                    row.dataset.dragging = 'true'
                    row.style.position = 'relative'
                    row.style.zIndex = '10'
                    row.style.boxShadow = '0 8px 24px rgb(0 0 0 / 0.18)'
                    row.style.backgroundColor = 'hsl(var(--card))'
                  }
                }
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current
                if (!drag || drag.pointerId !== event.pointerId || unavailable) return
                drag.y = event.clientY
                let distance = Infinity
                drag.rects.forEach((rect, rowIndex) => {
                  const delta = Math.abs(event.clientY - (rect.top + rect.bottom) / 2)
                  if (delta < distance) { distance = delta; drag.to = rowIndex }
                })
                if (frameRef.current === undefined) frameRef.current = requestAnimationFrame(paintDrag)
              }}
              onPointerUp={(event) => {
                if (dragRef.current?.pointerId === event.pointerId) finish(true)
              }}
              onPointerCancel={(event) => {
                if (dragRef.current?.pointerId === event.pointerId) finish(false)
              }}
              onLostPointerCapture={(event) => {
                if (dragRef.current?.pointerId === event.pointerId) finish(false)
              }}
            ><GripVertical aria-hidden="true" className="h-4 w-4" /></button>
          ) : null)}
        </div>
      ))}
    </div>
  )
}

function AuthorizationMethodActions({
  methods,
  offering,
  hasCredentials,
  busy,
  disabled,
  onBeginOffering,
  onCreateLocalCredential,
}: {
  methods: AiProviderAuthorizationMethod[]
  offering: AiProviderOffering
  hasCredentials: boolean
  busy: boolean
  disabled: boolean
  onBeginOffering?: (offering: AiProviderOffering, mode: AiConnectionsMode, method?: AiProviderAuthorizationMethod) => void
  onCreateLocalCredential?: (offering: AiProviderOffering, method?: AiProviderAuthorizationMethod) => Promise<void>
}) {
  if (methods.length === 0) return null
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {methods.map((method) => {
          const connectMode = connectModeForMethod(method)
          if (isOAuthMode(connectMode)) {
            return (
              <Button
                key={method.id}
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                disabled={busy || disabled || !onBeginOffering}
                onClick={() => onBeginOffering?.(offering, connectMode, method)}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
                {method.label || (hasCredentials ? '添加账号' : '登录')}
              </Button>
            )
          }
          if (isLocalMethod(method)) {
            return (
              <Button
                key={method.id}
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                title="导入当前设备已有登录态，不会发起新的浏览器授权。"
                disabled={busy || disabled || !onCreateLocalCredential}
                onClick={() => void onCreateLocalCredential?.(offering, method)}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                {method.label || '已有登录态'}
              </Button>
            )
          }
          return null
        })}
      </div>
    </div>
  )
}

function OfferingItem({ offering, methods }: {
  offering: AiProviderOffering
  methods?: AiProviderAuthorizationMethod[]
}) {
  const endpoints = offering.endpoints ?? []
  const title = offeringTitle(offering)
  const kindLabel = offering.kind ? offeringKindLabel(offering.kind) : undefined
  const subtitle = kindLabel && kindLabel !== title ? [kindLabel] : []
  return (
    <section className="space-y-2" aria-labelledby={`offering-${offering.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 id={`offering-${offering.id}`} className="text-sm font-medium text-foreground">{title}</h4>
          {subtitle.length ? (
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              {subtitle.map((part) => <span key={part}>{part}</span>)}
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs">
          <span className="text-muted-foreground">{authMethodLabel(offering, methods)}</span>
          {offering.consoleUrl ? <OfferingLink href={offering.consoleUrl} label="控制台" /> : null}
          {offering.subscriptionUrl ? <OfferingLink href={offering.subscriptionUrl} label="订阅与账单" /> : null}
          {offering.quota?.url ? <OfferingLink href={offering.quota.url} label="额度与用量" /> : null}
          {offering.usagePolicyUrl ? <OfferingLink href={offering.usagePolicyUrl} label="使用政策" /> : null}
        </div>
      </div>
      {offering.lifecycle === 'unavailable' && !authorizationMethodsForOffering(offering).some((method) => method.lifecycle === 'active') ? (
        <p className="text-xs text-muted-foreground">{offering.kind === 'oauth-subscription'
          ? '暂不可用：账号订阅需在 Xpod 桌面版中导入本机客户端（如 Codex CLI）的登录态，浏览器中无法完成。'
          : '暂不可用：该接入方式尚未提供可用的连接流程。'}</p>
      ) : null}
      {endpoints.length ? (
        <dl className="space-y-1 text-[11px] text-muted-foreground">
          {endpoints.map((endpoint) => (
            <div key={`${endpoint.protocol}:${endpoint.baseUrl}`} className="flex min-w-0 items-baseline gap-2">
              <dt className="shrink-0 text-foreground/70">{endpointProtocolLabel(endpoint.protocol)}</dt>
              <dd className="min-w-0 truncate font-mono" title={endpoint.baseUrl}>
                {endpointDisplayValue(endpoint.baseUrl)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  )
}

function OfferingLink({ href, label }: { href: string; label: string }) {
  return <a href={href} target="_blank" rel="noreferrer" className="text-primary hover:underline">{label}</a>
}

function offeringEndpoint(offering: AiProviderOffering): string | undefined {
  const protocol = offering.modelDiscovery?.endpointProtocol
  return offering.endpoints?.find((endpoint) => endpoint.protocol === protocol)?.baseUrl
    ?? offering.endpoints?.[0]?.baseUrl
}

function endpointDisplayValue(value: string): string {
  try {
    const url = new URL(value)
    return `${url.host}${url.pathname.replace(/\/$/u, '')}`
  } catch {
    return value
  }
}

function endpointProtocolLabel(protocol: string): string {
  if (protocol === 'responses') return 'Responses API'
  if (protocol === 'chatCompletions') return 'Chat API'
  if (protocol === 'anthropic') return 'Anthropic API'
  return protocol
}

function offeringKindLabel(kind: string): string {
  if (kind === 'oauth-subscription') return '账号订阅'
  if (kind === 'api-platform') return 'API 平台'
  if (kind === 'token-plan') return 'Token 套餐'
  return kind
}

function authMethodLabel(offering: AiProviderOffering, methods?: AiProviderAuthorizationMethod[]): string {
  const labels = (methods?.length ? methods : authorizationMethodsForOffering(offering))
    .map((method) => method.authMode === 'apiKey'
      ? 'API Key'
      : method.authMode === 'local'
        ? method.label
        : '账号授权')
  return [...new Set(labels)].join(' / ')
}

function authorizationMethodsForOffering(
  offering: AiProviderOffering,
  definition?: AiProviderDefinition,
): AiProviderAuthorizationMethod[] {
  if (offering.authorizationMethods?.length) return offering.authorizationMethods
  const lifecycle = offering.lifecycle === 'unavailable' ? 'unavailable' : 'active'
  return [...new Set(offering.authModes ?? [])].map((mode): AiProviderAuthorizationMethod => {
    if (mode === 'apiKey') {
      return {
        id: 'api-key',
        authMode: 'apiKey',
        connectMode: 'browserAssistedApiKey',
        label: 'API Key',
        lifecycle,
      }
    }
    if (mode === 'local') {
      const localService = offering.kind === 'local'
      return {
        id: localService ? 'local-service' : 'local-session-import',
        authMode: 'local',
        label: localService ? '本地服务' : '已有登录态',
        lifecycle,
      }
    }
    return {
      id: 'device-code',
      authMode: mode,
      connectMode: 'deviceCodeOAuth',
      label: '',
      lifecycle,
    }
  })
}

function connectModeForMethod(method: AiProviderAuthorizationMethod): AiConnectionsMode | undefined {
  if (method.connectMode) return method.connectMode
  if (method.authMode === 'oauth' || method.authMode === 'deviceCode') return 'deviceCodeOAuth'
  if (method.authMode === 'apiKey') return 'browserAssistedApiKey'
  return undefined
}

function isOAuthMode(mode: AiConnectionsMode | undefined): mode is 'deviceCodeOAuth' | 'authorizationCodeOAuth' {
  return mode === 'deviceCodeOAuth' || mode === 'authorizationCodeOAuth'
}

function isOAuthMethod(method: AiProviderAuthorizationMethod): boolean {
  return isOAuthMode(connectModeForMethod(method))
}

function isApiKeyMethod(method: AiProviderAuthorizationMethod): boolean {
  return method.authMode === 'apiKey' || connectModeForMethod(method) === 'browserAssistedApiKey'
}

function isLocalMethod(method: AiProviderAuthorizationMethod): boolean {
  return method.authMode === 'local'
}

function ApiKeyPool({
  definition,
  offering,
  createOfferings,
  status,
  credentials,
  attempt,
  apiKey,
  baseUrl,
  busy,
  disabled,
  error,
  onApiKeyChange,
  onBaseUrlChange,
  onBeginApiKey,
  onBeginBrowser,
  onSaveApiKey,
  onDisconnect,
  onCreateApiKeyCredential,
  onUpdateCredential,
  initialEditing,
  initialCreate = false,
  onSavingChange,
  onCloseEdit,
}: {
  definition: AiProviderDefinition
  offering: AiProviderOffering
  createOfferings: AiProviderOffering[]
  status: ProviderConnectionState
  credentials: AiProviderCredentialSummary[]
  attempt?: AiConnectAttempt
  apiKey: string
  baseUrl: string
  busy: boolean
  disabled: boolean
  error?: string
  onApiKeyChange: (value: string) => void
  onBaseUrlChange?: (value: string) => void
  onBeginApiKey: () => void
  onBeginBrowser: () => void
  onSaveApiKey: () => void
  onDisconnect: () => void
  onCreateApiKeyCredential?: (offering: AiProviderOffering, input: {
    apiKey: string
    label?: string
    baseUrl?: string
    proxyUrl?: string
    priority: number
  }) => Promise<void>
  onUpdateCredential?: (credential: AiProviderCredentialSummary, patch: {
    label?: string
    enabled?: boolean
    priority?: number
    baseUrl?: string
    proxyUrl?: string
  }) => Promise<void>
  initialEditing?: AiProviderCredentialSummary
  initialCreate?: boolean
  onSavingChange?: (saving: boolean) => void
  onCloseEdit: () => void
}) {
  const apiKeyAttempt = attempt?.mode === 'browserAssistedApiKey' && attempt.status === 'pending'
  const isConfigured = status === 'configured'
  const isConnected = status === 'connected'
  const hasPoolActions = Boolean(onCreateApiKeyCredential)
  const [createOfferingId, setCreateOfferingId] = useState(offering.id)
  const formOffering = createOfferings.find((item) => item.id === createOfferingId) ?? offering
  const [showKey, setShowKey] = useState(false)
  const [formMode, setFormMode] = useState<'create' | 'edit' | undefined>(initialEditing ? 'edit' : initialCreate && onCreateApiKeyCredential ? 'create' : undefined)
  const [editingCredential, setEditingCredential] = useState<AiProviderCredentialSummary | undefined>(initialEditing)
  const [poolLabel, setPoolLabel] = useState(initialEditing?.label ?? '')
  const [poolApiKey, setPoolApiKey] = useState('')
  const [poolBaseUrl, setPoolBaseUrl] = useState(initialEditing?.baseUrl ?? '')
  const [poolProxyUrl, setPoolProxyUrl] = useState(initialEditing?.proxyUrl ?? '')
  const [poolFormError, setPoolFormError] = useState<string>()
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [saving, setSaving] = useState(false)
  const saveInFlight = useRef(false)
  const legacyBeginRef = useRef(false)
  useEffect(() => {
    if (initialCreate && !onCreateApiKeyCredential && !legacyBeginRef.current) {
      legacyBeginRef.current = true
      onBeginApiKey()
    }
  }, [initialCreate, onCreateApiKeyCredential, onBeginApiKey])

  const openCreateForm = () => {
    setCreateOfferingId(offering.id)
    setFormMode('create')
    setEditingCredential(undefined)
    setPoolLabel('')
    setPoolApiKey('')
    setPoolBaseUrl('')
    setPoolProxyUrl('')
    setPoolFormError(undefined)
    setShowAdvanced(false)
  }

  const closePoolForm = () => {
    onCloseEdit()
    setFormMode(undefined)
    setEditingCredential(undefined)
    setPoolLabel('')
    setPoolApiKey('')
    setPoolBaseUrl('')
    setPoolProxyUrl('')
    setPoolFormError(undefined)
    setShowAdvanced(false)
  }

  const savePoolForm = async () => {
    if (busy || disabled || saveInFlight.current) return
    let normalizedProxyUrl: string | undefined
    try {
      normalizedProxyUrl = normalizeProxyUrl(poolProxyUrl)
    } catch {
      setPoolFormError('Proxy URL 格式无效（支持 http、https）')
      return
    }
    setPoolFormError(undefined)
    if (formMode === 'create') {
      const trimmedKey = poolApiKey.trim()
      if (!trimmedKey || !onCreateApiKeyCredential) return
      saveInFlight.current = true
      setSaving(true)
      onSavingChange?.(true)
      try {
        await onCreateApiKeyCredential(formOffering, {
          apiKey: trimmedKey,
          label: poolLabel.trim() || undefined,
          baseUrl: poolBaseUrl.trim() || undefined,
          proxyUrl: normalizedProxyUrl,
          priority: nextCredentialPriority(credentials.filter((credential) => credential.offeringId === formOffering.id)),
        })
        closePoolForm()
      } catch (error) {
        setPoolFormError(error instanceof Error ? error.message : '保存失败，请重试')
      } finally {
        saveInFlight.current = false
        setSaving(false)
        onSavingChange?.(false)
      }
      return
    }
    if (formMode === 'edit' && editingCredential && onUpdateCredential) {
      const proxyChanged = poolProxyUrl.trim() !== (editingCredential.proxyUrl ?? '').trim()
      saveInFlight.current = true
      setSaving(true)
      onSavingChange?.(true)
      try {
        await onUpdateCredential(editingCredential, {
          label: poolLabel.trim() || undefined,
          baseUrl: poolBaseUrl.trim() || undefined,
          ...(proxyChanged ? { proxyUrl: normalizedProxyUrl } : {}),
        })
        closePoolForm()
      } catch (error) {
        setPoolFormError(error instanceof Error ? error.message : '保存失败，请重试')
      } finally {
        saveInFlight.current = false
        setSaving(false)
        onSavingChange?.(false)
      }
    }
  }

  return (
    <div className={cn('space-y-3', formMode && 'w-full')}>
      {attempt?.userCode ? (
        <div className="border-l-2 border-primary bg-muted/30 px-3 py-2 text-sm">
          验证码：<strong className="font-mono">{attempt.userCode}</strong>
        </div>
      ) : null}

      {!initialCreate && !initialEditing ? <div className="flex flex-wrap gap-2">
        {onCreateApiKeyCredential && createOfferings.length > 0 ? (
          <Button variant="outline" size="sm" disabled={busy || disabled || saving} onClick={openCreateForm}>
            <Plus className="mr-2 h-4 w-4" />
            添加 API Key
          </Button>
        ) : null}
        {hasPoolActions ? null : isConnected ? (
          <>
            <Button variant="outline" size="sm" disabled={busy || disabled || saving} onClick={onBeginBrowser}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCw className="mr-2 h-4 w-4" />}
              重新连接
            </Button>
            <Button variant="ghost" size="sm" disabled={busy || disabled || saving} onClick={onDisconnect}>
              <LogOut className="mr-2 h-4 w-4" />
              断开连接
            </Button>
          </>
        ) : isConfigured ? (
          <>
            <Button variant="outline" size="sm" aria-label="更新 API Key" disabled={busy || disabled || saving} onClick={onBeginApiKey}>
              <KeyRound className="mr-2 h-4 w-4" />
              更新 API Key
            </Button>
            <Button variant="ghost" size="sm" disabled={busy || disabled || saving} onClick={onDisconnect}>
              移除配置
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || disabled || saving || definition.browserMode === 'connectUnsupported'}
              onClick={onBeginBrowser}
            >
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ExternalLink className="mr-2 h-4 w-4" />}
              {definition.browserLabel}
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-label={`${definition.name} API Key`}
              disabled={busy || disabled || saving}
              onClick={onBeginApiKey}
            >
              <KeyRound className="mr-2 h-4 w-4" />
              配置 API Key
            </Button>
          </>
        )}
      </div> : null}

      {formMode ? (
        <div className="space-y-2 rounded-lg border border-border/50 bg-muted/10 p-3">
          {formMode === 'create' && createOfferings.length > 1 ? (
            <label className="block space-y-1 text-xs text-muted-foreground">
              <span>套餐 / 区域</span>
              <select aria-label={`${definition.name} 套餐 / 区域`} value={createOfferingId}
                disabled={busy || disabled || saving}
                onChange={(event) => { setCreateOfferingId(event.target.value); setPoolFormError(undefined) }}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground">
                {createOfferings.map((item) => <option key={item.id} value={item.id}>{offeringTitle(item)}</option>)}
              </select>
            </label>
          ) : null}
          {formMode === 'edit' ? (
            <Input
              disabled={busy || disabled || saving}
              autoComplete="off"
              aria-label={`${definition.name} API Key 标签`}
              placeholder="名称，例如 Work key"
              value={poolLabel}
              onChange={(event) => setPoolLabel(event.target.value)}
            />
          ) : null}
          {formMode === 'create' ? (
            <Input
              disabled={busy || disabled || saving}
              type={showKey ? 'text' : 'password'}
              autoComplete="new-password"
              data-lpignore="true"
              data-1p-ignore
              aria-label={`${definition.name} API Key 输入`}
              placeholder={definition.apiKeyPlaceholder || '从官方控制台复制 API Key'}
              value={poolApiKey}
              onChange={(event) => setPoolApiKey(event.target.value)}
              className="font-mono"
            />
          ) : null}
          {formMode === 'edit' || showAdvanced ? (
            <>
              <Input
                disabled={busy || disabled || saving}
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore
                aria-label={`${definition.name} Base URL 输入`}
                placeholder={offeringEndpoint(formMode === 'edit' ? offering : formOffering) || definition.defaultBaseUrl || '默认服务地址'}
                value={poolBaseUrl}
                onChange={(event) => setPoolBaseUrl(event.target.value)}
                className="font-mono text-xs"
              />
              <Input
                disabled={busy || disabled || saving}
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore
                aria-label={`${definition.name} Proxy URL 输入`}
                placeholder="http://127.0.0.1:7890"
                value={poolProxyUrl}
                onChange={(event) => setPoolProxyUrl(event.target.value)}
                className="font-mono text-xs"
              />
            </>
          ) : null}
          {poolFormError ? <p className="text-xs text-destructive">{poolFormError}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              aria-label={formMode === 'create' ? `保存 ${definition.name} API Key` : '保存凭证'}
              disabled={busy || disabled || saving || (formMode === 'create' && !poolApiKey.trim())}
              onClick={savePoolForm}
            >
              {formMode === 'create' ? '保存 API Key' : '保存凭证'}
            </Button>
            <Button variant="ghost" size="sm" disabled={saving} onClick={closePoolForm}>
              取消
            </Button>
            {formMode === 'create' ? (
              <Button variant="ghost" size="sm" disabled={saving} onClick={() => setShowAdvanced((current) => !current)}>
                {showAdvanced ? '收起高级设置' : '高级设置'}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {apiKeyAttempt && !formMode ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">API Key</span>
            {definition.apiKeyUrl ? (
              <a href={definition.apiKeyUrl} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">
                获取 API Key
              </a>
            ) : null}
          </div>
          <div className="group relative">
            <Input
              disabled={busy || disabled || saving}
              type={showKey ? 'text' : 'password'}
              autoComplete="new-password"
              data-lpignore="true"
              data-1p-ignore
              aria-label={`${definition.name} API Key 输入`}
              placeholder={definition.apiKeyPlaceholder || '从官方控制台复制 API Key'}
              value={apiKey}
              onChange={(event) => onApiKeyChange(event.target.value)}
              className="border-border/60 bg-muted/20 pr-10 font-mono transition-colors focus:border-primary/50 focus:bg-background"
            />
            <div className="absolute bottom-1 right-1 top-1 flex items-center">
              <Button
                variant="ghost"
                size="icon"
                className="h-full w-8 rounded hover:bg-muted"
                onClick={() => setShowKey((current) => !current)}
                aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
              >
                {showKey
                  ? <EyeOff className="h-4 w-4 text-muted-foreground" />
                  : <Eye className="h-4 w-4 text-muted-foreground" />}
              </Button>
            </div>
          </div>
          {onBaseUrlChange ? (
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Base URL（选填）</span>
              <Input
                disabled={busy || disabled || saving}
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore
                aria-label={`${definition.name} Base URL 输入`}
                placeholder={definition.defaultBaseUrl || '默认服务地址'}
                value={baseUrl}
                onChange={(event) => onBaseUrlChange(event.target.value)}
                className="border-border/60 bg-muted/20 font-mono text-xs transition-colors focus:border-primary/50 focus:bg-background"
              />
              <p className="break-all font-mono text-[11px] text-muted-foreground opacity-80">
                <span className="mr-1 select-none opacity-50">预览:</span>
                {(baseUrl.trim() || definition.defaultBaseUrl || '').replace(/\/+$/, '')}/chat/completions
              </p>
            </div>
          ) : null}
          <Button
            size="sm"
            aria-label={`保存 ${definition.name} API Key`}
            disabled={!apiKey.trim() || busy || disabled}
            onClick={onSaveApiKey}
          >
            保存 API Key
          </Button>
        </div>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  )
}

function CredentialRow({
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

function healthLabel(health: AiProviderCredentialSummary['health']): string {
  if (health === 'healthy') return '有效'
  if (health === 'unknown') return '未验证'
  if (health === 'expired') return '已过期'
  return '错误'
}

function healthTone(health: AiProviderCredentialSummary['health']): { row: string; dot: string } {
  if (health === 'healthy') {
    return { row: 'border-emerald-500/40 bg-emerald-500/5', dot: 'bg-emerald-500' }
  }
  if (health === 'unknown') {
    return { row: 'border-border/50 bg-background', dot: 'bg-muted-foreground/50' }
  }
  return { row: 'border-destructive/40 bg-destructive/5', dot: 'bg-destructive' }
}

function modeForOffering(
  offering: AiProviderOffering,
  definition: AiProviderDefinition,
): AiConnectionsMode {
  const modes = offering.authModes ?? []
  if (modes.some((mode) => mode === 'oauth' || mode === 'deviceCode')) return 'deviceCodeOAuth'
  if (modes.some((mode) => mode === 'apiKey' || mode === 'local')) return 'browserAssistedApiKey'
  return definition.browserMode === 'connectUnsupported' ? 'browserAssistedApiKey' : definition.browserMode
}

function isPendingAttempt(attempt: AiConnectAttempt | undefined): boolean {
  return attempt?.status === 'pending' || attempt?.status === 'authorization_pending' || attempt?.status === 'slow_down'
}

function nextCredentialPriority(credentials: AiProviderCredentialSummary[]): number {
  if (credentials.length === 0) return 10
  return Math.max(...credentials.map((credential) => credential.priority)) + 10
}

function credentialDisplayLabel(credential: AiProviderCredentialSummary): string {
  if (credential.label?.trim()) return credential.label
  if (credential.maskedHint) return `API Key · ${credential.maskedHint}`
  if (credential.authMode === 'oauth' || credential.authMode === 'deviceCode') return '已授权账号'
  return 'API Key'
}

function maskAccountLabel(value: string): string {
  const at = value.indexOf('@')
  if (at > 0) {
    const accountName = value.slice(0, at)
    const visible = accountName.length > 6
      ? `${accountName.slice(0, 3)}***${accountName.slice(-2)}`
      : accountName.length > 1
      ? `${accountName[0]}***${accountName[accountName.length - 1]}`
      : `${accountName[0]}***`
    return `${visible}${value.slice(at)}`
  }
  return value
}
