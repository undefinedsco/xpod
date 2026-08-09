import { Button } from '@undefineds.co/shared-ui'
import type { AiQuotaSnapshot } from './ai-connections-client'
import { RefreshCcw, Wallet } from 'lucide-react'

export function AiQuotaCard({
  providerName,
  quota,
  busy,
  disabled = false,
  onRefresh,
}: {
  providerName: string
  quota?: AiQuotaSnapshot
  busy: boolean
  disabled?: boolean
  onRefresh: () => void
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 border-b border-border/40 pb-2">
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-primary" />
          <div className="text-sm font-medium text-foreground/90">剩余额度</div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`刷新 ${providerName} 额度`}
          disabled={busy || disabled}
          onClick={onRefresh}
        >
          <RefreshCcw className="mr-2 h-3.5 w-3.5" />
          刷新
        </Button>
      </div>
      {!quota ? (
        <p className="text-xs text-muted-foreground">尚未检查</p>
      ) : quota.status === 'unsupported' ? (
        <>
          <p className="text-sm">官方额度接口不支持</p>
          <p className="text-xs text-muted-foreground">来源：{quota.source}</p>
        </>
      ) : quota.status === 'error' ? (
        <p className="text-sm text-destructive">额度查询失败</p>
      ) : (
        <div className="space-y-3 text-sm">
          {typeof quota.balance === 'number' ? <div>余额：{quota.balance}</div> : null}
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
          <p className="text-xs text-muted-foreground">
            来源：{quota.source}{quota.stale ? ' · 数据可能已过期' : ''}
          </p>
        </div>
      )}
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
