import type { ReactNode } from 'react'
import { Button } from '@undefineds.co/shared-ui'
import { Trash2 } from 'lucide-react'
import type { GatewayKeyRecord } from './contract/ai-connections-client'
import {
  AI_CLIENT_LABELS,
  AI_CONNECTIONS_CLIENTS,
  AiClientIcon,
  type AiConnectionsClientId,
} from './AiClientConfigurationSection'

export interface AiGatewayKeyBinding {
  clientId?: AiConnectionsClientId
  label: string
}

/**
 * A key row is the record of where an issued credential is in effect, so it
 * carries only the purpose declared at creation, the client it was written
 * into, when it was last used, and the one action that still applies: destroy.
 */
export function AiGatewayKeyRow({
  record,
  busy,
  confirming = false,
  onRequestDestroy,
  onCancelDestroy,
  onDestroy,
}: {
  record: GatewayKeyRecord
  busy: boolean
  /** §7.3：销毁前先说明影响，第二次点击才真正删除。 */
  confirming?: boolean
  onRequestDestroy: () => void
  onCancelDestroy: () => void
  onDestroy: () => void
}) {
  const label = record.name || '未命名 API Key'
  const binding = gatewayKeyBinding(record)
  // Credentials issued through CSS are revoked by client id; a record without
  // one cannot be destroyed from here, so the row says so instead of offering
  // an action that always fails.
  const destroyable = record.kind !== 'client-credentials' || Boolean(record.clientCredentialId)
  return (
    <li
      data-key-id={record.id}
      data-key-binding={record.appliedTo ? 'bound' : 'unbound'}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/60 px-4 py-3 first:rounded-t-xl last:rounded-b-xl last:border-b-0"
    >
      <dl className="flex min-w-0 flex-1 basis-64 flex-wrap items-center gap-x-6 gap-y-2">
        <KeyField label="用途" className="min-w-0 flex-1 basis-28">
          <span className="block truncate text-sm font-medium text-foreground/90" title={label}>{label}</span>
        </KeyField>
        <KeyField label="绑定" className="min-w-0 flex-1 basis-28">
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {binding.clientId ? <AiClientIcon client={binding.clientId} className="h-3.5 w-3.5" /> : null}
            <span className="truncate" title={binding.label}>{binding.label}</span>
          </span>
        </KeyField>
        <KeyField label="最后使用" className="shrink-0">
          <span className="block text-xs text-muted-foreground">
            {record.lastUsedAt ? formatTimestamp(record.lastUsedAt) : '暂无调用记录'}
          </span>
        </KeyField>
      </dl>
      {destroyable ? confirming ? (
        <div data-testid="gateway-key-destroy-confirm" className="mt-2 shrink-0 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs">
          {/* §7.3：停用共享 Key 前说明已知影响与未记录关联的局限 */}
          <p className="text-foreground">
            删除后，正在使用这个 Key 的客户端会立即失效。Xpod 目前不记录 Key 与客户端/用途的关联，
            因此无法列出受影响的对象；请先确认没有客户端在用。更稳妥的做法是给新客户端单独建一个 Key。
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              className="h-8 text-xs"
              aria-label={`确认删除 ${label}`}
              disabled={busy}
              onClick={onDestroy}
            >
              确认删除
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              aria-label={`取消删除 ${label}`}
              disabled={busy}
              onClick={onCancelDestroy}
            >
              取消
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 shrink-0 gap-1.5 text-xs text-muted-foreground hover:text-destructive"
          aria-label={`销毁 ${label}`}
          title={`销毁 ${label}`}
          disabled={busy}
          onClick={onRequestDestroy}
        >
          <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />销毁
        </Button>
      ) : (
        <span className="shrink-0 text-[11px] text-muted-foreground">缺少 CSS 凭据标识，无法在此销毁</span>
      )}
    </li>
  )
}

/** Where the credential is in effect: the client application and the device. */
export function gatewayKeyBinding(record: GatewayKeyRecord): AiGatewayKeyBinding {
  const appliedTo = record.appliedTo?.trim()
  if (!appliedTo) return { label: '未绑定' }
  const clientId = AI_CONNECTIONS_CLIENTS.find((candidate) => candidate === appliedTo)
  const clientLabel = clientId ? AI_CLIENT_LABELS[clientId] : appliedTo
  const appliedOn = record.appliedOn?.trim()
  return { clientId, label: appliedOn ? `${clientLabel} · ${appliedOn}` : clientLabel }
}

function KeyField({ label, className, children }: {
  label: string
  className?: string
  children: ReactNode
}) {
  return (
    <div className={className}>
      <dt className="text-[11px] leading-tight text-muted-foreground/80">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  )
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
