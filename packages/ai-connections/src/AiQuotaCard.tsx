import { Button } from '@undefineds.co/shared-ui'
import type { AiQuotaSnapshot } from './ai-connections-client'
import { RefreshCcw } from 'lucide-react'

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
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">剩余额度</div>
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
        <div className="space-y-1 text-sm">
          {typeof quota.balance === 'number' ? <div>余额：{quota.balance}</div> : null}
          {quota.windows.map((window, index) => (
            <div key={`${String(window.name)}-${index}`}>
              {window.name ? `${window.name}：` : ''}
              {typeof window.remaining === 'number' ? `剩余 ${window.remaining}` : '官方数据可用'}
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            来源：{quota.source}{quota.stale ? ' · 数据可能已过期' : ''}
          </p>
        </div>
      )}
    </div>
  )
}
