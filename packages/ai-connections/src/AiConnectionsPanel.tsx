import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button,
  Toaster,
  toast,
} from '@undefineds.co/shared-ui'
import {
  type AiConnectAttempt,
  type AiConnectionsClient,
  type AiModelSummary,
  type AiConnectionsProvider,
  type AiProviderConnectionSummary,
  type AiQuotaSnapshot,
  type DiscoveredProviderModel,
  normalizeAiConnectionsThrownError,
} from './ai-connections-client'
import {
  PROVIDERS,
  isApiKeyConnectionSummary,
  type AiProviderDefinition,
  type ProviderProductState,
} from './controller'
import {
  Loader2,
} from 'lucide-react'
import {
  AiProviderCard,
  type ProviderConnectionState,
} from './AiProviderCard'
import {
  AiModelEditorDialog,
  type AiModelEditorValue,
} from './AiModelEditorDialog'

const EMPTY_PROVIDER_SUMMARIES: Partial<Record<AiConnectionsProvider, AiProviderConnectionSummary>> = {}

export interface AiConnectionsPanelProps {
  client: AiConnectionsClient
  openExternal?: (url: string) => void | Promise<void>
  selectedProvider?: AiConnectionsProvider
  providerSummaries?: Partial<Record<AiConnectionsProvider, AiProviderConnectionSummary>>
  providerLoadError?: string
  serviceAccessGranted?: boolean
  onProviderStateChange?: (
    provider: AiConnectionsProvider,
    state: ProviderProductState,
  ) => void
}

