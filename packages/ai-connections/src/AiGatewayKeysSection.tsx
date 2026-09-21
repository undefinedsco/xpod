import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  TooltipProvider,
  controlFocusClass,
  dismissToast,
  toast,
} from '@undefineds.co/shared-ui'
import { Check, Loader2, Plus, Settings2 } from 'lucide-react'
import type {
  AiConnectionsClient,
  GatewayKeyRecord,
  AiGatewayModel,
} from './contract/ai-connections-client'
import {
  AI_CONNECTIONS_CLIENTS,
  AI_CLIENT_LABELS,
  manualConfigurationText,
  type AiClientConfigurationBridge,
  type AiConnectionsClientId,
} from './AiClientConfigurationSection'
import { AiCopyButton } from './AiCopyButton'
import { AiEndpointList } from './AiEndpointList'
import { AiProviderHeader } from './AiProviderHeader'
import { xpodProtocolEndpoints } from './gateway-endpoints'
import { XPOD_AVATAR } from './provider-visuals'
import { AiGatewayKeyRow } from './AiGatewayKeyRow'
import { AiGatewayModelsSection, type GatewayModelSelection } from './AiGatewayModelsSection'

const DEFAULT_KEY_NAME = '我的 API Key'
const CREATED_NOTIFICATION = 'API Key 已创建，请复制或应用到客户端。'
const UNPERSISTED_COPY_MESSAGE = '这个 API Key 只在创建时可见：请销毁它，然后重新创建并立即复制或应用。'
const UNPERSISTED_APPLY_MESSAGE = '这个 API Key 只在创建时可见：请销毁它，然后重新创建并直接应用到客户端。'
/** Header tooltip: what Xpod is, then how the Key itself is protected. */
const XPOD_DESCRIPTION = '把已接入的 Provider 模型统一发布给编码客户端，兼容 OpenAI 与 Anthropic 协议。'
const XPOD_CREDENTIAL_NOTE = 'API Key 保存在当前 Pod，由 Pod 权限保护；Xpod 不保存明文。'
const SELECT_CLASS = [
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm transition-[border-color]',
  'disabled:cursor-not-allowed disabled:opacity-50',
  controlFocusClass,
].join(' ')

/**
 * The Xpod provider page. From a coding client's point of view Xpod is just
 * another provider, so this surface shares the provider pages' components: the
 * same header (`AiProviderHeader`), the same model list (`AiGatewayModelsSection`
 * over `AiModelCatalog`), and the same endpoint list (`AiEndpointList`) that the
 * provider pages use for their offerings' protocols.
 */
