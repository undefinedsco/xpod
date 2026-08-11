import { useEffect, useState } from 'react'
import {
  Badge,
  Button,
  Input,
} from '@undefineds.co/shared-ui'
import { MonitorCog, RotateCcw } from 'lucide-react'
import { normalizeAiConnectionsThrownError } from './ai-connections-client'

export const AI_CONNECTIONS_CLIENTS = ['codex', 'claude-code', 'pi', 'codebuddy'] as const
export type AiConnectionsClientId = (typeof AI_CONNECTIONS_CLIENTS)[number]

export interface AiClientConfigurationStatus {
  status: 'notConfigured' | 'configured' | 'drifted' | 'unavailable' | 'unverifiable' | 'failedAndRestored'
  message?: string
}

export interface AiClientConfigurationConfirmation {
  required: boolean
  token: string
  targetHash: string
  message?: string
}

export interface AiClientConfigurationDryRun {
  planId: string
  client: AiConnectionsClientId
  confirmation?: AiClientConfigurationConfirmation
  changes: Array<{
    target: string
    action: 'update' | 'createOrUpdate' | 'delete'
    backup: boolean
  }>
}

export interface AiClientConfigurationBridge {
  inspect(client: AiConnectionsClientId): Promise<AiClientConfigurationStatus>
  plan(input: {
    client: AiConnectionsClientId
    endpoint: string
  }): Promise<AiClientConfigurationDryRun>
  apply(input: {
    client: AiConnectionsClientId
    planId: string
    apiKey: string
    confirmation?: {
      token: string
      targetHash: string
    }
  }): Promise<{ applied: true }>
  verify(input: {
    client: AiConnectionsClientId
    planId: string
  }): Promise<AiClientConfigurationStatus>
  restore(client: AiConnectionsClientId): Promise<AiClientConfigurationStatus>
}

export const AI_CLIENT_LABELS: Record<AiConnectionsClientId, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  pi: 'Pi',
  codebuddy: 'CodeBuddy',
}

export interface ManagedClientCredentialLease {
  apiKey: string
  revoke(): Promise<void>
}

