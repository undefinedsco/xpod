import { useEffect, useState } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@undefineds.co/shared-ui'
import type { CreateApiKeyCredentialInput } from './ai-connections-client'

export type CustomProviderCompatibility = 'auto' | 'openai' | 'anthropic'

export interface CustomProviderValue extends CreateApiKeyCredentialInput {
  compatibility: CustomProviderCompatibility
}

export interface AiCustomProviderDialogProps {
  open: boolean
  saving?: boolean
  error?: string
  onOpenChange: (open: boolean) => void
  onSave: (value: CustomProviderValue) => void
}

export function AiCustomProviderDialog({
  open,
  saving = false,
  error,
  onOpenChange,
  onSave,
}: AiCustomProviderDialogProps) {
  const [name, setName] = useState('')
  const [compatibility, setCompatibility] = useState<CustomProviderCompatibility>('auto')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [proxyUrl, setProxyUrl] = useState('')
  const [localError, setLocalError] = useState<string | undefined>()

  useEffect(() => {
    if (!open) return
    setName('')
    setCompatibility('auto')
    setBaseUrl('')
    setApiKey('')
    setProxyUrl('')
    setLocalError(undefined)
  }, [open])

  const submit = () => {
    setLocalError(undefined)
    let normalizedBaseUrl: string
    try {
      normalizedBaseUrl = normalizeCustomBaseUrl(baseUrl)
    } catch {
      setLocalError('Base URL 必须是有效的 http(s) 地址。')
      return
    }
    const trimmedName = name.trim()
    const trimmedApiKey = apiKey.trim()
    if (!trimmedName) {
      setLocalError('请输入 Provider 名称。')
      return
    }
    if (!trimmedApiKey) {
      setLocalError('请输入 API Key。')
      return
    }
    onSave({
      offeringId: offeringIdForCompatibility(compatibility),
      apiKey: trimmedApiKey,
      label: trimmedName,
      baseUrl: normalizedBaseUrl,
      priority: 10,
      compatibility,
      ...(proxyUrl.trim() ? { proxyUrl: proxyUrl.trim() } : {}),
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        style={{ maxHeight: 'calc(100vh - 2rem)', overflowY: 'auto' }}
        aria-describedby="ai-custom-provider-description"
      >
        <DialogHeader>
          <DialogTitle>添加自定义 Provider</DialogTitle>
        </DialogHeader>
        <p id="ai-custom-provider-description" className="text-sm text-muted-foreground">
          用 OpenAI/Anthropic 兼容协议接入第三方模型服务。Xpod 会把真实 API Key 存进当前 Pod。
        </p>
        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="ai-custom-provider-name">Provider 名称</Label>
            <Input
              id="ai-custom-provider-name"
              value={name}
              disabled={saving}
              placeholder="例如 OpenRouter"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="ai-custom-provider-compatibility">兼容协议</Label>
            <select
              id="ai-custom-provider-compatibility"
              value={compatibility}
              disabled={saving}
              aria-label="兼容协议"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              onChange={(event) => setCompatibility(event.target.value as CustomProviderCompatibility)}
            >
              <option value="auto">自动探测</option>
              <option value="openai">OpenAI 兼容优先</option>
              <option value="anthropic">Anthropic 兼容优先</option>
            </select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="ai-custom-provider-base-url">Base URL</Label>
            <Input
              id="ai-custom-provider-base-url"
              value={baseUrl}
              disabled={saving}
              placeholder="https://openrouter.ai/api 或 https://openrouter.ai/api/v1"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">裸域名会自动补齐为 /v1。</p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="ai-custom-provider-api-key">API Key</Label>
            <Input
              id="ai-custom-provider-api-key"
              type="password"
              value={apiKey}
              disabled={saving}
              autoComplete="new-password"
              data-lpignore="true"
              onChange={(event) => setApiKey(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="ai-custom-provider-proxy-url">Proxy URL（可选）</Label>
            <Input
              id="ai-custom-provider-proxy-url"
              value={proxyUrl}
              disabled={saving}
              placeholder="http://127.0.0.1:7890"
              onChange={(event) => setProxyUrl(event.target.value)}
            />
          </div>
          {localError || error ? (
            <p className="text-sm text-destructive">{localError ?? error}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" disabled={saving} onClick={submit}>
            保存自定义 Provider
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function normalizeCustomBaseUrl(value: string): string {
  const trimmed = value.trim()
  const parsed = new URL(trimmed)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('invalid_custom_base_url')
  }
  parsed.hash = ''
  const pathname = parsed.pathname.replace(/\/+$/u, '')
  if (!pathname || pathname === '') {
    parsed.pathname = '/v1'
  } else {
    parsed.pathname = pathname
  }
  return parsed.href.replace(/\/$/u, '')
}

function offeringIdForCompatibility(compatibility: CustomProviderCompatibility): string {
  if (compatibility === 'anthropic') return 'anthropic-compatible'
  return 'openai-compatible'
}
