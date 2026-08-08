import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button,
  Input,
  Toaster,
  toast,
} from '@undefineds.co/shared-ui'
import {
  type AiConnectAttempt,
  type AiConnectionsClient,
  type AiGatewayModel,
  type AiConnectionsProvider,
  type AiProviderCredentialSummary,
  type AiProviderConnectionSummary,
  type AiProviderOffering,
  type AiProviderSummary,
  type AiQuotaSnapshot,
  type DiscoveredProviderModel,
  type GatewayKeyRecord,
  normalizeAiConnectionsThrownError,
} from './ai-connections-client'
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
  type AiConnectionsClientId,
  type ManagedGatewayKeyLease,
} from './AiClientConfigurationSection'
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
  clientConfigurationBridge?: AiClientConfigurationBridge
  selectedProvider?: AiConnectionsProvider
  providerSummaries?: Partial<Record<AiConnectionsProvider, AiProviderConnectionSummary>>
  providerProducts?: Partial<Record<AiConnectionsProvider, AiProviderSummary>>
  providerLoadError?: string
  serviceAccessGranted?: boolean
  onProviderStateChange?: (
    provider: AiConnectionsProvider,
    state: ProviderProductState,
  ) => void
  onModelSelectionChange?: (
    provider: AiConnectionsProvider,
    modelIds: string[],
  ) => void
}

