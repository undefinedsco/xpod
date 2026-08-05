import {
  Badge,
  Button,
  Input,
} from '@undefineds.co/shared-ui'
import type {
  AiConnectAttempt,
  AiGatewayModel,
  AiQuotaSnapshot,
} from './ai-connections-client'
import {
  ExternalLink,
  KeyRound,
  Loader2,
  LogOut,
  RotateCw,
} from 'lucide-react'
import { AiQuotaCard } from './AiQuotaCard'

export type { AiProviderDefinition } from './controller'
import type { AiProviderDefinition } from './controller'

export type ProviderConnectionState =
  | 'unknown'
  | 'pending'
  | 'configured'
  | 'connected'
  | 'disconnected'
  | 'reauthRequired'
  | 'failed'

export function AiProviderCard({
  definition,
  status,
  accountLabel,
  attempt,
  apiKey,
  busy,
  disabled = false,
  error,
  quota,
  models,
  onApiKeyChange,
  onBeginApiKey,
  onBeginBrowser,
  onSaveApiKey,
  onDisconnect,
  onRefreshQuota,
}: {
  definition: AiProviderDefinition
  status: ProviderConnectionState
  accountLabel?: string
  attempt?: AiConnectAttempt
  apiKey: string
  busy: boolean
  disabled?: boolean
  error?: string
  quota?: AiQuotaSnapshot
  models: AiGatewayModel[]
  onApiKeyChange: (value: string) => void
  onBeginApiKey: () => void
  onBeginBrowser: () => void
  onSaveApiKey: () => void
  onDisconnect: () => void
  onRefreshQuota: () => void
}) {
  const apiKeyAttempt = attempt?.mode === 'browserAssistedApiKey' && attempt.status === 'pending'
  const isConfigured = status === 'configured'
  const isConnected = status === 'connected'

  return (
    <div>
      <header className="flex items-start justify-between gap-4 pb-5">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">{definition.name}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {providerDescription(definition.id)}
          </p>
        </div>
        <Badge variant={isConnected || isConfigured ? 'default' : 'secondary'}>
          {connectionStatusLabel(status)}
        </Badge>
      </header>

      <section className="border-t border-border/60 py-5" aria-label="当前连接">
        <div className="mb-4">
          <h3 className="text-sm font-medium">当前连接</h3>
          {accountLabel ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {maskAccountLabel(accountLabel)}
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              Provider 凭证加密保存在当前 Pod。
            </p>
          )}
        </div>

        {attempt?.userCode ? (
          <div className="mb-4 border-l-2 border-primary bg-muted/30 px-3 py-2 text-sm">
            验证码：<strong className="font-mono">{attempt.userCode}</strong>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {isConnected ? (
            <>
              <Button variant="outline" size="sm" disabled={busy || disabled} onClick={onBeginBrowser}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCw className="mr-2 h-4 w-4" />}
                重新连接
              </Button>
              <Button variant="ghost" size="sm" disabled={busy || disabled} onClick={onDisconnect}>
                <LogOut className="mr-2 h-4 w-4" />
                断开连接
              </Button>
            </>
          ) : isConfigured ? (
            <>
              <Button
                variant="outline"
                size="sm"
                aria-label="更新 API Key"
                disabled={busy || disabled}
                onClick={onBeginApiKey}
              >
                <KeyRound className="mr-2 h-4 w-4" />
                更新 API Key
              </Button>
              <Button variant="ghost" size="sm" disabled={busy || disabled} onClick={onDisconnect}>
                移除配置
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || disabled || definition.browserMode === 'connectUnsupported'}
                onClick={onBeginBrowser}
              >
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ExternalLink className="mr-2 h-4 w-4" />}
                {definition.browserLabel}
              </Button>
              <Button
                variant="outline"
                size="sm"
                aria-label={`${definition.name} API Key`}
                disabled={busy || disabled}
                onClick={onBeginApiKey}
              >
                <KeyRound className="mr-2 h-4 w-4" />
                配置 API Key
              </Button>
            </>
          )}
        </div>

        {apiKeyAttempt ? (
          <div className="mt-4 space-y-2">
            <Input
              type="password"
              autoComplete="off"
              aria-label={`${definition.name} API Key 输入`}
              placeholder="从官方控制台复制 API Key"
              value={apiKey}
              onChange={(event) => onApiKeyChange(event.target.value)}
            />
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
        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
      </section>

      <section className="border-t border-border/60 py-5">
        <AiQuotaCard
          providerName={definition.name}
          quota={quota}
          busy={busy}
          disabled={disabled}
          onRefresh={onRefreshQuota}
        />
      </section>

      <section className="border-t border-border/60 py-5">
        <h3 className="text-sm font-medium">可用模型</h3>
        {models.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">当前身份暂无可用模型</p>
        ) : (
          <ul className="mt-3 divide-y divide-border/50 text-sm">
            {models.map((model) => (
              <li key={model.id} className="flex items-center justify-between gap-4 py-2.5">
                <span>{model.displayName ?? model.id}</span>
                {model.displayName ? (
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {model.id}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function providerDescription(provider: AiProviderDefinition['id']): string {
  switch (provider) {
    case 'openai': return 'OpenAI 模型与编码能力'
    case 'anthropic': return 'Claude 模型与编码能力'
    case 'kimi': return 'Moonshot AI 模型服务'
    case 'bailian': return '阿里云百炼模型服务'
    case 'deepseek': return 'DeepSeek 模型服务'
  }
}

function connectionStatusLabel(status: ProviderConnectionState): string {
  switch (status) {
    case 'pending': return '连接中'
    case 'configured': return '已配置'
    case 'connected': return '已连接'
    case 'disconnected': return '未设置'
    case 'reauthRequired': return '需要重新鉴权'
    case 'failed': return '连接失败'
    default: return '未检查'
  }
}

function maskAccountLabel(value: string): string {
  const at = value.indexOf('@')
  if (at > 0) {
    const accountName = value.slice(0, at)
    const visible = accountName.length > 1
      ? `${accountName[0]}***${accountName[accountName.length - 1]}`
      : `${accountName[0]}***`
    return `${visible}${value.slice(at)}`
  }
  if (value.length <= 2) return `${value[0] ?? ''}***`
  return `${value[0]}***${value[value.length - 1]}`
}