export function AiConnectionsPanel({
  client,
  openExternal = openExternalUrl,
  selectedProvider,
  providerSummaries: providerSummariesInput = EMPTY_PROVIDER_SUMMARIES,
  providerLoadError,
  serviceAccessGranted = false,
  onProviderStateChange,
}: AiConnectionsPanelProps) {
  const [connectionStates, setConnectionStates] = useState<Record<string, ProviderConnectionState>>({})
  const [models, setModels] = useState<AiModelSummary[]>([])
  const [attempts, setAttempts] = useState<Record<string, AiConnectAttempt | undefined>>({})
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({})
  const [baseUrlInputs, setBaseUrlInputs] = useState<Record<string, string>>({})
  const attemptsRef = useRef<Record<string, AiConnectAttempt | undefined>>({})
  const apiKeyInputsRef = useRef<Record<string, string>>({})
  const baseUrlInputsRef = useRef<Record<string, string>>({})
  const [busyProviders, setBusyProviders] = useState<Record<string, boolean>>({})
  const [providerErrors, setProviderErrors] = useState<Record<string, string | undefined>>({})
  const [quotas, setQuotas] = useState<Record<string, AiQuotaSnapshot | undefined>>({})
  const [verifyingProviders, setVerifyingProviders] = useState<Record<string, boolean>>({})
  const [modelEditor, setModelEditor] = useState<{
    provider: AiConnectionsProvider
    model?: AiModelSummary
  }>()
  const [modelEditorError, setModelEditorError] = useState<string>()
  const [modelEditorSaving, setModelEditorSaving] = useState(false)
  const pollingGeneration = useRef(0)
  const updateConnectionState = useCallback((
    provider: AiConnectionsProvider,
    state: ProviderConnectionState,
  ) => {
    setConnectionStates((current) => ({ ...current, [provider]: state }))
    onProviderStateChange?.(provider, productStateFromConnection(state))
  }, [onProviderStateChange])

  useEffect(() => {
    setConnectionStates(Object.fromEntries(
      Object.values(providerSummariesInput).filter(isDefined).map((summary) => [
        summary.provider,
        isApiKeyConnectionSummary(summary)
          ? 'configured'
          : summary.status,
      ]),
    ))
    setBaseUrlInputs(Object.fromEntries(
      Object.values(providerSummariesInput).filter(isDefined).map((summary) => [
        summary.provider,
        summary.baseUrl ?? '',
      ]),
    ))
    baseUrlInputsRef.current = Object.fromEntries(
      Object.values(providerSummariesInput).filter(isDefined).map((summary) => [
        summary.provider,
        summary.baseUrl ?? '',
      ]),
    )
  }, [providerSummariesInput])

  useEffect(() => {
    let active = true
    void client.listModels()
      .then((availableModels) => {
        if (active) setModels(availableModels)
      })
      .catch((error) => {
        if (active) toast({ description: errorMessage(error) })
      })
    return () => {
      active = false
      pollingGeneration.current += 1
    }
  }, [client])

  const setBusy = (provider: AiConnectionsProvider, value: boolean) => {
    setBusyProviders((current) => ({ ...current, [provider]: value }))
  }

  const setProviderError = (provider: AiConnectionsProvider, value?: string) => {
    setProviderErrors((current) => ({ ...current, [provider]: value }))
  }

  const setAttempt = (provider: AiConnectionsProvider, attempt: AiConnectAttempt | undefined) => {
    attemptsRef.current = { ...attemptsRef.current, [provider]: attempt }
    setAttempts(attemptsRef.current)
  }

  const setApiKeyInput = (provider: AiConnectionsProvider, value: string) => {
    apiKeyInputsRef.current = { ...apiKeyInputsRef.current, [provider]: value }
    setApiKeyInputs(apiKeyInputsRef.current)
  }

  const setBaseUrlInput = (provider: AiConnectionsProvider, value: string) => {
    baseUrlInputsRef.current = { ...baseUrlInputsRef.current, [provider]: value }
    setBaseUrlInputs(baseUrlInputsRef.current)
  }

  const openAttemptUrl = useCallback(async (attempt: AiConnectAttempt) => {
    const target = attempt.verificationUriComplete
      ?? attempt.authorizationUrl
      ?? attempt.verificationUri
    if (target) await openExternal(target)
  }, [openExternal])

  const beginApiKey = async (provider: AiConnectionsProvider) => {
    if (!serviceAccessGranted) return
    setBusy(provider, true)
    setProviderError(provider)
    try {
      const attempt = await client.beginConnect(provider, 'browserAssistedApiKey')
      setAttempt(provider, attempt)
      const pending = isPendingAttempt(attempt.status)
      updateConnectionState(
        provider,
        pending ? 'pending' : attempt.status === 'completed' ? 'configured' : 'failed',
      )
      if (!pending && attempt.status !== 'completed') {
        setProviderError(provider, attempt.message ?? connectFailureMessage(attempt.status))
        return
      }
      setBusy(provider, false)
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
      setAttempt(definition.id, attempt)
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
        onAttempt: (next) => setAttempt(definition.id, next),
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
    const apiKey = apiKeyInputsRef.current[definition.id]?.trim()
    const baseUrl = baseUrlInputsRef.current[definition.id]
      ?? providerSummariesInput[definition.id]?.baseUrl
      ?? ''
    const attempt = attemptsRef.current[definition.id]
    if (!apiKey || !attempt) return
    setBusy(definition.id, true)
    setProviderError(definition.id)
    try {
      const result = await client.completeApiKey(definition.id, attempt, apiKey, undefined, baseUrl.trim())
      setAttempt(definition.id, result)
      setApiKeyInput(definition.id, '')
      updateConnectionState(definition.id, 'configured')
      toast({ description: 'API Key 已保存' })
    } catch (error) {
      setProviderError(definition.id, errorMessage(error))
      updateConnectionState(definition.id, 'failed')
    } finally {
      setBusy(definition.id, false)
    }
  }

  const disconnect = async (provider: AiConnectionsProvider) => {
    if (!serviceAccessGranted) return
    setBusy(provider, true)
    setProviderError(provider)
    try {
      await client.disconnect(provider)
      setAttempt(provider, undefined)
      setQuotas((current) => ({ ...current, [provider]: undefined }))
      updateConnectionState(provider, 'disconnected')
      toast({ description: '已断开连接' })
    } catch (error) {
      setProviderError(provider, errorMessage(error))
    } finally {
      setBusy(provider, false)
    }
  }

  const refreshQuota = async (provider: AiConnectionsProvider) => {
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

  const verifyProvider = async (provider: AiConnectionsProvider) => {
    if (!serviceAccessGranted) return
    setVerifyingProviders((current) => ({ ...current, [provider]: true }))
    setProviderError(provider)
    try {
      const discovery = await client.discoverModels(provider)
      setModels((current) => mergeDiscoveredModels(current, provider, discovery.models))
      toast({
        variant: 'success',
        description: discovery.models.length > 0
          ? `连接成功，已同步 ${discovery.models.length} 个模型`
          : '连接成功',
      })
    } catch (error) {
      const message = errorMessage(error)
      setProviderError(provider, message)
      toast({ variant: 'destructive', description: `连接失败：${message}` })
    } finally {
      setVerifyingProviders((current) => ({ ...current, [provider]: false }))
    }
  }

  const reloadModels = useCallback(async () => {
    try {
      setModels(await client.listModels())
    } catch {
      // The catalog stays at its last known state; the mutation already succeeded.
    }
  }, [client])

  const openModelEditor = (provider: AiConnectionsProvider, model?: AiModelSummary) => {
    setModelEditorError(undefined)
    setModelEditor({ provider, model })
  }

  const saveProviderModel = async (value: AiModelEditorValue) => {
    if (!modelEditor || !serviceAccessGranted) return
    const editing = Boolean(modelEditor.model)
    setModelEditorSaving(true)
    setModelEditorError(undefined)
    try {
      await client.saveProviderModel(modelEditor.provider, {
        id: value.id,
        displayName: value.name || undefined,
        inputModalities: value.inputModalities.length > 0 ? value.inputModalities : undefined,
        capabilities: value.capabilities.length > 0 ? value.capabilities : undefined,
      })
      setModelEditor(undefined)
      toast({ description: editing ? '模型已更新' : '模型已添加' })
      await reloadModels()
    } catch (error) {
      setModelEditorError(errorMessage(error))
    } finally {
      setModelEditorSaving(false)
    }
  }

  const deleteProviderModel = async (provider: AiConnectionsProvider, model: AiModelSummary) => {
    if (!serviceAccessGranted) return
    setProviderError(provider)
    try {
      await client.deleteProviderModel(provider, model.id)
      setModels((current) => current.filter((item) => !(item.provider === provider && item.id === model.id)))
      toast({ description: '模型已移除' })
      void reloadModels()
    } catch (error) {
      setProviderError(provider, errorMessage(error))
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-10 px-8 py-8">
      <Toaster />
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
              baseUrl={baseUrlInputs[definition.id] ?? providerSummariesInput[definition.id]?.baseUrl ?? ''}
              busy={Boolean(busyProviders[definition.id])}
              disabled={!serviceAccessGranted}
              error={providerErrors[definition.id]}
              quota={quotas[definition.id]}
              models={models.filter((model) => model.provider === definition.id)}
              onApiKeyChange={(value) => setApiKeyInput(definition.id, value)}
              onBaseUrlChange={(value) => setBaseUrlInput(definition.id, value)}
              onBeginApiKey={() => void beginApiKey(definition.id)}
              onBeginBrowser={() => void beginBrowserConnect(definition)}
              onSaveApiKey={() => void saveApiKey(definition)}
              onDisconnect={() => void disconnect(definition.id)}
              onRefreshQuota={() => void refreshQuota(definition.id)}
              verifyPending={Boolean(verifyingProviders[definition.id])}
              onVerify={() => void verifyProvider(definition.id)}
              onAddModel={() => openModelEditor(definition.id)}
              onEditModel={(model) => openModelEditor(definition.id, model)}
              onDeleteModel={(model) => void deleteProviderModel(definition.id, model)}
            />
          ))}
      </section>

      {modelEditor ? (
        <AiModelEditorDialog
          open
          providerName={PROVIDERS.find((definition) => definition.id === modelEditor.provider)?.name ?? modelEditor.provider}
          initialValue={modelEditor.model
            ? {
                id: modelEditor.model.id,
                name: modelEditor.model.displayName ?? '',
                inputModalities: modelEditor.model.inputModalities ?? [],
                capabilities: modelEditor.model.capabilities ?? [],
              }
            : undefined}
          error={modelEditorError}
          saving={modelEditorSaving}
          onOpenChange={(open) => {
            if (!open) setModelEditor(undefined)
          }}
          onSave={(value) => void saveProviderModel(value)}
        />
      ) : null}

    </div>
  )
}

async function pollDeviceConnect(
  client: AiConnectionsClient,
  provider: AiConnectionsProvider,
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
  return normalizeAiConnectionsThrownError(error)
}

function mergeDiscoveredModels(
  current: AiModelSummary[],
  provider: AiConnectionsProvider,
  discovered: DiscoveredProviderModel[],
): AiModelSummary[] {
  const merged = [...current]
  for (const model of discovered) {
    const index = merged.findIndex((item) => item.provider === provider && item.id === model.id)
    if (index === -1) {
      merged.push(compactModel({
        id: model.id,
        provider,
        displayName: model.displayName,
      }))
    } else if (model.displayName && !merged[index].displayName) {
      merged[index] = { ...merged[index], displayName: model.displayName }
    }
  }
  return merged
}

function compactModel(model: AiModelSummary): AiModelSummary {
  return Object.fromEntries(
    Object.entries(model).filter(([, value]) => value !== undefined),
  ) as AiModelSummary
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
