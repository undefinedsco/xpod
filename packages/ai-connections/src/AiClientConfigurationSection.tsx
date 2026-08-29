import { useEffect, useRef, useState } from 'react'
import {
  Badge,
  Button,
  Input,
} from '@undefineds.co/shared-ui'
import { Bot, Code2, Copy, Pi, RotateCcw, SquareTerminal } from 'lucide-react'
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
  launch?(client: AiConnectionsClientId): Promise<{ launched: true }>
}

export const AI_CLIENT_LABELS: Record<AiConnectionsClientId, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  pi: 'Pi',
  codebuddy: 'CodeBuddy',
}

export function AiClientIcon({ client, className = 'h-4 w-4' }: {
  client: AiConnectionsClientId
  className?: string
}) {
  switch (client) {
    case 'claude-code': return <Bot className={className} aria-hidden="true" />
    case 'pi': return <Pi className={className} aria-hidden="true" />
    case 'codebuddy': return <Code2 className={className} aria-hidden="true" />
    default: return <SquareTerminal className={className} aria-hidden="true" />
  }
}

export interface ManagedClientCredentialLease {
  apiKey: string
  revoke(): Promise<void>
}

export function AiClientConfigurationSection({
  bridge,
  endpoint,
  client,
  createClientCredential,
  manualApiKey,
  autoApply = false,
  compact = false,
  onComplete,
}: {
  bridge?: AiClientConfigurationBridge
  endpoint: string
  client: AiConnectionsClientId
  createClientCredential?: (client: AiConnectionsClientId) => Promise<ManagedClientCredentialLease>
  manualApiKey?: string
  autoApply?: boolean
  compact?: boolean
  onComplete?: () => void
}) {
  const [status, setStatus] = useState<AiClientConfigurationStatus>({ status: 'notConfigured' })
  const [dryRun, setDryRun] = useState<AiClientConfigurationDryRun>()
  const [confirmationValue, setConfirmationValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [copiedManualConfig, setCopiedManualConfig] = useState(false)
  const autoApplyStarted = useRef(false)

  useEffect(() => {
    setDryRun(undefined)
    setConfirmationValue('')
    setCopiedManualConfig(false)
    if (!bridge) {
      setStatus({ status: 'unavailable' })
      return
    }
    if (autoApply) return
    let active = true
    void (async () => {
      let nextStatus: AiClientConfigurationStatus
      try {
        nextStatus = await bridge.inspect(client)
      } catch (error) {
        nextStatus = { status: 'unavailable', message: errorMessage(error) }
      }
      if (active) setStatus(nextStatus)
    })()
    return () => {
      active = false
    }
  }, [autoApply, bridge, client])

  const applyPlan = async (plan: AiClientConfigurationDryRun) => {
    if (!bridge || !createClientCredential) return
    setBusy(true)
    let lease: ManagedClientCredentialLease | undefined
    let applied = false
    try {
      lease = await createClientCredential(client)
      await bridge.apply({
        client,
        planId: plan.planId,
        apiKey: lease.apiKey,
        ...(plan.confirmation?.required ? {
          confirmation: {
            token: plan.confirmation.token,
            targetHash: plan.confirmation.targetHash,
          },
        } : {}),
      })
      applied = true
      const nextStatus = await bridge.verify({ client, planId: plan.planId })
      setStatus(nextStatus)
      setDryRun(undefined)
      if (nextStatus.status === 'configured') {
        onComplete?.()
      }
    } catch (error) {
      let recoveryMessage = errorMessage(error)
      if (recoveryMessage === 'AI Connection request failed. Please try again.') {
        recoveryMessage = `${AI_CLIENT_LABELS[client]} 配置失败。请重试。`
      }
      if (lease && !applied) {
        try {
          await lease.revoke()
        } catch (revokeError) {
          recoveryMessage = `${recoveryMessage}；自动撤销 API Key 失败：${errorMessage(revokeError)}。请在“API KEYS”中手动撤销。`
        }
      }
      setStatus(failedAndRestoredError(error)
        ? { status: 'failedAndRestored', message: '配置验证失败，已自动恢复原配置。' }
        : { status: 'unavailable', message: recoveryMessage })
    } finally {
      setBusy(false)
    }
  }

  const plan = async () => {
    if (!bridge) return
    setBusy(true)
    try {
      const nextDryRun = await bridge.plan({
        client,
        endpoint,
      })
      if (autoApply && !nextDryRun.confirmation?.required && createClientCredential) {
        await applyPlan(nextDryRun)
      } else {
        setDryRun(nextDryRun)
        setConfirmationValue('')
      }
    } catch (error) {
      setStatus({ status: 'unavailable', message: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  const apply = async () => {
    if (!bridge || !dryRun || !createClientCredential) return
    await applyPlan(dryRun)
  }

  useEffect(() => {
    if (!autoApply || !bridge || !createClientCredential || autoApplyStarted.current) return
    autoApplyStarted.current = true
    void plan()
  }, [autoApply, bridge, createClientCredential])

  const restore = async () => {
    if (!bridge) return
    setBusy(true)
    try {
      setStatus(await bridge.restore(client))
    } catch (error) {
      setStatus({ status: 'unavailable', message: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  const confirmation = dryRun?.confirmation
  const confirmationSatisfied = !confirmation?.required || confirmationValue === confirmation.token
  const clientLabel = AI_CLIENT_LABELS[client]
  const manual = !bridge
  const copyManualConfig = async () => {
    await navigator.clipboard?.writeText(manualConfigurationText(client, endpoint, manualApiKey))
    setCopiedManualConfig(true)
  }

  return (
    <div className={compact ? '' : 'overflow-hidden rounded-md border border-border/60'}>
      {!compact ? <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <AiClientIcon client={client} />
        </span>
        <div className="min-w-[10rem] flex-1">
          <div className="text-sm font-medium">{clientLabel}</div>
          {!manual ? <div className="mt-0.5 text-xs text-muted-foreground">
            {status.message ?? (status.status === 'configured'
                ? `${clientLabel} 正在使用 Xpod。`
                : '可自动写入本机配置。')}
          </div> : null}
        </div>
        {!manual ? <Badge variant="secondary">{statusLabel(status.status)}</Badge> : null}
        {manual ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`复制 ${clientLabel} 配置`}
            title={`复制 ${clientLabel} 配置`}
            onClick={() => void copyManualConfig()}
          >
            <Copy className="h-4 w-4" />
            <span className="sr-only">{copiedManualConfig ? '已复制' : '复制配置'}</span>
          </Button>
        ) : (
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              aria-label={`配置 ${clientLabel}`}
              disabled={busy}
              onClick={() => void plan()}
            >
              配置
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`恢复 ${clientLabel} 配置`}
              disabled={status.status === 'notConfigured' || busy}
              onClick={() => void restore()}
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div> : null}
      {compact && busy ? (
        <div className="py-1 text-xs text-muted-foreground">正在应用 {clientLabel} 配置…</div>
      ) : null}
      {compact && !busy && status.message ? (
        <div className="flex flex-wrap items-center justify-between gap-2 py-1 text-xs text-destructive">
          <span>{status.message}</span>
          <Button variant="outline" size="sm" onClick={() => void plan()}>
            重试应用配置
          </Button>
        </div>
      ) : null}
      {dryRun ? (
        <div className="space-y-3 border-t border-border/60 bg-muted/20 px-4 py-3">
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
              {confirmation.message ? <div className="text-xs text-muted-foreground">{confirmation.message}</div> : null}
              <div className="text-xs text-muted-foreground">
                确认码：<code className="font-mono text-foreground">{confirmation.token}</code>
              </div>
              <Input
                aria-label={`输入确认码以应用 ${clientLabel} 配置`}
                value={confirmationValue}
                onChange={(event) => setConfirmationValue(event.target.value)}
              />
            </div>
          ) : null}
          <div className="flex gap-2">
            <Button
              size="sm"
              aria-label={confirmation?.required
                ? `确认并应用 ${clientLabel} 配置`
                : `应用 ${clientLabel} 配置`}
              disabled={!createClientCredential || busy || !confirmationSatisfied}
              onClick={() => void apply()}
            >
              {confirmation?.required ? '确认并应用' : '应用配置'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setDryRun(undefined)
                setConfirmationValue('')
              }}
            >
              取消
            </Button>
          </div>
        </div>
      ) : null}
    </div>
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
    case 'unavailable': return '需手动配置'
    default: return '未配置'
  }
}

export function manualConfigurationText(client: AiConnectionsClientId, endpoint: string, apiKey?: string): string {
  const secret = apiKey ?? '<粘贴 Xpod API Key>'
  const baseUrl = endpoint.trim().replace(/\/+$/, '')
  const v1Url = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`
  const messagesUrl = baseUrl.replace(/\/v1$/, '')

  switch (client) {
    case 'codex':
      return [
        '# ~/.codex/config.toml',
        'model_provider = "xpod"',
        '',
        '[model_providers.xpod]',
        'name = "Xpod AI Connection"',
        `base_url = ${JSON.stringify(v1Url)}`,
        'wire_api = "responses"',
        'requires_openai_auth = true',
        '',
        '# ~/.codex/auth.json（合并到现有 JSON）',
        JSON.stringify({ OPENAI_API_KEY: secret }, null, 2),
      ].join('\n')
    case 'claude-code':
      return [
        '# ~/.claude/settings.json（合并 env 到现有 JSON）',
        JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: messagesUrl,
            ANTHROPIC_AUTH_TOKEN: secret,
          },
        }, null, 2),
      ].join('\n')
    case 'pi':
      return [
        '# ~/.pi/agent/settings.json（合并到现有 JSON，并将 <model-id> 替换为实际模型）',
        JSON.stringify({ defaultProvider: 'xpod', defaultModel: '<model-id>' }, null, 2),
        '',
        '# ~/.pi/agent/models.json（合并 providers.xpod 到现有 JSON）',
        JSON.stringify({
          providers: {
            xpod: {
              baseUrl: v1Url,
              apiKey: secret,
              authHeader: true,
              api: 'openai-responses',
              models: [{ id: '<model-id>', name: '<model-id>' }],
            },
          },
        }, null, 2),
      ].join('\n')
    case 'codebuddy':
      return [
        '# ~/.codebuddy/settings.json（合并 env 到现有 JSON）',
        JSON.stringify({
          env: {
            CODEBUDDY_BASE_URL: v1Url,
            CODEBUDDY_API_KEY: secret,
          },
        }, null, 2),
      ].join('\n')
  }
}

function failedAndRestoredError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error &&
    (error as { code?: unknown }).code === 'verification_failed_restored')
}

function errorMessage(error: unknown): string {
  return normalizeAiConnectionsThrownError(error)
}
