import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, cn, dismissToast, toast } from '@undefineds.co/shared-ui'
import {
  Check,
  ChevronDown,
  Copy,
  KeyRound,
  Loader2,
  Power,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import type {
  AiConnectionsClient,
  GatewayKeyRecord,
  AiGatewayModel,
} from './ai-connections-client'
import {
  AI_CONNECTIONS_CLIENTS,
  AI_CLIENT_LABELS,
  AiClientIcon,
  manualConfigurationText,
  type AiClientConfigurationBridge,
  type AiClientConfigurationDryRun,
  type AiConnectionsClientId,
} from './AiClientConfigurationSection'

const DEFAULT_KEY_NAME = '我的 API Key'

export function AiGatewayKeysSection({
  client,
  clientConfigurationBridge,
  gatewayModels,
}: {
  client: AiConnectionsClient
  clientConfigurationBridge?: AiClientConfigurationBridge
  gatewayModels?: AiGatewayModel[]
}) {
  const [keys, setKeys] = useState<GatewayKeyRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState(DEFAULT_KEY_NAME)
  const [showCreate, setShowCreate] = useState(false)
  const applicationVersions = useRef<Partial<Record<AiConnectionsClientId, number>>>({})
  const [openMenuKeyId, setOpenMenuKeyId] = useState<string>()
  const [applications, setApplications] = useState<Partial<Record<AiConnectionsClientId, string>>>({})
  const plaintexts = useRef(new Map<string, string>())
  const operation = useRef(false)
  const [creating, setCreating] = useState(false)
  const [busyKeyId, setBusyKeyId] = useState<string>()
  const [applying, setApplying] = useState<{ keyId: string; clientId: AiConnectionsClientId }>()
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState<Record<string, AiConnectionsClientId | 'key'>>({})
  const copyTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const copyGeneration = useRef(0)
  const notification = useRef<string | undefined>(undefined)

  const notify = useCallback((options: Parameters<typeof toast>[0]) => {
    if (notification.current) dismissToast(notification.current)
    notification.current = toast(options)
  }, [])

  const notifyError = useCallback((cause: unknown) => {
    notify({ variant: 'destructive', description: errorMessage(cause), duration: 8000 })
  }, [notify])

  const clearCopyFeedback = (keyId: string) => {
    clearTimeout(copyTimers.current.get(keyId))
    copyTimers.current.delete(keyId)
    setCopied((current) => {
      const next = { ...current }
      delete next[keyId]
      return next
    })
  }

  useEffect(() => {
    let active = true
    copyGeneration.current += 1
    const timers = copyTimers.current
    setLoading(true)
    setError(undefined)
    setApplications({})
    plaintexts.current.clear()
    const versions = { ...applicationVersions.current }
    void client.listGatewayKeys()
      .then((records) => {
        if (!active) return
        const visible = records.filter((record) => !record.revokedAt)
        setKeys(visible)
        if (!clientConfigurationBridge) return
        void Promise.all(AI_CONNECTIONS_CLIENTS.map(async (clientId) => {
          try {
            const status = await clientConfigurationBridge.inspect(clientId)
            if (!active || applicationVersions.current[clientId] !== versions[clientId] ||
              status.status !== 'configured' || !status.appliedKeyFingerprint) return
            const matches = visible.filter((record) => record.fingerprint === status.appliedKeyFingerprint)
            if (matches.length !== 1) return
            const keyId = matches[0]!.id
            setApplications((current) => ({ ...current, [clientId]: keyId }))
          } catch {
            // Unavailable inspection must not infer ownership from historical metadata.
          }
        }))
      })
      .catch((cause) => {
        if (active) notifyError(cause)
      })
      .finally(() => {
        if (active) {
          setCopied({})
          setOpenMenuKeyId(undefined)
          setLoading(false)
        }
      })
    return () => {
      active = false
      copyGeneration.current += 1
      timers.forEach(clearTimeout)
      timers.clear()
      if (notification.current) dismissToast(notification.current)
    }
  }, [client, clientConfigurationBridge, notifyError])


  useEffect(() => {
    if (!openMenuKeyId) return
    const closeOutside = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('[data-client-menu]')?.getAttribute('data-client-menu') === openMenuKeyId) return
      setOpenMenuKeyId(undefined)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [openMenuKeyId])

  const runKeyOperation = async (keyId: string, action: () => Promise<void>) => {
    if (operation.current) return
    operation.current = true
    setBusyKeyId(keyId)
    setError(undefined)
    try {
      await action()
    } catch (cause) {
      notifyError(cause)
    } finally {
      operation.current = false
      setBusyKeyId(undefined)
      setApplying(undefined)
    }
  }

  const applyPlan = async (keyId: string, plan: AiClientConfigurationDryRun, refresh = false) => {
    if (!clientConfigurationBridge) return
    setApplying({ keyId, clientId: plan.client })
    const plaintext = plaintexts.current.get(keyId) ?? await client.revealGatewayKey(keyId)
    await clientConfigurationBridge.apply({
      client: plan.client,
      planId: plan.planId,
      apiKey: plaintext,
      ...(plan.confirmation?.required ? { confirmation: {
        token: plan.confirmation.token,
        targetHash: plan.confirmation.targetHash,
      } } : {}),
    })
    setApplications((current) => ({ ...current, [plan.client]: keyId }))
    notify({ variant: 'success', description: plan.client === 'codex' && gatewayModels === undefined
      ? 'Codex 连接配置已应用，模型目录尚未加载，请稍后刷新配置。'
      : `${AI_CLIENT_LABELS[plan.client]} ${refresh ? 'endpoint 已刷新。' : '配置已应用。'}` })
  }

  const applyExistingConfiguration = (record: GatewayKeyRecord, selectedTarget: AiConnectionsClientId, refresh = false) => runKeyOperation(record.id, async () => {
    if (!clientConfigurationBridge || (refresh && applications[selectedTarget] !== record.id)) return
    setApplying({ keyId: record.id, clientId: selectedTarget })
    applicationVersions.current[selectedTarget] = (applicationVersions.current[selectedTarget] ?? 0) + 1
    const plan = await clientConfigurationBridge.plan({
      client: selectedTarget,
      endpoint: client.apiBase,
      ...(selectedTarget === 'codex' && gatewayModels !== undefined ? {
        activeModels: gatewayModels.map(({ id, provider, displayName, availability, contextWindow, inputModalities, capabilities }) => ({
          id, provider, displayName, availability, contextWindow, inputModalities, capabilities,
        })),
      } : {}),
    })
    await applyPlan(record.id, plan, refresh)
  })

  const restore = (record: GatewayKeyRecord, selectedTarget: AiConnectionsClientId) => runKeyOperation(record.id, async () => {
    if (!clientConfigurationBridge || applications[selectedTarget] !== record.id) return
    applicationVersions.current[selectedTarget] = (applicationVersions.current[selectedTarget] ?? 0) + 1
    const status = await clientConfigurationBridge.restore(selectedTarget)
    if (status.status !== 'notConfigured' && status.status !== 'failedAndRestored') {
      throw new Error(status.message ?? '撤回未完成，请重试。')
    }
    setApplications((current) => {
      const next = { ...current }
      delete next[selectedTarget]
      return next
    })
    notify({ description: `${AI_CLIENT_LABELS[selectedTarget]} 配置已撤回，API Key 已保留。` })
  })

  const create = async () => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('请填写 API Key 名称。')
      return
    }
    setCreating(true)
    setError(undefined)
    try {
      const created = await client.createGatewayKey({
        name: trimmedName,
      })
      setKeys((current) => [created.record, ...current.filter((record) => record.id !== created.record.id)])
      plaintexts.current.set(created.record.id, created.plaintext)
      notify({ variant: 'success', description: 'API Key 已创建，可在列表中复制或应用配置。' })
      setName(DEFAULT_KEY_NAME)
      setShowCreate(false)
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
      notifyError(cause)
    } finally {
      setBusyKeyId(undefined)
    }
  }

  const copyExistingConfiguration = (record: GatewayKeyRecord, selectedTarget: AiConnectionsClientId | 'key') => runKeyOperation(record.id, async () => {
    const generation = copyGeneration.current
    const plaintext = plaintexts.current.get(record.id) ?? await client.revealGatewayKey(record.id)
    if (generation !== copyGeneration.current) return
    if (!navigator.clipboard?.writeText) {
      throw new Error('当前浏览器无法访问剪贴板，请允许剪贴板访问后重试。')
    }
    await navigator.clipboard.writeText(selectedTarget === 'key'
      ? plaintext
      : manualConfigurationText(selectedTarget, client.apiBase, plaintext))
    if (generation !== copyGeneration.current) return
    clearTimeout(copyTimers.current.get(record.id))
    setCopied((current) => ({ ...current, [record.id]: selectedTarget }))
    copyTimers.current.set(record.id, setTimeout(() => clearCopyFeedback(record.id), 2000))
  })

  const remove = async (record: GatewayKeyRecord) => {
    setBusyKeyId(record.id)
    setError(undefined)
    try {
      await client.deleteGatewayKey(record.id)
      plaintexts.current.delete(record.id)
      clearCopyFeedback(record.id)
      setKeys((current) => current.filter((item) => item.id !== record.id))
    } catch (cause) {
      notifyError(cause)
    } finally {
      setBusyKeyId(undefined)
    }
  }

  return (
    <section className="[container-type:inline-size] space-y-6" aria-label="API Keys">
      <p className="max-w-3xl text-sm text-muted-foreground">
        API Key 用于访问 Xpod Gateway。Provider 密钥不会写入客户端；客户端只获得 Xpod 地址和这里创建的 Key。
      </p>

      <div className="flex items-center justify-between gap-3 border-b border-border/60 pb-2">
        <span className="text-xs text-muted-foreground">{keys.length} 个 API Key</span>
        <Button size="sm" aria-label="新建 API Key" disabled={creating || loading} onClick={() => { setError(undefined); setName(DEFAULT_KEY_NAME); setShowCreate(true) }}>
          <KeyRound className="mr-2 h-4 w-4" />新建 API Key
        </Button>
      </div>
      <Dialog open={showCreate} onOpenChange={(open) => { if (!creating) setShowCreate(open) }}>
        <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
          <DialogHeader><DialogTitle>新建 API Key</DialogTitle></DialogHeader>
          <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); if (!creating) void create() }}>
            <label className="block space-y-2">
              <span className="text-sm font-medium">名称</span>
              <Input autoFocus aria-label="API Key 名称" value={name} disabled={creating} onChange={(event) => setName(event.target.value)} />
            </label>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={creating} onClick={() => setShowCreate(false)}>取消</Button>
              <Button type="submit" aria-label="创建 API Key" disabled={creating || !name.trim()}>
                {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {creating ? '正在创建…' : '创建 API Key'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {!clientConfigurationBridge ? <p className="text-xs text-muted-foreground">当前 Web 环境可复制配置；自动应用和撤回需要本机连接。</p> : null}

      <div className="space-y-2">
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />正在读取 API Keys
          </div>
        ) : keys.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">尚未创建 API Key。</p>
        ) : (
          <div className="rounded-xl border border-border/70">
            {keys.map((record) => {
              const disabled = Boolean(record.disabledAt)
              const label = record.name || '未命名 API Key'
              const busy = Boolean(busyKeyId)
              const appliedClients = AI_CONNECTIONS_CLIENTS.filter((clientId) => applications[clientId] === record.id)
              const hasApplication = appliedClients.length > 0
              return (
                <div
                  key={record.id}
                  data-key-state={disabled ? 'disabled' : 'active'}
                  className={cn(
                    'flex min-w-0 items-center gap-1 border-b border-border/60 px-2 py-2.5 sm:gap-2 sm:px-4 first:rounded-t-xl last:rounded-b-xl last:border-b-0',
                    disabled ? 'bg-muted/30 text-muted-foreground' : 'bg-emerald-500/[0.035]',
                  )}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-1 sm:gap-2">
                    <span className="min-w-0 truncate text-sm font-medium" title={label}>{label}</span>
                    <code dir="rtl" className="min-w-0 max-w-36 truncate text-left text-xs text-muted-foreground"><span dir="ltr">{record.maskedHint ?? suffixHint(record.id)}</span></code>
                    <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0"
                      aria-label={`复制 ${label}`} title={copied[record.id] === 'key' ? '已复制' : '复制 API Key'}
                      disabled={busy} onClick={() => void copyExistingConfiguration(record, 'key')}>
                      {copied[record.id] === 'key' ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                    </Button>
                    <span role="status" aria-live="polite" className="sr-only">{copied[record.id] === 'key' ? 'API Key 已复制' : ''}</span>
                    {hasApplication ? <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
                      {appliedClients.map((clientId) => <span key={clientId} role="img" aria-label={`${AI_CLIENT_LABELS[clientId]} 已应用`}
                        title={`${AI_CLIENT_LABELS[clientId]} 已应用`} className="shrink-0">
                        <AiClientIcon client={clientId} />
                      </span>)}
                    </div> : null}
                  </div>
                  <span className="hidden shrink-0 text-xs text-muted-foreground [@container(min-width:850px)]:inline">
                    {record.lastUsedAt ? `最后使用 ${formatTimestamp(record.lastUsedAt)}` : '暂无调用记录 · 尚未使用'}
                  </span>
                  <details data-client-menu={record.id} open={openMenuKeyId === record.id} className="relative shrink-0"
                    onKeyDown={(event) => {
                      if (event.key !== 'Escape') return
                      event.preventDefault()
                      setOpenMenuKeyId(undefined)
                      event.currentTarget.querySelector('summary')?.focus()
                    }}>
                    <summary role="button" aria-label={`${label} 客户端配置`} aria-expanded={openMenuKeyId === record.id}
                      onClick={(event) => {
                        event.preventDefault()
                        if (busy && openMenuKeyId !== record.id) return
                        setOpenMenuKeyId((current) => current === record.id ? undefined : record.id)
                      }}
                      className="inline-flex min-h-9 max-w-full cursor-pointer list-none items-center gap-2 rounded-md border border-input bg-background px-2 text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                      <span>应用</span>
                      <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                    </summary>
                    <div role="group" aria-label={`${label} 客户端选项`}
                      className="absolute right-0 top-full z-20 mt-1 w-72 max-w-[calc(100cqw-6rem)] space-y-1 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-lg">
                      {AI_CONNECTIONS_CLIENTS.map((clientId) => {
                        const application = applications[clientId]
                        const checked = application === record.id
                        const copiedClient = copied[record.id] === clientId
                        return <div key={clientId} className="flex items-center gap-2 rounded-md px-2 py-1.5">
                          {clientConfigurationBridge ? <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm">
                            <input type="checkbox" aria-label={`${label} 应用到 ${AI_CLIENT_LABELS[clientId]}`} checked={checked}
                              disabled={busy || (disabled && !checked)} className="h-4 w-4 shrink-0 accent-primary"
                              onChange={(event) => {
                                if (event.target.checked) void applyExistingConfiguration(record, clientId)
                                else void restore(record, clientId)
                              }} />
                            <span>{AI_CLIENT_LABELS[clientId]}</span>
                            {applying?.keyId === record.id && applying.clientId === clientId
                              ? <span role="status" className="text-xs text-muted-foreground">应用中…</span>
                              : null}
                          </label> : <span className="min-w-0 flex-1 text-sm">{AI_CLIENT_LABELS[clientId]}</span>}
                          {clientConfigurationBridge ? <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0"
                            aria-label={`刷新 ${label} 的 ${AI_CLIENT_LABELS[clientId]} endpoint`}
                            title={checked ? '保留当前 Key，刷新客户端连接地址' : '应用后可刷新连接地址'}
                            disabled={busy || disabled || !checked}
                            onClick={() => void applyExistingConfiguration(record, clientId, true)}>
                            <RefreshCw className={cn('h-4 w-4', applying?.keyId === record.id && applying.clientId === clientId && 'animate-spin')} />
                          </Button> : null}
                          <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">{copiedClient ? '已复制' : ''}</span>
                          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0"
                            aria-label={`复制 ${label} 的 ${AI_CLIENT_LABELS[clientId]} 配置`}
                            title={copiedClient ? '已复制' : `复制 ${AI_CLIENT_LABELS[clientId]} 配置`} disabled={busy}
                            onClick={() => void copyExistingConfiguration(record, clientId)}>
                            {copiedClient ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                          </Button>
                        </div>
                      })}
                    </div>
                  </details>
                  <div className="flex shrink-0 items-center">
                  {record.kind !== 'client-credentials' ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-pressed={!disabled}
                    aria-label={`${disabled ? '启用' : '停用'} ${label}`}
                    title={`${disabled ? '启用' : '停用'} ${label}`}
                    disabled={busy}
                    onClick={() => void setEnabled(record, disabled)}
                  >
                    <Power className={cn('h-4 w-4', !disabled && 'text-emerald-600')} />
                  </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-label={`删除 ${label}`}
                    title={hasApplication ? '请先撤回已应用的配置' : `删除 ${label}`}
                    disabled={busy || hasApplication}
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

function suffixHint(id: string): string {
  return `••••••••${id.slice(-8)}`
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : ''
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return '无法连接配置服务，请检查连接后重试。'
  }
  if (/EACCES|permission denied/i.test(message)) {
    return '没有权限写入配置文件，请检查文件权限后重试。'
  }
  if (message === 'Client configuration could not be verified locally.') {
    return '配置文件写入后的本地检查未通过，请检查文件内容和权限后重试。'
  }
  if (!message || /^(?:AI Connection |AI client configuration )?request failed(?:\. Please try again\.)?$/i.test(message)) {
    return 'API Key 操作失败，请重试。'
  }
  return message
}
