import { useEffect, useState } from 'react'
import { Badge, Button, Input, cn } from '@undefineds.co/shared-ui'
import {
  Copy,
  CircleAlert,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  Square,
  Trash2,
} from 'lucide-react'
import type {
  AiConnectionsClient,
  GatewayKeyRecord,
} from './ai-connections-client'
import {
  AI_CONNECTIONS_CLIENTS,
  AI_CLIENT_LABELS,
  AiClientIcon,
  manualConfigurationText,
  type AiClientConfigurationBridge,
  type AiConnectionsClientId,
} from './AiClientConfigurationSection'

const DEFAULT_KEY_NAME = '我的 API Key'

export function AiGatewayKeysSection({
  client,
  clientConfigurationBridge,
}: {
  client: AiConnectionsClient
  clientConfigurationBridge?: AiClientConfigurationBridge
}) {
  const [keys, setKeys] = useState<GatewayKeyRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState(DEFAULT_KEY_NAME)
  const [target, setTarget] = useState<'' | AiConnectionsClientId>('')
  const [creating, setCreating] = useState(false)
  const [busyKeyId, setBusyKeyId] = useState<string>()
  const [newPlaintext, setNewPlaintext] = useState<string>()
  const [error, setError] = useState<string>()

  const loadKeys = () => {
    let active = true
    setLoading(true)
    setError(undefined)
    void client.listGatewayKeys()
      .then((records) => {
        if (active) setKeys(records.filter((record) => !record.revokedAt))
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }

  useEffect(() => {
    return loadKeys()
    // The client instance is the request boundary for this applet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  const copyConfiguration = async (plaintext: string, selectedTarget = target) => {
    const content = selectedTarget
      ? manualConfigurationText(selectedTarget, client.apiBase, plaintext)
      : genericConfigurationText(client.apiBase, plaintext)
    if (!navigator.clipboard?.writeText) {
      throw new Error('当前浏览器无法访问剪贴板，请从下方复制新创建的 API Key。')
    }
    await navigator.clipboard.writeText(content)
  }

  const applyConfiguration = async (plaintext: string, selectedTarget: AiConnectionsClientId) => {
    if (!clientConfigurationBridge) {
      await copyConfiguration(plaintext, selectedTarget)
      return
    }
    const plan = await clientConfigurationBridge.plan({ client: selectedTarget, endpoint: client.apiBase })
    if (plan.confirmation?.required) {
      await copyConfiguration(plaintext, selectedTarget)
      throw new Error(`${AI_CLIENT_LABELS[selectedTarget]} 需要确认后才能写入；配置已复制。`)
    }
    await clientConfigurationBridge.apply({
      client: selectedTarget,
      planId: plan.planId,
      apiKey: plaintext,
    })
    const status = await clientConfigurationBridge.verify({ client: selectedTarget, planId: plan.planId })
    if (status.status !== 'configured') {
      throw new Error(status.message ?? `${AI_CLIENT_LABELS[selectedTarget]} 配置验证失败。`)
    }
  }

  const create = async () => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('请填写 API Key 名称。')
      return
    }
    setCreating(true)
    setError(undefined)
    setNewPlaintext(undefined)
    try {
      const created = await client.createGatewayKey({
        name: trimmedName,
        ...(target ? { appliedClient: target } : {}),
      })
      setKeys((current) => [created.record, ...current.filter((record) => record.id !== created.record.id)])
      setNewPlaintext(created.plaintext)
      setName(DEFAULT_KEY_NAME)
      if (target) await applyConfiguration(created.plaintext, target)
      else await copyConfiguration(created.plaintext)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setCreating(false)
    }
  }

  const setEnabled = async (record: GatewayKeyRecord, enabled: boolean) => {
    setBusyKeyId(record.id)
    setError(undefined)
    try {
      const updated = await client.updateGatewayKey(record.id, { enabled })
      setKeys((current) => current.map((item) => item.id === record.id ? updated : item))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusyKeyId(undefined)
    }
  }

  const copyExistingConfiguration = async (record: GatewayKeyRecord) => {
    setBusyKeyId(record.id)
    setError(undefined)
    try {
      const plaintext = await client.revealGatewayKey(record.id)
      const selectedTarget = asClientId(record.appliedClients?.[0]) ?? target
      await copyConfiguration(plaintext, selectedTarget)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusyKeyId(undefined)
    }
  }

  const remove = async (record: GatewayKeyRecord) => {
    setBusyKeyId(record.id)
    setError(undefined)
    try {
      await client.deleteGatewayKey(record.id)
      setKeys((current) => current.filter((item) => item.id !== record.id))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusyKeyId(undefined)
    }
  }

  return (
    <section className="min-w-0 max-w-4xl space-y-7" aria-label="API Keys">
      <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
        API Key 用于访问 Xpod Gateway。Provider 密钥不会写入客户端；客户端只获得 Xpod 地址和这里创建的 Key。
      </p>

      <div className="rounded-lg border border-border/70 bg-background p-4">
        <div className="grid min-w-0 gap-3 2xl:grid-cols-[minmax(14rem,1fr)_minmax(12rem,20rem)_auto] 2xl:items-end">
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">名称</span>
            <Input
              aria-label="API Key 名称"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">应用到（可选）</span>
            <select
              aria-label="应用到客户端"
              value={target}
              onChange={(event) => setTarget(event.target.value as '' | AiConnectionsClientId)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring"
            >
              <option value="">仅复制通用配置</option>
              {AI_CONNECTIONS_CLIENTS.map((clientId) => (
                <option key={clientId} value={clientId}>{AI_CLIENT_LABELS[clientId]}</option>
              ))}
            </select>
          </label>
          <Button
            aria-label="创建 API Key"
            className="w-full whitespace-nowrap lg:w-auto"
            disabled={creating || !name.trim()}
            onClick={() => void create()}
          >
            {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
            {target && clientConfigurationBridge ? '创建并应用配置' : '创建并复制配置'}
          </Button>
        </div>
        {target && !clientConfigurationBridge ? (
          <p className="mt-3 text-xs text-muted-foreground">
            当前 Web 环境不支持自动写入，将复制 {AI_CLIENT_LABELS[target]} 配置。
          </p>
        ) : null}
      </div>

      {newPlaintext ? (
        <div aria-label="新创建的 API Key" className="rounded-lg border border-primary/25 bg-primary/5 p-4">
          <p className="text-sm font-medium">API Key 已创建，配置已复制</p>
          <code className="mt-2 block overflow-x-auto text-xs text-muted-foreground">{newPlaintext}</code>
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <span className="flex min-w-0 items-center gap-2">
            <CircleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </span>
          {!loading ? (
            <Button variant="ghost" size="sm" className="shrink-0" onClick={() => loadKeys()}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />重新读取
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 pb-2">
          <h2 className="text-sm font-medium">已创建</h2>
          <span className="text-xs text-muted-foreground">{keys.length} 个 API Key</span>
        </div>
        {loading ? (
          <div role="status" className="space-y-2 py-2" aria-label="正在读取 API Keys">
            {[0, 1].map((index) => (
              <div key={index} className="flex min-h-16 items-center gap-4 rounded-lg border border-border/50 px-4 py-3">
                <div className="h-4 w-36 animate-pulse rounded bg-muted" />
                <div className="ml-auto h-8 w-24 animate-pulse rounded-md bg-muted/70" />
              </div>
            ))}
          </div>
        ) : keys.length === 0 ? (
          <div className="flex min-h-36 flex-col items-center justify-center rounded-lg border border-dashed border-border/70 px-6 py-8 text-center">
            <span className="mb-3 flex h-9 w-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <KeyRound className="h-4 w-4" aria-hidden="true" />
            </span>
            <p className="text-sm font-medium text-foreground">还没有 API Key</p>
            <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">填写上方名称即可创建；密钥只会完整显示一次，并自动复制配置。</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border/70">
            {keys.map((record) => {
              const disabled = Boolean(record.disabledAt)
              const label = record.name || '未命名 API Key'
              const busy = busyKeyId === record.id
              return (
                <div
                  key={record.id}
                  data-key-state={disabled ? 'disabled' : 'active'}
                  className={cn(
                    'grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-border/60 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1.4fr)_minmax(10rem,.8fr)_auto]',
                    disabled ? 'bg-muted/30 text-muted-foreground' : 'bg-emerald-500/[0.035]',
                  )}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="truncate text-sm font-medium">{label}</span>
                    <code className="shrink-0 text-xs text-muted-foreground">{record.maskedHint ?? suffixHint(record.id)}</code>
                    <Badge variant="secondary">{disabled ? '已停用' : '已启用'}</Badge>
                  </div>
                  <div className="hidden min-w-0 text-xs text-muted-foreground md:block">
                    {record.lastUsedAt ? `最后使用 ${formatTimestamp(record.lastUsedAt)}` : '暂无调用记录 · 尚未使用'}
                  </div>
                  <div className="flex items-center justify-end gap-1">
                    {(record.appliedClients ?? []).map(asClientId).filter(isDefined).map((clientId) => (
                      <span key={clientId} title={AI_CLIENT_LABELS[clientId]} className="flex h-8 w-8 items-center justify-center text-muted-foreground">
                        <AiClientIcon client={clientId} />
                      </span>
                    ))}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${disabled ? '启用' : '停用'} ${label}`}
                      title={`${disabled ? '启用' : '停用'} ${label}`}
                      disabled={busy}
                      onClick={() => void setEnabled(record, disabled)}
                    >
                      {disabled ? <Play className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`复制 ${label} 配置`}
                      title={`复制 ${label} 配置`}
                      disabled={busy}
                      onClick={() => void copyExistingConfiguration(record)}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`删除 ${label}`}
                      title={`删除 ${label}`}
                      disabled={busy}
                      onClick={() => void remove(record)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}

function asClientId(value: string | undefined): AiConnectionsClientId | undefined {
  return value && (AI_CONNECTIONS_CLIENTS as readonly string[]).includes(value)
    ? value as AiConnectionsClientId
    : undefined
}

function genericConfigurationText(endpoint: string, apiKey: string): string {
  return [
    `XPOD_BASE_URL=${endpoint.replace(/\/+$/u, '')}/v1`,
    `XPOD_API_KEY=${apiKey}`,
  ].join('\n')
}

function suffixHint(id: string): string {
  return `••••••••${id.slice(-8)}`
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'API Key 操作失败，请重试。'
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