export function AiClientConfigurationSection({
  bridge,
  endpoint,
  createClientCredential,
}: {
  bridge?: AiClientConfigurationBridge
  endpoint: string
  createClientCredential?: (client: AiConnectionsClientId) => Promise<ManagedClientCredentialLease>
}) {
  const [statuses, setStatuses] = useState<Partial<Record<AiConnectionsClientId, AiClientConfigurationStatus>>>({})
  const [plans, setPlans] = useState<Partial<Record<AiConnectionsClientId, AiClientConfigurationDryRun>>>({})
  const [confirmations, setConfirmations] = useState<Partial<Record<AiConnectionsClientId, string>>>({})
  const [busy, setBusy] = useState<AiConnectionsClientId>()

  useEffect(() => {
    if (!bridge) return
    let active = true
    void Promise.all(AI_CONNECTIONS_CLIENTS.map(async (client) => {
      let status: AiClientConfigurationStatus
      try {
        status = await bridge.inspect(client)
      } catch (error) {
        status = { status: 'unavailable', message: errorMessage(error) }
      }
      if (active) {
        setStatuses((current) => ({ ...current, [client]: status }))
      }
    }))
    return () => {
      active = false
    }
  }, [bridge])

  const plan = async (client: AiConnectionsClientId) => {
    if (!bridge) return
    setBusy(client)
    try {
      const dryRun = await bridge.plan({
        client,
        endpoint,
      })
      setPlans((current) => ({ ...current, [client]: dryRun }))
      setConfirmations((current) => ({ ...current, [client]: '' }))
    } catch (error) {
      setStatuses((current) => ({
        ...current,
        [client]: { status: 'unavailable', message: errorMessage(error) },
      }))
    } finally {
      setBusy(undefined)
    }
  }

  const apply = async (client: AiConnectionsClientId) => {
    const dryRun = plans[client]
    if (!bridge || !dryRun || !createClientCredential) return
    setBusy(client)
    let lease: ManagedClientCredentialLease | undefined
    let applied = false
    try {
      lease = await createClientCredential(client)
      await bridge.apply({
        client,
        planId: dryRun.planId,
        apiKey: lease.apiKey,
        ...(dryRun.confirmation?.required ? {
          confirmation: {
            token: dryRun.confirmation.token,
            targetHash: dryRun.confirmation.targetHash,
          },
        } : {}),
      })
      applied = true
      const status = await bridge.verify({ client, planId: dryRun.planId })
      setStatuses((current) => ({ ...current, [client]: status }))
      setPlans((current) => ({ ...current, [client]: undefined }))
    } catch (error) {
      let recoveryMessage = errorMessage(error)
      if (lease && !applied) {
        try {
          await lease.revoke()
        } catch (revokeError) {
          recoveryMessage = `${recoveryMessage}；自动撤销客户端凭证失败：${errorMessage(revokeError)}。请在“高级：客户端凭证管理”中手动撤销。`
        }
      }
      setStatuses((current) => ({
        ...current,
        [client]: failedAndRestoredError(error)
          ? { status: 'failedAndRestored', message: '配置验证失败，已自动恢复原配置。' }
          : { status: 'unavailable', message: recoveryMessage },
      }))
    } finally {
      setBusy(undefined)
    }
  }

  const restore = async (client: AiConnectionsClientId) => {
    if (!bridge) return
    setBusy(client)
    try {
      const status = await bridge.restore(client)
      setStatuses((current) => ({ ...current, [client]: status }))
    } catch (error) {
      setStatuses((current) => ({
        ...current,
        [client]: { status: 'unavailable', message: errorMessage(error) },
      }))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <section className="space-y-4">
      <div className="border-b border-border/40 pb-2">
        <div className="flex items-center gap-2">
          <MonitorCog className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-medium text-foreground/90">客户端凭证</h3>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          为 Codex、Claude Code、Pi 和 CodeBuddy 配置访问 Xpod 的客户端凭证；它不是真实的 Provider API Key。
        </p>
      </div>
      <div className="space-y-2">
        {AI_CONNECTIONS_CLIENTS.map((client) => {
          const status = statuses[client] ?? {
            status: bridge ? 'notConfigured' : 'unavailable',
            message: bridge ? undefined : '当前 Host 不支持修改本机客户端配置。',
          }
          const dryRun = plans[client]
          const confirmation = dryRun?.confirmation
          const confirmationValue = confirmations[client] ?? ''
          const confirmationSatisfied = !confirmation?.required || confirmationValue === confirmation.token
          return (
            <div key={client} className="space-y-3 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">{AI_CLIENT_LABELS[client]}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {status.message ?? statusLabel(status.status)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{statusLabel(status.status)}</Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!bridge || Boolean(busy)}
                    onClick={() => void plan(client)}
                  >
                    配置
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`恢复 ${AI_CLIENT_LABELS[client]} 配置`}
                    disabled={!bridge || status.status === 'notConfigured' || Boolean(busy)}
                    onClick={() => void restore(client)}
                  >
                    <RotateCcw className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              {dryRun ? (
                <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                  <div className="text-xs font-medium">将执行以下更改</div>
                  {dryRun.changes.map((change) => (
                    <div key={`${change.target}:${change.action}`} className="text-xs text-muted-foreground">
                      <span className="font-mono">{change.target}</span>
                      {' · '}
                      {changeActionLabel(change.action)}
                      {change.backup ? ' · 创建备份' : ''}
                    </div>
                  ))}
                  {confirmation?.required ? (
                    <div className="space-y-2">
                      {confirmation.message ? (
                        <div className="text-xs text-muted-foreground">{confirmation.message}</div>
                      ) : null}
                      <div className="text-xs text-muted-foreground">
                        确认码：<code className="font-mono text-foreground">{confirmation.token}</code>
                      </div>
                      <Input
                        aria-label={`输入确认码以应用 ${AI_CLIENT_LABELS[client]} 配置`}
                        value={confirmationValue}
                        onChange={(event) => setConfirmations((current) => ({
                          ...current,
                          [client]: event.target.value,
                        }))}
                      />
                    </div>
                  ) : null}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      aria-label={confirmation?.required
                        ? `确认并应用 ${AI_CLIENT_LABELS[client]} 配置`
                        : `应用 ${AI_CLIENT_LABELS[client]} 配置`}
                      disabled={!createClientCredential || Boolean(busy) || !confirmationSatisfied}
                      onClick={() => void apply(client)}
                    >
                      {confirmation?.required ? '确认并应用' : '应用更改'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={Boolean(busy)}
                      onClick={() => {
                        setPlans((current) => ({ ...current, [client]: undefined }))
                        setConfirmations((current) => ({ ...current, [client]: undefined }))
                      }}
                    >
                      取消
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function changeActionLabel(
  action: AiClientConfigurationDryRun['changes'][number]['action'],
): string {
  switch (action) {
    case 'update': return '更新'
    case 'delete': return '删除'
    default: return '创建或更新'
  }
}

function statusLabel(status: AiClientConfigurationStatus['status']): string {
  switch (status) {
    case 'configured': return '已配置'
    case 'drifted': return '配置已变化'
    case 'unverifiable': return '无法验证'
    case 'failedAndRestored': return '已恢复'
    case 'unavailable': return '当前不可用'
    default: return '未配置'
  }
}

function failedAndRestoredError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error &&
    (error as { code?: unknown }).code === 'verification_failed_restored')
}

function errorMessage(error: unknown): string {
  return normalizeAiConnectionsThrownError(error)
}
