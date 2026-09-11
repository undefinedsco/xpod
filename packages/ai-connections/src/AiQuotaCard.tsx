import { useEffect, useRef, useState } from 'react'
import { Button, Dialog, DialogContent, DialogTitle, DialogTrigger } from '@undefineds.co/shared-ui'
import type { AiQuotaSnapshot } from './ai-connections-client'
import { Info, Loader2, RefreshCcw, Wallet } from 'lucide-react'

export function AiQuotaCard({
  providerName,
  offeringName,
  quota,
  busy,
  disabled = false,
  credentialLabel,
  multiple = false,
  compact = false,
  paused = false,
  error,
  onRefresh,
}: {
  providerName: string
  offeringName: string
  quota?: AiQuotaSnapshot
  busy: boolean
  disabled?: boolean
  credentialLabel?: string
  multiple?: boolean
  compact?: boolean
  paused?: boolean
  error?: string
  onRefresh: () => void
}) {
  if (compact) {
    const available = !busy && !error && quota?.status === 'available'
    return (
      <div className={`min-w-0 text-xs text-muted-foreground ${paused ? 'opacity-60' : ''}`}>
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1 truncate py-1 [&>span+span]:ml-3">
            {paused ? <span>已停用 · 不参与全部刷新</span> : null}
            {busy ? <span role="status">正在查询额度…</span>
              : error ? <span role="alert" title={error} className="text-destructive">{error}</span>
                : !quota ? <span>{credentialLabel ? '尚未检查' : `连接${offeringName}后可查询`}</span>
                  : quota.status === 'unsupported' ? <span>官方额度接口不支持</span>
                    : quota.status === 'error' ? <span role="alert" className="text-destructive">额度查询失败</span>
                      : <QuotaSummary quota={quota} />}
            {available && quota.stale ? <span>数据可能已过期</span> : null}
          </div>
          <QuotaInfo quota={quota} label={credentialLabel ?? offeringName} />
          <Button
            className="h-6 w-6 shrink-0 p-0"
            variant="ghost"
            size="sm"
            aria-label={`刷新 ${providerName} ${offeringName}${credentialLabel ? ` ${credentialLabel}` : ''}额度`}
            disabled={busy || disabled}
            onClick={onRefresh}
          >
            {busy ? <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" /> : <RefreshCcw aria-hidden="true" className="h-3 w-3" />}
          </Button>
        </div>

      </div>
    )
  }
  return (
    <div className={`${multiple ? 'space-y-1.5' : 'space-y-3'} border-t border-border/40 pt-3 ${paused ? 'opacity-60' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {!multiple ? <Wallet className="h-4 w-4 shrink-0 text-primary" /> : null}
          <div className="min-w-0">
            <div className="break-all text-sm font-medium text-foreground/90">{multiple ? `凭证：${credentialLabel}` : '剩余额度'}</div>
            {multiple && !busy && !error && quota?.status === 'available' ? (
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <QuotaSummary quota={quota} />
              </div>
            ) : null}
          </div>
        </div>
        <Button
          className="shrink-0"
          variant="ghost"
          size="sm"
          aria-label={`刷新 ${providerName} ${offeringName}${multiple ? ` ${credentialLabel}` : ''}额度`}
          disabled={busy || disabled}
          onClick={onRefresh}
        >
          {busy
            ? <Loader2 aria-hidden="true" className="mr-2 h-3.5 w-3.5 animate-spin" />
            : <RefreshCcw aria-hidden="true" className="mr-2 h-3.5 w-3.5" />}
          {busy ? '查询中' : '刷新'}
        </Button>
      </div>
      {credentialLabel && !multiple ? (
        <p className="text-xs text-muted-foreground">凭证：{credentialLabel}</p>
      ) : null}
      {paused ? <p className="text-xs text-muted-foreground">已停用 · 不参与全部刷新</p> : null}
      {busy ? (
        <p role="status" className="text-xs text-muted-foreground">正在查询额度…</p>
      ) : error ? (
        <p role="alert" className="text-sm text-destructive">{error}</p>
      ) : !quota ? (
        <p className="text-xs text-muted-foreground">{credentialLabel ? '尚未检查' : `连接${offeringName}后可查询`}</p>
      ) : quota.status === 'unsupported' ? (
        <>
          <p className="text-sm">官方额度接口不支持</p>
          <p className="text-xs text-muted-foreground">来源：{quota.source}</p>
        </>
      ) : quota.status === 'error' ? (
        <p className="text-sm text-destructive">额度查询失败</p>
      ) : (
        multiple ? (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer" aria-label={`${credentialLabel}额度详情`}>详情</summary>
            <div className="pt-3"><QuotaDetails quota={quota} hideBalance /></div>
          </details>
        ) : <QuotaDetails quota={quota} />
      )}
    </div>
  )
}

function QuotaInfo({ quota, label }: { quota?: AiQuotaSnapshot; label: string }) {
  const [position, setPosition] = useState({ left: 16, top: 16, maxHeight: 400 })
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const outsideRef = useRef(false)
  useEffect(() => {
    if (!open) return
    // Capture also covers clicks on the page margin outside React's root.
    const dismissOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || triggerRef.current?.contains(event.target) || contentRef.current?.contains(event.target)) return
      outsideRef.current = true
      setOpen(false)
    }
    const dismissMoved = (event: Event) => {
      if (event.type === 'scroll' && event.target instanceof Node && contentRef.current?.contains(event.target)) return
      outsideRef.current = true
      setOpen(false)
    }
    document.addEventListener('pointerdown', dismissOutside, true)
    document.addEventListener('scroll', dismissMoved, true)
    window.addEventListener('resize', dismissMoved)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true)
      document.removeEventListener('scroll', dismissMoved, true)
      window.removeEventListener('resize', dismissMoved)
    }
  }, [open])
  return (
    <Dialog modal={false} open={open} onOpenChange={(next) => { outsideRef.current = false; setOpen(next) }}>
      <DialogTrigger asChild>
        <Button ref={triggerRef} className="h-6 w-6 shrink-0 p-0" variant="ghost" size="sm"
          aria-label={`${label}额度详情`} disabled={!quota || quota.status === 'error'}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            const width = Math.min(320, window.innerWidth - 32)
            const left = Math.max(16, Math.min(rect.right - width, window.innerWidth - width - 16))
            const top = Math.max(16, Math.min(rect.bottom + 8, window.innerHeight - 320))
            setPosition({ left, top, maxHeight: window.innerHeight - top - 16 })
          }}>
          <Info aria-hidden="true" className="h-3 w-3" />
        </Button>
      </DialogTrigger>
      <DialogContent ref={contentRef} className="w-[calc(100vw-2rem)] max-w-xs overflow-y-auto p-4"
        onEscapeKeyDown={() => triggerRef.current?.focus()}
        onCloseAutoFocus={(event) => { if (outsideRef.current) event.preventDefault() }}
        style={{ ...position, transform: 'none', animation: 'none' }} aria-describedby={undefined}>
        <DialogTitle className="pr-8 text-sm">额度详情</DialogTitle>
        {quota?.status === 'available' ? <QuotaDetails quota={quota} />
          : quota ? <p className="break-words text-xs text-muted-foreground">来源：{quota.source}</p> : null}
      </DialogContent>
    </Dialog>
  )
}

function QuotaSummary({ quota }: { quota: AiQuotaSnapshot }) {
  return (
    <>
      {typeof quota.balance === 'number' ? <span>余额：{quota.balance}</span> : null}
      {quota.windows.map((window, index) => <span key={index}>{quotaWindowLabel(window.name)} · {remainingLabel(window)}</span>)}
      {typeof quota.balance !== 'number' && quota.windows.length === 0 ? <span>服务商未返回额度数据</span> : null}
    </>
  )
}

function QuotaDetails({ quota, hideBalance = false }: { quota: AiQuotaSnapshot; hideBalance?: boolean }) {
  return (
    <div className="space-y-3 text-sm">
      {!hideBalance && typeof quota.balance === 'number' ? <div>余额：{quota.balance}</div> : null}
      {quota.windows.map((window, index) => (
        <div className="space-y-1.5" key={`${String(window.name)}-${index}`}>
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium text-foreground">{quotaWindowLabel(window.name)}</span>
            <span className="text-muted-foreground">{remainingLabel(window)}</span>
          </div>
          {remainingPercent(window) !== undefined ? (
            <div
              aria-label={`${quotaWindowLabel(window.name)}剩余 ${String(remainingPercent(window))}%`}
              className="h-1.5 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={remainingPercent(window)}
            >
              <div className="h-full rounded-full bg-primary" style={{ width: `${String(remainingPercent(window))}%` }} />
            </div>
          ) : null}
          {window.resetsAt ? <p className="text-xs text-muted-foreground">重置：{formatTimestamp(window.resetsAt)}</p> : null}
        </div>
      ))}
      <p className="text-xs text-muted-foreground">更新：{formatTimestamp(quota.observedAt)}</p>
      <p className="break-words text-xs text-muted-foreground">
        来源：{quota.source}{quota.stale ? ' · 数据可能已过期' : ''}
      </p>
    </div>
  )
}

function quotaWindowLabel(name: unknown): string {
  switch (name) {
    case 'five-hour': return '5 小时限制'
    case 'weekly': return '周限制'
    case 'monthly': return '月限制'
    case 'weekly-opus': return 'Opus 周限制'
    case 'weekly-sonnet': return 'Sonnet 周限制'
    case 'available_balance': return '可用余额'
    case 'voucher_balance': return '赠送余额'
    case 'cash_balance': return '现金余额'
    default: return typeof name === 'string' && name ? name : '额度'
  }
}

function remainingPercent(window: AiQuotaSnapshot['windows'][number]): number | undefined {
  if (typeof window.remaining !== 'number' || typeof window.limit !== 'number' || window.limit <= 0) return undefined
  return Math.max(0, Math.min(100, Math.round((window.remaining / window.limit) * 10_000) / 100))
}

function remainingLabel(window: AiQuotaSnapshot['windows'][number]): string {
  const percentage = remainingPercent(window)
  if (percentage !== undefined) return `剩余 ${String(percentage)}%`
  if (typeof window.remaining === 'number') {
    const currency = typeof window.currency === 'string' ? ` ${window.currency}` : ''
    return `剩余 ${String(window.remaining)}${currency}`
  }
  return '官方数据可用'
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
