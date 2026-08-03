import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from '@undefineds.co/shared-ui'
import {
  type AiConnectAttempt,
  type AiConnectionClient,
  type AiGatewayModel,
  type AiConnectionProvider,
  type AiProviderConnectionSummary,
  type AiQuotaSnapshot,
  normalizeAiConnectionThrownError,
} from './ai-connection-client'
import type { AiClientCredentialManager, AiClientCredentialRecord } from '@undefineds.co/extension-sdk/web'
import {
  PROVIDERS,
  type AiProviderDefinition,
  type ProviderProductState,
} from './controller'
import {
  Check,
  Copy,
  KeyRound,
  Loader2,
  Trash2,
} from 'lucide-react'
import {
  AI_CLIENT_LABELS,
  AiClientConfigurationSection,
  type AiClientConfigurationBridge,
  type AiConnectionClientId,
  type ManagedClientCredentialLease,
} from './AiClientConfigurationSection'
import {
  AiProviderCard,
  type ProviderConnectionState,
} from './AiProviderCard'

const EMPTY_PROVIDER_SUMMARIES: Partial<Record<AiConnectionProvider, AiProviderConnectionSummary>> = {}

export interface AiConnectionPanelProps {
  client: AiConnectionClient
  openExternal?: (url: string) => void | Promise<void>
  clientConfigurationBridge?: AiClientConfigurationBridge
  clientCredentialManager?: AiClientCredentialManager
  selectedProvider?: AiConnectionProvider
  providerSummaries?: Partial<Record<AiConnectionProvider, AiProviderConnectionSummary>>
  providerLoadError?: string
  serviceAccessGranted?: boolean
  onProviderStateChange?: (
    provider: AiConnectionProvider,
    state: ProviderProductState,
  ) => void
}