export function AiConnectionsPanel({
  client,
  openExternal = openExternalUrl,
  clientConfigurationBridge,
  selectedProvider,
  providerSummaries: providerSummariesInput = EMPTY_PROVIDER_SUMMARIES,
  providerProducts = {},
  providerLoadError,
  serviceAccessGranted = false,
  onProviderStateChange,
  onModelSelectionChange,
}: AiConnectionsPanelProps) {
  const [keys, setKeys] = useState<GatewayKeyRecord[]>([])
  const [keysLoading, setKeysLoading] = useState(true)
  const [keyName, setKeyName] = useState('')
  const [creatingKey, setCreatingKey] = useState(false)
  const [oneTimeKey, setOneTimeKey] = useState<string>()
  const [keyError, setKeyError] = useState<string>()
  const [connectionStates, setConnectionStates] = useState<Record<string, ProviderConnectionState>>({})
  const [models, setModels] = useState<AiGatewayModel[]>([])
  const [selectedModelIds, setSelectedModelIds] = useState<
    Partial<Record<AiConnectionsProvider, string[]>>
  >({})
  const [attempts, setAttempts] = useState<Record<string, AiConnectAttempt | undefined>>({})
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({})
  const [baseUrlInputs, setBaseUrlInputs] = useState<Record<string, string>>({})
  const [busyProviders, setBusyProviders] = useState<Record<string, boolean>>({})
  const [providerErrors, setProviderErrors] = useState<Record<string, string | undefined>>({})
  const [quotas, setQuotas] = useState<Record<string, AiQuotaSnapshot | undefined>>({})
  const [verifyingProviders, setVerifyingProviders] = useState<Record<string, boolean>>({})
  const [modelEditor, setModelEditor] = useState<{
    provider: AiConnectionsProvider
    model?: AiGatewayModel
  }>()
  const [modelEditorError, setModelEditorError] = useState<string>()
  const [modelEditorSaving, setModelEditorSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const [providerProductOverrides, setProviderProductOverrides] = useState<
    Partial<Record<AiConnectionsProvider, AiProviderSummary>>
  >({})
  const pollingGeneration = useRef(0)
  const modelSelectionGeneration = useRef<Partial<Record<AiConnectionsProvider, number>>>({})
  const effectiveProviderProducts = {
    ...providerProducts,
    ...providerProductOverrides,
  }
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
        summary.status === 'connected' && summary.authMode === 'browserAssistedApiKey'
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
  }, [providerSummariesInput])

  useEffect(() => {
    setSelectedModelIds((current) => {
      const next = { ...current }
      let changed = false
      for (const [provider, product] of Object.entries(providerProducts) as Array<[
        AiConnectionsProvider,
        AiProviderSummary | undefined,
      ]>) {
        if (!product) continue
        const ids = product.selectedModels.map((model) => model.id)
        const previous = current[provider]
        if (!previous || previous.join('\u0000') !== ids.join('\u0000')) {
          next[provider] = ids
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [providerProducts])

  useEffect(() => {
    let active = true
    setKeysLoading(true)
    void client.listGatewayKeys()
      .then((records) => {
        if (active) setKeys(records)
      })
      .catch((error) => {
        if (active) setKeyError(errorMessage(error))
      })
      .finally(() => {
        if (active) setKeysLoading(false)
      })
    void client.listModels()
      .then((availableModels) => {
        if (active) setModels(availableModels)
      })
      // Model discovery has its own Provider status surface. A discovery
      // failure must not be rendered as a CSS client-credential error in the
      // unrelated Gateway Keys section.
      .catch(() => undefined)
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

    await beginConnectMode(definition.id, definition.browserMode)
  }

  const beginOfferingConnect = async (
    provider: AiConnectionsProvider,
    offering: AiProviderOffering,
    mode: AiConnectAttempt['mode'],
  ) => {
    if (mode === 'browserAssistedApiKey') {
      await beginApiKey(provider)
      return
    }
    await beginConnectMode(provider, mode)
  }

  const beginConnectMode = async (
    provider: AiConnectionsProvider,
    mode: AiConnectAttempt['mode'],
  ) => {
    if (!serviceAccessGranted) return
    if (mode === 'connectUnsupported') return
    setBusy(provider, true)
    setProviderError(provider)
    const generation = pollingGeneration.current + 1
    pollingGeneration.current = generation
    try {
      const attempt = await client.beginConnect(provider, mode)
      setAttempts((current) => ({ ...current, [provider]: attempt }))
      if (!isPendingAttempt(attempt.status)) {
        const connected = attempt.status === 'completed'
        updateConnectionState(provider, connected ? 'connected' : 'failed')
        if (!connected) {
          setProviderError(
            provider,
            attempt.message ?? connectFailureMessage(attempt.status),
          )
        }
        setBusy(provider, false)
        return
      }
      updateConnectionState(provider, 'pending')
      await openAttemptUrl(attempt)
      void pollDeviceConnect(client, provider, attempt, generation, pollingGeneration, {
        onAttempt: (next) => setAttempts((current) => ({ ...current, [provider]: next })),
        onConnected: () => updateConnectionState(provider, 'connected'),
        onFailed: (message) => {
          updateConnectionState(provider, 'failed')
          setProviderError(provider, message)
        },
        onFinished: () => setBusy(provider, false),
      })
    } catch (error) {
      updateConnectionState(provider, 'failed')
      setProviderError(provider, errorMessage(error))
      setBusy(provider, false)
    }
  }

  const saveApiKey = async (definition: AiProviderDefinition) => {
    if (!serviceAccessGranted) return
    const apiKey = apiKeyInputs[definition.id]?.trim()
    const baseUrl = baseUrlInputs[definition.id]
      ?? providerSummariesInput[definition.id]?.baseUrl
      ?? ''
    const attempt = attempts[definition.id]
    if (!apiKey || !attempt) return
    setBusy(definition.id, true)
    setProviderError(definition.id)
    try {
      const result = await client.completeApiKey(definition.id, attempt, apiKey, undefined, baseUrl.trim())
      setAttempts((current) => ({ ...current, [definition.id]: result }))
      setApiKeyInputs((current) => ({ ...current, [definition.id]: '' }))
      updateConnectionState(definition.id, 'configured')
      toast({ description: 'API Key 已保存' })
    } catch (error) {
      setProviderError(definition.id, errorMessage(error))
      updateConnectionState(definition.id, 'failed')
    } finally {
      setBusy(definition.id, false)
    }
  }

  const disconnect = async (provider: AiConnectionsProvider, credentialId?: string) => {
    if (!serviceAccessGranted) return
    setBusy(provider, true)
    setProviderError(provider)
    try {
      await client.disconnect(provider, credentialId)
      setAttempts((current) => ({ ...current, [provider]: undefined }))
      setQuotas((current) => ({ ...current, [provider]: undefined }))
      if (credentialId) {
        setProviderProductOverrides((current) => ({
          ...current,
          [provider]: providerProductWithoutCredential(
            effectiveProviderProducts[provider],
            provider,
            credentialId,
          ),
        }))
        toast({ description: '已退出账号' })
      } else {
        updateConnectionState(provider, 'disconnected')
        toast({ description: '已断开连接' })
      }
    } catch (error) {
      setProviderError(provider, errorMessage(error))
    } finally {
      setBusy(provider, false)
    }
  }

  const mergeProviderCredential = (
    provider: AiConnectionsProvider,
    credential: AiProviderCredentialSummary,
  ) => {
    setProviderProductOverrides((current) => ({
      ...current,
      [provider]: providerProductWithCredential(
        effectiveProviderProducts[provider],
        provider,
        credential,
      ),
    }))
    updateConnectionState(provider, credential.authMode === 'apiKey' || credential.authMode === 'local'
      ? 'configured'
      : 'connected')
  }

  const createApiKeyCredential = async (
    provider: AiConnectionsProvider,
    offering: AiProviderOffering,
    input: {
      apiKey: string
      label?: string
      baseUrl?: string
      priority: number
    },
  ) => {
    if (!serviceAccessGranted) return
    setBusy(provider, true)
    setProviderError(provider)
    try {
      const credential = await client.createApiKeyCredential(provider, {
        offeringId: offering.id,
        apiKey: input.apiKey,
        label: input.label,
        baseUrl: input.baseUrl,
        priority: input.priority,
      })
      mergeProviderCredential(provider, credential)
      toast({ description: 'API Key 已添加' })
    } catch (error) {
      setProviderError(provider, errorMessage(error))
    } finally {
      setBusy(provider, false)
    }
  }

  const updateProviderCredential = async (
    provider: AiConnectionsProvider,
    credential: AiProviderCredentialSummary,
    patch: {
      label?: string
      enabled?: boolean
      priority?: number
      baseUrl?: string
    },
  ) => {
    if (!serviceAccessGranted) return
    setBusy(provider, true)
    setProviderError(provider)
    try {
      const updated = await client.updateProviderCredential(provider, credential.id, {
        expectedVersion: credential.version,
        ...patch,
      })
      mergeProviderCredential(provider, updated)
      toast({ description: '凭证已更新' })
    } catch (error) {
      setProviderError(provider, errorMessage(error))
    } finally {
      setBusy(provider, false)
    }
  }

  const deleteProviderCredential = async (
    provider: AiConnectionsProvider,
    credential: AiProviderCredentialSummary,
  ) => {
    if (!serviceAccessGranted) return
    setBusy(provider, true)
    setProviderError(provider)
    try {
      await client.deleteProviderCredential(provider, credential.id)
      setProviderProductOverrides((current) => ({
        ...current,
        [provider]: providerProductWithoutCredential(
          effectiveProviderProducts[provider],
          provider,
          credential.id,
        ),
      }))
      toast({ description: '凭证已删除' })
    } catch (error) {
      setProviderError(provider, errorMessage(error))
    } finally {
      setBusy(provider, false)
    }
  }

  const testProviderCredential = async (
    provider: AiConnectionsProvider,
    credential: AiProviderCredentialSummary,
  ) => {
    if (!serviceAccessGranted) return
    setBusy(provider, true)
    setProviderError(provider)
    try {
      await client.testProviderCredential(provider, { credentialId: credential.id })
      toast({ variant: 'success', description: '测试通过' })
    } catch (error) {
      setProviderError(provider, errorMessage(error))
    } finally {
      setBusy(provider, false)
    }
  }

  const reorderProviderCredentials = async (
    provider: AiConnectionsProvider,
    offering: AiProviderOffering,
    credentials: AiProviderCredentialSummary[],
    fromIndex: number,
    toIndex: number,
  ) => {
    if (!serviceAccessGranted || toIndex < 0 || toIndex >= credentials.length) return
    const reordered = [...credentials]
    const [moved] = reordered.splice(fromIndex, 1)
    if (!moved) return
    reordered.splice(toIndex, 0, moved)
    setBusy(provider, true)
    setProviderError(provider)
    try {
      const updatedCredentials: AiProviderCredentialSummary[] = []
      for (const [index, credential] of reordered.entries()) {
        const nextPriority = (index + 1) * 10
        if (credential.priority === nextPriority) {
          updatedCredentials.push(credential)
          continue
        }
        updatedCredentials.push(await client.updateProviderCredential(provider, credential.id, {
          expectedVersion: credential.version,
          priority: nextPriority,
        }))
      }
      setProviderProductOverrides((current) => ({
        ...current,
        [provider]: providerProductWithCredentialList(
          effectiveProviderProducts[provider],
          provider,
          offering,
          updatedCredentials,
        ),
      }))
      toast({ description: '顺序已保存' })
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

  const openModelEditor = (provider: AiConnectionsProvider, model?: AiGatewayModel) => {
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

  const deleteProviderModel = async (provider: AiConnectionsProvider, model: AiGatewayModel) => {
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

  const handleModelSelectionChange = useCallback((
    provider: AiConnectionsProvider,
    modelIds: string[],
  ) => {
    const ids = [...new Set(modelIds)]
    const previousIds = selectedModelIds[provider]
      ?? effectiveProviderProducts[provider]?.selectedModels.map((model) => model.id)
      ?? []
    const generation = (modelSelectionGeneration.current[provider] ?? 0) + 1
    modelSelectionGeneration.current[provider] = generation
    setSelectedModelIds((current) => ({ ...current, [provider]: ids }))
    void (async () => {
      try {
        await client.saveModelSelection?.(provider, ids)
        if (modelSelectionGeneration.current[provider] === generation) {
          onModelSelectionChange?.(provider, ids)
        }
      } catch (error) {
        if (modelSelectionGeneration.current[provider] !== generation) return
        setSelectedModelIds((current) => ({ ...current, [provider]: previousIds }))
        onModelSelectionChange?.(provider, previousIds)
        toast({ variant: 'destructive', description: errorMessage(error) })
      }
    })()
  }, [client, effectiveProviderProducts, modelSelectionGeneration, onModelSelectionChange, selectedModelIds])

  const createKey = async () => {
    if (!serviceAccessGranted) return
    setCreatingKey(true)
    setKeyError(undefined)
    setOneTimeKey(undefined)
    try {
      const created = await client.createGatewayKey({
        ...(keyName.trim() ? { name: keyName.trim() } : {}),
      })
      setOneTimeKey(created.plaintext)
      setKeys((current) => [created.record, ...current])
      setKeyName('')
      toast({ description: 'Gateway Key 已创建' })
    } catch (error) {
      setKeyError(errorMessage(error))
    } finally {
      setCreatingKey(false)
    }
  }

  const revokeKey = async (keyId: string) => {
    if (!serviceAccessGranted) return
    setKeyError(undefined)
    try {
      const record = await client.revokeGatewayKey(keyId)
      setKeys((current) => current.map((item) => item.id === keyId
        ? (record ?? { ...item, revokedAt: new Date().toISOString() })
        : item))
      toast({ description: 'Gateway Key 已撤销' })
    } catch (error) {
      setKeyError(errorMessage(error))
    }
  }

  const copyOneTimeKey = async () => {
    if (!oneTimeKey) return
    await navigator.clipboard?.writeText(oneTimeKey)
    setCopied(true)
  }

  const createManagedGatewayKey = useCallback(async (
    targetClient: AiConnectionsClientId,
  ): Promise<ManagedGatewayKeyLease> => {
    if (!serviceAccessGranted) {
      throw new Error('AI Connection service access is not granted')
    }
    const created = await client.createGatewayKey({
      name: `AI Connection · ${AI_CLIENT_LABELS[targetClient]}`,
    })
    setKeys((current) => [
      created.record,
      ...current.filter((record) => record.id !== created.record.id),
    ])
    return {
      gatewayKey: created.plaintext,
      revoke: async () => {
        await client.revokeGatewayKey(created.record.id)
        setKeys((current) => current.map((record) => record.id === created.record.id
          ? { ...record, revokedAt: new Date().toISOString() }
          : record))
      },
    }
  }, [client, serviceAccessGranted])

  return (
    <div className="mx-auto w-full max-w-5xl space-y-10 px-8 py-8">
      <Toaster />
      <section>
          {providerLoadError ? (
            <p className="mb-4 rounded-md border border-destructive/30 px-3 py-2 text-sm text-destructive">
              Provider 状态读取失败：{providerLoadError}
            </p>
          ) : null}
          {PROVIDERS.filter((definition) => definition.id === (selectedProvider ?? 'openai')).map((definition) => {
            const providerProduct = effectiveProviderProducts[definition.id]
            const providerModels = mergeProviderModelCatalog(
              models.filter((model) => model.provider === definition.id),
              providerProduct?.selectedModels ?? [],
            )
            const providerSelectedModelIds = selectedModelIds[definition.id]
              ?? providerProduct?.selectedModels.map((model) => model.id)
              ?? []
            return (
            <AiProviderCard
              key={definition.id}
              definition={definition}
              product={providerProduct}
              status={connectionStates[definition.id] ?? 'unknown'}
              accountLabel={providerSummariesInput[definition.id]?.accountLabel}
              attempt={attempts[definition.id]}
              apiKey={apiKeyInputs[definition.id] ?? ''}
              baseUrl={baseUrlInputs[definition.id] ?? providerSummariesInput[definition.id]?.baseUrl ?? ''}
              busy={Boolean(busyProviders[definition.id])}
              disabled={!serviceAccessGranted}
              error={providerErrors[definition.id]}
              quota={quotas[definition.id]}
              models={providerModels}
              selectedModelIds={providerSelectedModelIds}
              onApiKeyChange={(value) => setApiKeyInputs((current) => ({
                ...current,
                [definition.id]: value,
              }))}
              onBaseUrlChange={(value) => setBaseUrlInputs((current) => ({
                ...current,
                [definition.id]: value,
              }))}
              onBeginApiKey={() => void beginApiKey(definition.id)}
              onBeginOffering={(offering, mode) => void beginOfferingConnect(definition.id, offering, mode)}
              onBeginBrowser={() => void beginBrowserConnect(definition)}
              onSaveApiKey={() => void saveApiKey(definition)}
              onDisconnect={(credential) => void disconnect(definition.id, credential?.id)}
              onCreateApiKeyCredential={(offering, input) => void createApiKeyCredential(definition.id, offering, input)}
              onUpdateCredential={(credential, patch) => void updateProviderCredential(definition.id, credential, patch)}
              onDeleteCredential={(credential) => void deleteProviderCredential(definition.id, credential)}
              onTestCredential={(credential) => void testProviderCredential(definition.id, credential)}
              onReorderCredentials={(offering, credentials, fromIndex, toIndex) => void reorderProviderCredentials(
                definition.id,
                offering,
                credentials,
                fromIndex,
                toIndex,
              )}
              onRefreshQuota={() => void refreshQuota(definition.id)}
              verifyPending={Boolean(verifyingProviders[definition.id])}
              onVerify={() => void verifyProvider(definition.id)}
              onAddModel={() => openModelEditor(definition.id)}
              onEditModel={(model) => openModelEditor(definition.id, model)}
              onDeleteModel={(model) => void deleteProviderModel(definition.id, model)}
              onModelSelectionChange={handleModelSelectionChange}
              onDismissError={() => setProviderError(definition.id)}
            />
            )
          })}
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

      <details className="space-y-4">
        <summary className="cursor-pointer list-none border-b border-border/40 pb-2 text-sm font-medium text-foreground/90">
          客户端接入
        </summary>
        <div className="mt-4 space-y-6">
          <AiClientConfigurationSection
            bridge={clientConfigurationBridge}
            endpoint={client.apiBase}
            createGatewayKey={createManagedGatewayKey}
          />

          <details className="space-y-4 border-t border-border/40 pt-4">
            <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
              高级：Gateway Keys
            </summary>
            <section className="mt-3 space-y-4">
        <div className="border-b border-border/40 pb-2">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-medium text-foreground/90">Gateway Keys</h3>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            编码客户端只使用 Gateway Key；新密钥明文仅在创建后显示一次。
          </p>
        </div>
        <div className="space-y-4">
          <div className="flex gap-2">
            <Input
              aria-label="Gateway Key 名称"
              placeholder="名称，例如 Codex"
              value={keyName}
              onChange={(event) => setKeyName(event.target.value)}
            />
            <Button onClick={() => void createKey()} disabled={creatingKey || !serviceAccessGranted}>
              {creatingKey ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
              创建 Gateway Key
            </Button>
          </div>

          {oneTimeKey ? (
            <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
              <p className="text-sm font-medium">请立即保存；关闭后无法再次查看。</p>
              <code className="block overflow-x-auto rounded bg-background p-3 text-xs">{oneTimeKey}</code>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => void copyOneTimeKey()}>
                  {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
                  {copied ? '已复制' : '复制'}
                </Button>
                <Button size="sm" onClick={() => {
                  setOneTimeKey(undefined)
                  setCopied(false)
                }}>
                  我已保存，隐藏密钥
                </Button>
              </div>
            </div>
          ) : null}

          {keyError ? <p className="text-sm text-destructive">{keyError}</p> : null}
          {keysLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在读取 Gateway Keys
            </div>
          ) : keys.length === 0 ? (
            <p className="text-sm text-muted-foreground">尚未创建 Gateway Key。</p>
          ) : (
            <div className="space-y-2">
              {keys.map((key) => (
                <div key={key.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{key.name || key.id}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {key.scopes.join(' · ')}
                      {key.revokedAt ? ' · 已撤销' : ''}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`撤销 ${key.name || key.id}`}
                    disabled={Boolean(key.revokedAt) || !serviceAccessGranted}
                    onClick={() => void revokeKey(key.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
            </section>
          </details>
        </div>
      </details>
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

function providerProductWithCredential(
  product: AiProviderSummary | undefined,
  provider: AiConnectionsProvider,
  credential: AiProviderCredentialSummary,
): AiProviderSummary {
  const base = product ?? emptyProviderProduct(provider)
  return {
    ...base,
    credentials: sortCredentialsByPriority([
      ...base.credentials.filter((item) => item.id !== credential.id),
      credential,
    ]),
    status: credential.enabled ? 'available' : base.status,
  }
}

function providerProductWithoutCredential(
  product: AiProviderSummary | undefined,
  provider: AiConnectionsProvider,
  credentialId: string,
): AiProviderSummary {
  const base = product ?? emptyProviderProduct(provider)
  const credentials = base.credentials.filter((credential) => credential.id !== credentialId)
  return {
    ...base,
    credentials,
    status: credentials.length > 0 ? base.status : 'unconfigured',
  }
}

function providerProductWithCredentialList(
  product: AiProviderSummary | undefined,
  provider: AiConnectionsProvider,
  offering: AiProviderOffering,
  updatedCredentials: AiProviderCredentialSummary[],
): AiProviderSummary {
  const base = product ?? emptyProviderProduct(provider)
  const updatedIds = new Set(updatedCredentials.map((credential) => credential.id))
  return {
    ...base,
    offerings: base.offerings.some((item) => item.id === offering.id)
      ? base.offerings
      : [...base.offerings, offering],
    credentials: sortCredentialsByPriority([
      ...base.credentials.filter(
        (credential) => credential.offeringId !== offering.id || !updatedIds.has(credential.id),
      ),
      ...updatedCredentials,
    ]),
  }
}

function emptyProviderProduct(provider: AiConnectionsProvider): AiProviderSummary {
  return {
    id: provider,
    name: PROVIDERS.find((definition) => definition.id === provider)?.name ?? provider,
    offerings: [],
    credentials: [],
    selectedModels: [],
    status: 'unconfigured',
  }
}

function sortCredentialsByPriority(
  credentials: AiProviderCredentialSummary[],
): AiProviderCredentialSummary[] {
  return [...credentials].sort((left, right) => left.priority - right.priority)
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
  current: AiGatewayModel[],
  provider: AiConnectionsProvider,
  discovered: DiscoveredProviderModel[],
): AiGatewayModel[] {
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

function mergeProviderModelCatalog(
  catalog: AiGatewayModel[],
  selectedModels: AiGatewayModel[],
): AiGatewayModel[] {
  const merged = [...catalog]
  for (const selectedModel of selectedModels) {
    const index = merged.findIndex((model) => model.id === selectedModel.id)
    if (index === -1) {
      merged.push(selectedModel)
      continue
    }
    merged[index] = compactModel({
      ...merged[index],
      ...selectedModel,
      displayName: merged[index].displayName ?? selectedModel.displayName,
    })
  }
  return merged
}

function compactModel(model: AiGatewayModel): AiGatewayModel {
  return Object.fromEntries(
    Object.entries(model).filter(([, value]) => value !== undefined),
  ) as AiGatewayModel
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