export function AiGatewayKeysSection({
  client,
  clientConfigurationBridge,
  gatewayModels,
  modelSelection,
  liveRevision = 0,
}: {
  client: AiConnectionsClient
  clientConfigurationBridge?: AiClientConfigurationBridge
  gatewayModels?: AiGatewayModel[]
  /** Publishes or withdraws models on the models list endpoint, from this page. */
  modelSelection?: GatewayModelSelection
  /**
   * Advances when the credentials table changed outside this page (another
   * client, a script); the Key list lives in that table and re-reads with it.
   */
  liveRevision?: number
}) {
  const [keys, setKeys] = useState<GatewayKeyRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState(DEFAULT_KEY_NAME)
  const [purpose, setPurpose] = useState<AiConnectionsClientId | ''>('')
  const [creating, setCreating] = useState(false)
  // The key issued by the running creation flow: the row is already in the
  // list, but the wrapper handed out below is the only copy that exists.
  const [issued, setIssued] = useState<GatewayKeyRecord>()
  const [issuedClient, setIssuedClient] = useState<AiConnectionsClientId>()
  const [appliedClient, setAppliedClient] = useState<AiConnectionsClientId>()
  const [applying, setApplying] = useState(false)
  const [busyKeyId, setBusyKeyId] = useState<string>()
  const [error, setError] = useState<string>()
  const plaintexts = useRef(new Map<string, string>())
  const operation = useRef(false)
  const notification = useRef<string | undefined>(undefined)

  const notify = useCallback((options: Parameters<typeof toast>[0]) => {
    if (notification.current) dismissToast(notification.current)
    notification.current = toast(options)
  }, [])

  const notifyError = useCallback((cause: unknown) => {
    notify({ variant: 'destructive', description: errorMessage(cause), duration: 8000 })
  }, [notify])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(undefined)
    // The wrapper cache belongs to the session that created the keys; a new
    // client means a new session and no copy may survive it.
    plaintexts.current.clear()
    void client.listGatewayKeys()
      .then((records) => {
        if (active) setKeys(records.filter((record) => !record.revokedAt))
      })
      .catch((cause) => {
        if (active) notifyError(cause)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      if (notification.current) dismissToast(notification.current)
    }
  }, [client, notifyError])

  // A change made elsewhere only needs new rows: it must not drop the wrapper
  // copies this session is still showing, nor flash the loading state.
  useEffect(() => {
    if (liveRevision === 0) return
    let active = true
    void client.listGatewayKeys()
      .then((records) => {
        if (active) setKeys(records.filter((record) => !record.revokedAt))
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [client, liveRevision])

  const openCreate = () => {
    setError(undefined)
    setName(DEFAULT_KEY_NAME)
    setPurpose('')
    // A key issued earlier in this session keeps its wrapper in the cache, so
    // the flow resumes there instead of pretending the key was never created.
    setShowCreate(true)
  }

  const beginAnother = () => {
    setIssued(undefined)
    setIssuedClient(undefined)
    setAppliedClient(undefined)
    setError(undefined)
    setName(DEFAULT_KEY_NAME)
    setPurpose('')
  }

  const create = async () => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('请填写 API Key 名称。')
      return
    }
    if (!purpose) {
      setError('请选择 API Key 的用途。')
      return
    }
    setCreating(true)
    setError(undefined)
    try {
      const created = await client.createGatewayKey({
        name: trimmedName,
        // Declared at creation: the key is for this client application, and the
        // record carries where it is in effect.
        appliedTo: purpose,
      })
      plaintexts.current.set(created.record.id, created.plaintext)
      setKeys((current) => [created.record, ...current.filter((record) => record.id !== created.record.id)])
      setIssued(created.record)
      setIssuedClient(purpose)
      setAppliedClient(undefined)
      notify({ variant: 'success', description: CREATED_NOTIFICATION })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setCreating(false)
    }
  }

  const sessionPlaintext = (record: GatewayKeyRecord, message: string): string => {
    const plaintext = plaintexts.current.get(record.id)
    if (!plaintext) throw new Error(message)
    return plaintext
  }

  const apply = async () => {
    if (!issued || !issuedClient || !clientConfigurationBridge) return
    setError(undefined)
    let plaintext: string
    try {
      plaintext = sessionPlaintext(issued, UNPERSISTED_APPLY_MESSAGE)
    } catch (cause) {
      setError(errorMessage(cause))
      return
    }
    setApplying(true)
    try {
      const plan = await clientConfigurationBridge.plan({
        client: issuedClient,
        endpoint: client.apiBase,
        ...(issuedClient === 'codex' && gatewayModels !== undefined ? {
          activeModels: gatewayModels.map(({ id, provider, displayName, availability, contextWindow, inputModalities, capabilities }) => ({
            id, provider, displayName, availability, contextWindow, inputModalities, capabilities,
          })),
        } : {}),
      })
      await clientConfigurationBridge.apply({
        client: plan.client,
        planId: plan.planId,
        apiKey: plaintext,
        ...(plan.confirmation?.required ? { confirmation: {
          token: plan.confirmation.token,
          targetHash: plan.confirmation.targetHash,
        } } : {}),
      })
      setAppliedClient(plan.client)
      // The record now points at the client the wrapper was written into.
      setKeys((current) => current.map((record) => record.id === issued.id
        ? { ...record, appliedTo: plan.client }
        : record))
      notify({ variant: 'success', description: plan.client === 'codex' && gatewayModels === undefined
        ? 'Codex 连接配置已应用，模型目录尚未加载，请稍后刷新配置。'
        : `${AI_CLIENT_LABELS[plan.client]} 配置已应用。` })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setApplying(false)
    }
  }

  const destroy = async (record: GatewayKeyRecord) => {
    if (operation.current) return
    operation.current = true
    setBusyKeyId(record.id)
    setError(undefined)
    try {
      await client.deleteGatewayKey(record.id)
      plaintexts.current.delete(record.id)
      setKeys((current) => current.filter((item) => item.id !== record.id))
      if (issued?.id === record.id) {
        setIssued(undefined)
        setIssuedClient(undefined)
        setAppliedClient(undefined)
      }
    } catch (cause) {
      notifyError(cause)
    } finally {
      operation.current = false
      setBusyKeyId(undefined)
    }
  }

  return (
    <TooltipProvider>
      <section className="space-y-8" aria-label="API Keys">
        <AiProviderHeader
          name="Xpod"
          mark="XP"
          avatar={XPOD_AVATAR}
          infoLabel="Xpod 说明"
          infoLines={[XPOD_DESCRIPTION, XPOD_CREDENTIAL_NOTE]}
          link={{ href: client.apiBase, label: '访问 Xpod' }}
          badge={(
            <Badge variant={keys.length > 0 ? 'default' : 'secondary'}>
              {keys.length > 0 ? `已签发 ${keys.length} 个` : '未配置'}
            </Badge>
          )}
        />

        <section className="space-y-3" aria-label="当前连接">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-medium text-foreground/90">
              <Settings2 aria-hidden="true" className="h-4 w-4 text-primary" />当前连接
            </h3>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" aria-label="新建 API Key"
                disabled={creating || loading} onClick={openCreate}>
                <Plus aria-hidden="true" className="h-3.5 w-3.5" />API Key
              </Button>
            </div>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />正在读取 API Key
            </div>
          ) : keys.length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">尚未签发 API Key</p>
          ) : (
            <ul aria-label="API Key 列表" className="rounded-xl border border-border/70">
              {keys.map((record) => (
                <AiGatewayKeyRow
                  key={record.id}
                  record={record}
                  busy={Boolean(busyKeyId)}
                  onDestroy={() => void destroy(record)}
                />
              ))}
            </ul>
          )}
          <details className="text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer">接入信息</summary>
            <div className="mt-2 space-y-3">
              <section className="space-y-2" aria-labelledby="xpod-access-info">
                <h4 id="xpod-access-info" className="text-sm font-medium text-foreground">Xpod 接入信息</h4>
                <p className="text-xs text-muted-foreground">
                  API Key 是签发给客户端应用的 CSS 客户端凭据；Pod 只记录它绑定到哪个客户端，不保存 Key 明文。
                </p>
                <p className="text-xs text-muted-foreground">
                  同一个 API Key 支持以下兼容协议，按客户端选择并复制对应地址：
                </p>
                <AiEndpointList endpoints={xpodProtocolEndpoints(client.apiBase)} copy display="protocol" />
              </section>
            </div>
          </details>
        </section>

        <AiGatewayModelsSection models={gatewayModels} selection={modelSelection} />

        <Dialog open={showCreate} onOpenChange={(open) => { if (!open && (creating || applying)) return; setShowCreate(open) }}>
          <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>{issued ? 'API Key 已签发' : '新建 API Key'}</DialogTitle>
            </DialogHeader>
            {issued && issuedClient ? (
              <div className="space-y-5">
                <div className="space-y-1.5">
                  <p className="text-sm">
                    已签发「{issued.name || '未命名 API Key'}」，用途：{AI_CLIENT_LABELS[issuedClient]}。
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Xpod 不保存 Key 明文，请立即复制或直接应用到客户端；离开本次会话后无法再次获取。
                  </p>
                </div>
                {issued.maskedHint ? (
                  <code className="block truncate rounded-md border border-border/60 bg-muted/30 px-3 py-2 font-mono text-xs text-muted-foreground">
                    {issued.maskedHint}
                  </code>
                ) : null}
                {!clientConfigurationBridge ? (
                  <p className="text-xs text-muted-foreground">当前 Web 环境无法自动写入客户端配置，请复制后手动粘贴；自动应用需要本机连接。</p>
                ) : null}
                {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <AiCopyButton
                    value={() => sessionPlaintext(issued, UNPERSISTED_COPY_MESSAGE)}
                    label="API Key"
                    text="复制 API Key"
                    disabled={applying}
                    iconClassName="mr-1.5 h-3.5 w-3.5"
                    copiedIconClassName="mr-1.5 h-3.5 w-3.5 text-emerald-600"
                    onError={(cause) => setError(errorMessage(cause))}
                  />
                  <AiCopyButton
                    value={() => manualConfigurationText(
                      issuedClient,
                      client.apiBase,
                      sessionPlaintext(issued, UNPERSISTED_COPY_MESSAGE),
                    )}
                    label={`${AI_CLIENT_LABELS[issuedClient]} 配置`}
                    text={`复制 ${AI_CLIENT_LABELS[issuedClient]} 配置`}
                    disabled={applying}
                    iconClassName="mr-1.5 h-3.5 w-3.5"
                    copiedIconClassName="mr-1.5 h-3.5 w-3.5 text-emerald-600"
                    onError={(cause) => setError(errorMessage(cause))}
                  />
                  {clientConfigurationBridge ? (
                    appliedClient ? (
                      <span role="status" className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Check aria-hidden="true" className="h-3.5 w-3.5" />已应用到 {AI_CLIENT_LABELS[appliedClient]}
                      </span>
                    ) : (
                      <Button type="button" size="sm" disabled={applying}
                        aria-label={`应用到 ${AI_CLIENT_LABELS[issuedClient]}`}
                        onClick={() => void apply()}>
                        {applying ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : null}
                        {applying ? '正在应用…' : `应用到 ${AI_CLIENT_LABELS[issuedClient]}`}
                      </Button>
                    )
                  ) : null}
                </div>
                <DialogFooter>
                  <Button type="button" variant="ghost" disabled={applying} onClick={beginAnother}>再建一个</Button>
                  <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>完成</Button>
                </DialogFooter>
              </div>
            ) : (
              <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); if (!creating) void create() }}>
                <label className="block space-y-2">
                  <span className="text-sm font-medium">名称</span>
                  <Input autoFocus aria-label="API Key 名称" value={name} disabled={creating}
                    onChange={(event) => setName(event.target.value)} />
                </label>
                <label className="block space-y-2">
                  <span className="text-sm font-medium">用途</span>
                  <select
                    aria-label="API Key 用途"
                    className={SELECT_CLASS}
                    value={purpose}
                    disabled={creating}
                    onChange={(event) => setPurpose(event.target.value as AiConnectionsClientId)}
                  >
                    <option value="" disabled>选择客户端应用</option>
                    {AI_CONNECTIONS_CLIENTS.map((clientId) => (
                      <option key={clientId} value={clientId}>{AI_CLIENT_LABELS[clientId]}</option>
                    ))}
                  </select>
                </label>
                <p className="text-xs text-muted-foreground">用途在创建时确定，Key 会绑定到该客户端应用。</p>
                {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                <DialogFooter>
                  <Button type="button" variant="outline" disabled={creating} onClick={() => setShowCreate(false)}>取消</Button>
                  <Button type="submit" aria-label="创建 API Key" disabled={creating || !name.trim() || !purpose}>
                    {creating ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : null}
                    {creating ? '正在创建…' : '创建 API Key'}
                  </Button>
                </DialogFooter>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </section>
    </TooltipProvider>
  )
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