export function AiConnectionPanel({
  client,
  openExternal = openExternalUrl,
  clientConfigurationBridge,
  clientCredentialManager,
  selectedProvider,
  providerSummaries: providerSummariesInput = EMPTY_PROVIDER_SUMMARIES,
  providerLoadError,
  serviceAccessGranted = false,
  onProviderStateChange,
}: AiConnectionPanelProps) {
  const [credentials, setCredentials] = useState<AiClientCredentialRecord[]>([])
  const [credentialsLoading, setCredentialsLoading] = useState(Boolean(clientCredentialManager))
  const [credentialName, setCredentialName] = useState('')
  const [creatingCredential, setCreatingCredential] = useState(false)
  const [oneTimeCredential, setOneTimeCredential] = useState<{ clientId: string; clientSecret: string; apiKey: string }>()
  const [credentialError, setCredentialError] = useState<string>()
  const [connectionStates, setConnectionStates] = useState<Record<string, ProviderConnectionState>>({})
  const [models, setModels] = useState<AiGatewayModel[]>([])
  const [attempts, setAttempts] = useState<Record<string, AiConnectAttempt | undefined>>({})
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({})
  const [busyProviders, setBusyProviders] = useState<Record<string, boolean>>({})
  const [providerErrors, setProviderErrors] = useState<Record<string, string | undefined>>({})
  const [quotas, setQuotas] = useState<Record<string, AiQuotaSnapshot | undefined>>({})
  const [copied, setCopied] = useState(false)
  const pollingGeneration = useRef(0)
  const updateConnectionState = useCallback((
    provider: AiConnectionProvider,
    state: ProviderConnectionState,
  ) => {
    setConnectionStates((current) => ({ ...current, [provider]: state }))
    onProviderStateChange?.(provider, productStateFromConnection(state))
  }, [onProviderStateChange])

  useEffect(() => {
    setConnectionStates(Object.fromEntries(
      Object.values(providerSummariesInput).filter(isDefined).map((summary) => [
        summary.provider,
        summary.status === 'connected' && summary.authMode === 'browserAssistedApiKey'
          ? 'configured'
          : summary.status,
      ]),
    ))
  }, [providerSummariesInput])

  useEffect(() => {
    let active = true
    if (clientCredentialManager) {
      setCredentialsLoading(true)
      void clientCredentialManager.list()
        .then((records) => {
          if (active) setCredentials(records)
        })
        .catch((error) => {
          if (active) setCredentialError(errorMessage(error))
        })
        .finally(() => {
          if (active) setCredentialsLoading(false)
        })
    } else {
      setCredentialsLoading(false)
      setCredentials([])
    }
    void client.listModels()
      .then((availableModels) => {
        if (active) setModels(availableModels)
      })
      .catch((error) => {
        if (active) setCredentialError(errorMessage(error))
      })
    return () => {
      active = false
      pollingGeneration.current += 1
    }
  }, [client, clientCredentialManager])

  const setBusy = (provider: AiConnectionProvider, value: boolean) => {
    setBusyProviders((current) => ({ ...current, [provider]: value }))
  }

  const setProviderError = (provider: AiConnectionProvider, value?: string) => {
    setProviderErrors((current) => ({ ...current, [provider]: value }))
  }

  const openAttemptUrl = useCallback(async (attempt: AiConnectAttempt) => {
    const target = attempt.verificationUriComplete
      ?? attempt.authorizationUrl
      ?? attempt.verificationUri
    if (target) await openExternal(target)
  }, [openExternal])

  const beginApiKey = async (provider: AiConnectionProvider) => {
    if (!serviceAccessGranted) return
    setBusy(provider, true)
    setProviderError(provider)
    try {
      const attempt = await client.beginConnect(provider, 'browserAssistedApiKey')
      setAttempts((current) => ({ ...current, [provider]: attempt }))
      const pending = isPendingAttempt(attempt.status)
      updateConnectionState(
        provider,
        pending ? 'pending' : attempt.status === 'completed' ? 'configured' : 'failed',
      )
      if (!pending && attempt.status !== 'completed') {
        setProviderError(provider, attempt.message ?? connectFailureMessage(attempt.status))
        return
      }
      await openAttemptUrl(attempt)
    } catch (error) {
      updateConnectionState(provider, 'failed')
      setProviderError(provider, errorMessage(error))
    } finally {
      setBusy(provider, false)
    }
  }

  const beginBrowserConnect = async (definition: AiProviderDefinition) => {
    if (!serviceAccessGranted) return
    if (definition.browserMode === 'connectUnsupported') return
    if (definition.browserMode === 'browserAssistedApiKey') {
      await beginApiKey(definition.id)
      return
    }

    setBusy(definition.id, true)
    setProviderError(definition.id)
    const generation = pollingGeneration.current + 1
    pollingGeneration.current = generation
    try {
      const attempt = await client.beginConnect(definition.id, definition.browserMode)
      setAttempts((current) => ({ ...current, [definition.id]: attempt }))
      if (!isPendingAttempt(attempt.status)) {
        const connected = attempt.status === 'completed'
        updateConnectionState(definition.id, connected ? 'connected' : 'failed')
        if (!connected) {
          setProviderError(
            definition.id,
            attempt.message ?? connectFailureMessage(attempt.status),
          )
        }
        setBusy(definition.id, false)
        return
      }
      updateConnectionState(definition.id, 'pending')
      await openAttemptUrl(attempt)
      void pollDeviceConnect(client, definition.id, attempt, generation, pollingGeneration, {
        onAttempt: (next) => setAttempts((current) => ({ ...current, [definition.id]: next })),
        onConnected: () => updateConnectionState(definition.id, 'connected'),
        onFailed: (message) => {
          updateConnectionState(definition.id, 'failed')
          setProviderError(definition.id, message)
        },
        onFinished: () => setBusy(definition.id, false),
      })
    } catch (error) {
      updateConnectionState(definition.id, 'failed')
      setProviderError(definition.id, errorMessage(error))
      setBusy(definition.id, false)
    }
  }

  const saveApiKey = async (definition: AiProviderDefinition) => {
    if (!serviceAccessGranted) return
    const apiKey = apiKeyInputs[definition.id]?.trim()
    const attempt = attempts[definition.id]
    if (!apiKey || !attempt) return
    setBusy(definition.id, true)
    setProviderError(definition.id)
    try {
      const result = await client.completeApiKey(definition.id, attempt, apiKey)
      setAttempts((current) => ({ ...current, [definition.id]: result }))
      setApiKeyInputs((current) => ({ ...current, [definition.id]: '' }))
      updateConnectionState(definition.id, 'configured')
    } catch (error) {
      setProviderError(definition.id, errorMessage(error))
      updateConnectionState(definition.id, 'failed')
    } finally {
      setBusy(definition.id, false)
    }
  }

  const disconnect = async (provider: AiConnectionProvider) => {
    if (!serviceAccessGranted) return
    setBusy(provider, true)
    setProviderError(provider)
    try {
      await client.disconnect(provider)
      setAttempts((current) => ({ ...current, [provider]: undefined }))
      setQuotas((current) => ({ ...current, [provider]: undefined }))
      updateConnectionState(provider, 'disconnected')
    } catch (error) {
      setProviderError(provider, errorMessage(error))
    } finally {
      setBusy(provider, false)
    }
  }

  const refreshQuota = async (provider: AiConnectionProvider) => {
    setBusy(provider, true)
    setProviderError(provider)
    try {
      const quota = await client.quota(provider, true)
      setQuotas((current) => ({ ...current, [provider]: quota }))
    } catch (error) {
      setProviderError(provider, errorMessage(error))
    } finally {
      setBusy(provider, false)
    }
  }

  const createCredential = async () => {
    if (!serviceAccessGranted || !clientCredentialManager) return
    setCreatingCredential(true)
    setCredentialError(undefined)
    setOneTimeCredential(undefined)
    try {
      const created = await clientCredentialManager.create({
        name: credentialName.trim() || 'AI Connection',
        webId: client.webId,
      })
      setOneTimeCredential({
        clientId: created.clientId,
        clientSecret: created.clientSecret,
        apiKey: created.apiKey,
      })
      setCredentials((current) => [
        created,
        ...current.filter((record) => record.resourceUrl !== created.resourceUrl),
      ])
      setCredentialName('')
    } catch (error) {
      setCredentialError(errorMessage(error))
    } finally {
      setCreatingCredential(false)
    }
  }

  const revokeCredential = async (credential: AiClientCredentialRecord) => {
    if (!serviceAccessGranted || !clientCredentialManager) return
    setCredentialError(undefined)
    try {
      await clientCredentialManager.revoke(credential.resourceUrl)
      setCredentials((current) => current.filter((item) => item.resourceUrl !== credential.resourceUrl))
    } catch (error) {
      setCredentialError(errorMessage(error))
    }
  }

  const copyOneTimeApiKey = async () => {
    if (!oneTimeCredential) return
    await navigator.clipboard?.writeText(oneTimeCredential.apiKey)
    setCopied(true)
  }

  const createManagedClientCredential = useCallback(async (
    targetClient: AiConnectionClientId,
  ): Promise<ManagedClientCredentialLease> => {
    if (!serviceAccessGranted) {
      throw new Error('AI Connection service access is not granted')
    }
    if (!clientCredentialManager) {
      throw new Error('Client Credentials are not available in this host')
    }
    const created = await clientCredentialManager.create({
      name: `AI Connection · ${AI_CLIENT_LABELS[targetClient]}`,
      webId: client.webId,
    })
    setCredentials((current) => [
      created,
      ...current.filter((record) => record.resourceUrl !== created.resourceUrl),
    ])
    return {
      apiKey: created.apiKey,
      revoke: async () => {
        await clientCredentialManager.revoke(created.resourceUrl)
        setCredentials((current) => current.filter((record) => record.resourceUrl !== created.resourceUrl))
      },
    }
  }, [client.webId, clientCredentialManager, serviceAccessGranted])

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-6">
      <section>
          {providerLoadError ? (
            <p className="mb-4 rounded-md border border-destructive/30 px-3 py-2 text-sm text-destructive">
              Provider 状态读取失败：{providerLoadError}
            </p>
          ) : null}
          {PROVIDERS.filter((definition) => definition.id === (selectedProvider ?? 'openai')).map((definition) => (
            <AiProviderCard
              key={definition.id}
              definition={definition}
              status={connectionStates[definition.id] ?? 'unknown'}
              accountLabel={providerSummariesInput[definition.id]?.accountLabel}
              attempt={attempts[definition.id]}
              apiKey={apiKeyInputs[definition.id] ?? ''}
              busy={Boolean(busyProviders[definition.id])}
              disabled={!serviceAccessGranted}
              error={providerErrors[definition.id]}
              quota={quotas[definition.id]}
              models={models.filter((model) => model.provider === definition.id)}
              onApiKeyChange={(value) => setApiKeyInputs((current) => ({
                ...current,
                [definition.id]: value,
              }))}
              onBeginApiKey={() => void beginApiKey(definition.id)}
              onBeginBrowser={() => void beginBrowserConnect(definition)}
              onSaveApiKey={() => void saveApiKey(definition)}
              onDisconnect={() => void disconnect(definition.id)}
              onRefreshQuota={() => void refreshQuota(definition.id)}
            />
          ))}
      </section>

      <details className="border-t border-border/60 py-5">
        <summary className="cursor-pointer list-none text-sm font-medium">
          客户端接入
        </summary>
        <div className="mt-4 space-y-6">
          <AiClientConfigurationSection
            bridge={clientConfigurationBridge}
            endpoint={client.apiBase}
            createClientCredential={createManagedClientCredential}
          />

          <details className="border-t border-border/60 pt-4">
            <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
              Client Credentials
            </summary>
            <div className="mt-3">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4" />
            Client Credentials
          </CardTitle>
          <CardDescription>
            为 Codex、Claude Code、Pi、CodeBuddy 创建 Solid Client Credentials。API Key 为 <code>sk-base64(client_id:client_secret)</code>，只在创建后显示一次。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!clientCredentialManager ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-muted-foreground">
              当前 Host 没有提供 account-controls Client Credentials capability。
              <a className="ml-1 underline" href="/.account/">
                打开 Account Developer Access
              </a>
              {' '}手动创建 API Key。
            </div>
          ) : null}
          <div className="flex gap-2">
            <Input
              aria-label="Client Credential 名称"
              placeholder="名称，例如 Codex"
              value={credentialName}
              onChange={(event) => setCredentialName(event.target.value)}
            />
            <Button onClick={() => void createCredential()} disabled={creatingCredential || !serviceAccessGranted || !clientCredentialManager}>
              {creatingCredential ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
              创建 Client Credential
            </Button>
          </div>

          {oneTimeCredential ? (
            <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
              <p className="text-sm font-medium">请立即保存；关闭后无法再次查看。</p>
              <div className="space-y-2 rounded bg-background p-3 text-xs">
                <div><span className="text-muted-foreground">Client ID: </span><code>{oneTimeCredential.clientId}</code></div>
                <div><span className="text-muted-foreground">Client Secret: </span><code>{oneTimeCredential.clientSecret}</code></div>
                <div><span className="text-muted-foreground">API Key: </span><code>{oneTimeCredential.apiKey}</code></div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => void copyOneTimeApiKey()}>
                  {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
                  {copied ? '已复制' : '复制 API Key'}
                </Button>
                <Button size="sm" onClick={() => {
                  setOneTimeCredential(undefined)
                  setCopied(false)
                }}>
                  我已保存，隐藏密钥
                </Button>
              </div>
            </div>
          ) : null}

          {credentialError ? <p className="text-sm text-destructive">{credentialError}</p> : null}
          {credentialsLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在读取 Client Credentials
            </div>
          ) : credentials.length === 0 ? (
            <p className="text-sm text-muted-foreground">尚未创建 Client Credential。</p>
          ) : (
            <div className="space-y-2">
              {credentials.map((credential) => (
                <div key={credential.resourceUrl} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{credential.id}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {credential.webId ?? client.webId}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`撤销 ${credential.id}`}
                    disabled={!serviceAccessGranted || !clientCredentialManager}
                    onClick={() => void revokeCredential(credential)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
            </div>
          </details>
        </div>
      </details>
    </div>
  )
}

async function pollDeviceConnect(
  client: AiConnectionClient,
  provider: AiConnectionProvider,
  initial: AiConnectAttempt,
  generation: number,
  generationRef: { current: number },
  callbacks: {
    onAttempt: (attempt: AiConnectAttempt) => void
    onConnected: () => void
    onFailed: (message: string) => void
    onFinished: () => void
  },
): Promise<void> {
  let attempt = initial
  try {
    while (generationRef.current === generation && isPendingAttempt(attempt.status)) {
      await delay(Math.max(1, attempt.intervalSeconds ?? 2) * 1_000)
      if (generationRef.current !== generation) return
      attempt = await client.pollDevice(provider, attempt)
      callbacks.onAttempt(attempt)
    }
    if (attempt.status === 'completed') {
      callbacks.onConnected()
    } else if (generationRef.current === generation) {
      callbacks.onFailed(attempt.message || `连接${attempt.status === 'expired' ? '已过期' : '失败'}`)
    }
  } catch (error) {
    if (generationRef.current === generation) callbacks.onFailed(errorMessage(error))
  } finally {
    if (generationRef.current === generation) callbacks.onFinished()
  }
}

function isPendingAttempt(status: AiConnectAttempt['status']): boolean {
  return status === 'pending' || status === 'authorization_pending' || status === 'slow_down'
}

function connectFailureMessage(status: AiConnectAttempt['status']): string {
  if (status === 'expired') return '连接已过期，请重新开始'
  if (status === 'cancelled') return '连接已取消'
  if (status === 'unsupported') return '当前 Provider 不支持此连接方式'
  return '连接失败'
}

function productStateFromConnection(
  state: ProviderConnectionState,
): ProviderProductState {
  if (state === 'configured') return 'configured'
  if (state === 'connected') return 'connected'
  if (state === 'failed' || state === 'reauthRequired') return 'attention'
  if (state === 'pending') return 'loading'
  return 'unconfigured'
}

function openExternalUrl(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function errorMessage(error: unknown): string {
  return normalizeAiConnectionThrownError(error)
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
