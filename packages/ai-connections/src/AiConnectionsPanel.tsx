import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Toaster,
  toast,
} from '@undefineds.co/shared-ui'
import type { AiConnectionsModelSelection } from '@undefineds.co/extension-sdk/web'
import {
  type AiConnectAttempt,
  type AiConnectionsClient,
  type AiGatewayModel,
  type AiConnectionsProvider,
  type AiProviderCredentialSummary,
  type AiProviderConnectionSummary,
  type AiProviderOffering,
  type AiProviderSummary,
  type DiscoveredProviderModel,
  normalizeAiConnectionsThrownError,
} from './ai-connections-client'
import {
  PROVIDERS,
  type AiConnectionsWorkspaceSection,
  type AiProviderDefinition,
  type ProviderProductState,
} from './controller'
import {
  AiProviderCard,
  type ProviderConnectionState,
} from './AiProviderCard'
import type {
  AiOfferingActionError,
  AiOfferingQuotaState,
} from './AiCredentialPoolSection'
import {
  AiModelEditorDialog,
  type AiModelEditorValue,
} from './AiModelEditorDialog'
import { AiGatewayKeysSection } from './AiGatewayKeysSection'
import type { AiClientConfigurationBridge } from './AiClientConfigurationSection'

const EMPTY_PROVIDER_SUMMARIES: Partial<Record<AiConnectionsProvider, AiProviderConnectionSummary>> = {}

interface ModelDiscoveryMergeScope {
  markMissing: boolean
  offeringId?: string
  credentialId?: string
}

export interface AiConnectionsPanelProps {
  client: AiConnectionsClient
  openExternal?: (url: string) => void | Promise<void>
  clientConfigurationBridge?: AiClientConfigurationBridge
  selectedSection?: AiConnectionsWorkspaceSection
  selectedProvider?: AiConnectionsProvider
  selectedCredentialId?: string
  providerSummaries?: Partial<Record<AiConnectionsProvider, AiProviderConnectionSummary>>
  providerProducts?: Partial<Record<AiConnectionsProvider, AiProviderSummary>>
  providerLoadError?: string
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
  selectedSection = 'provider',
  selectedProvider,
  selectedCredentialId,
  providerSummaries: providerSummariesInput = EMPTY_PROVIDER_SUMMARIES,
  providerProducts = {},
  providerLoadError,
  onProviderStateChange,
  onModelSelectionChange,
}: AiConnectionsPanelProps) {
  const [connectionStates, setConnectionStates] = useState<Record<string, ProviderConnectionState>>({})
  const [models, setModels] = useState<AiGatewayModel[]>([])
  const [selectedModelIds, setSelectedModelIds] = useState<
    Partial<Record<AiConnectionsProvider, string[]>>
  >({})
  const [attempts, setAttempts] = useState<Record<string, AiConnectAttempt | undefined>>({})
  const [attemptOfferingIds, setAttemptOfferingIds] = useState<Partial<Record<AiConnectionsProvider, string>>>({})
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({})
  const [baseUrlInputs, setBaseUrlInputs] = useState<Record<string, string>>({})
  const [busyProviders, setBusyProviders] = useState<Record<string, boolean>>({})
  const [providerErrors, setProviderErrors] = useState<Record<string, AiOfferingActionError | undefined>>({})
  const [quotas, setQuotas] = useState<Partial<Record<
    AiConnectionsProvider,
    Partial<Record<string, AiOfferingQuotaState>>
  >>>({})
  const [verifyingProviders, setVerifyingProviders] = useState<Record<string, boolean>>({})
  const [modelEditor, setModelEditor] = useState<{
    provider: AiConnectionsProvider
    model?: AiGatewayModel
  }>()
  const [modelEditorError, setModelEditorError] = useState<string>()
  const [modelEditorSaving, setModelEditorSaving] = useState(false)
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
        const ids = product.selectedModels.map(modelSelectionId)
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
    void client.listModels()
      .then((availableModels) => {
        if (active) setModels(availableModels)
      })
      // Model discovery has its own Provider status surface. A discovery
      // failure must not be rendered as a Client Access error.
      .catch(() => undefined)
    return () => {
      active = false
      pollingGeneration.current += 1
    }
  }, [client])

  const setBusy = (provider: AiConnectionsProvider, value: boolean) => {
    setBusyProviders((current) => ({ ...current, [provider]: value }))
  }

  const setProviderError = (
    provider: AiConnectionsProvider,
    value?: string,
    offeringId?: string,
  ) => {
    setProviderErrors((current) => ({
      ...current,
      [provider]: value ? { message: value, offeringId } : undefined,
    }))
  }

  const openAttemptUrl = useCallback(async (attempt: AiConnectAttempt) => {
    const target = attempt.verificationUriComplete
      ?? attempt.authorizationUrl
      ?? attempt.verificationUri
    if (target) await openExternal(target)
  }, [openExternal])

  const beginApiKey = async (provider: AiConnectionsProvider) => {
    setBusy(provider, true)
    setProviderError(provider)
    setAttemptOfferingIds((current) => ({ ...current, [provider]: undefined }))
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
    await beginConnectMode(provider, mode, offering.id)
  }

  const beginConnectMode = async (
    provider: AiConnectionsProvider,
    mode: AiConnectAttempt['mode'],
    offeringId?: string,
  ) => {
    if (mode === 'connectUnsupported') return
    setBusy(provider, true)
    setProviderError(provider)
    setAttemptOfferingIds((current) => ({ ...current, [provider]: offeringId }))
    const generation = pollingGeneration.current + 1
    pollingGeneration.current = generation
    try {
      const attempt = await client.beginConnect(provider, mode)
      setAttempts((current) => ({ ...current, [provider]: attempt }))
      if (!isPendingAttempt(attempt.status)) {
        const connected = attempt.status === 'completed'
        updateConnectionState(provider, connected ? 'connected' : 'failed')
        if (!connected) {
          setProviderError(provider, attempt.status === 'unsupported'
            ? '当前部署未启用账号授权'
            : attempt.message ?? connectFailureMessage(attempt.status), offeringId)
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
          setProviderError(provider, message, offeringId)
        },
        onFinished: () => setBusy(provider, false),
      })
    } catch (error) {
      updateConnectionState(provider, 'failed')
      setProviderError(provider, errorMessage(error), offeringId)
      setBusy(provider, false)
    }
  }

  const saveApiKey = async (definition: AiProviderDefinition) => {
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
    const offeringId = credentialId
      ? effectiveProviderProducts[provider]?.credentials.find((credential) => credential.id === credentialId)?.offeringId
      : undefined
    setBusy(provider, true)
    setProviderError(provider)
    try {
      await client.disconnect(provider, credentialId)
      setAttempts((current) => ({ ...current, [provider]: undefined }))
      setAttemptOfferingIds((current) => ({ ...current, [provider]: undefined }))
      setQuotas((current) => ({
        ...current,
        [provider]: offeringId
          ? { ...current[provider], [offeringId]: undefined }
          : undefined,
      }))
      if (credentialId) {
        setProviderProductOverrides((current) => ({
          ...current,
          [provider]: providerProductWithoutCredential(
            effectiveProviderProducts[provider],
            provider,
            credentialId,
          ),
        }))
        toast({ description: '已从当前 Pod 移除账号' })
      } else {
        updateConnectionState(provider, 'disconnected')
        toast({ description: '已断开连接' })
      }
    } catch (error) {
      setProviderError(provider, errorMessage(error), offeringId)
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

  const syncProviderModels = async (
    provider: AiConnectionsProvider,
    input?: { offeringId?: string; credentialId?: string },
    announceSuccess = false,
  ): Promise<boolean> => {
    setVerifyingProviders((current) => ({ ...current, [provider]: true }))
    setProviderError(provider)
    try {
      const discovery = input
        ? await client.discoverModels(provider, input)
        : await client.discoverModels(provider)
      const selectedModels = effectiveProviderProducts[provider]?.selectedModels ?? []
      const mergeScope = modelDiscoveryMergeScope(provider, input)
      try {
        const persisted = await client.listModels()
        const persistedForProvider = persisted
          .filter((model) => model.provider === provider)
        setModels((current) => {
          const withPersisted = mergeDiscoveredModels(
            current,
            provider,
            persistedForProvider,
            mergeScope,
          )
          const withDiscovery = mergeDiscoveredModels(
            withPersisted,
            provider,
            discovery.models,
            mergeScope,
          )
          return markMissingSelectedModelsUnavailable(
            withDiscovery,
            provider,
            selectedModels,
            discovery.models,
            mergeScope,
          )
        })
      } catch {
        setModels((current) => markMissingSelectedModelsUnavailable(
          mergeDiscoveredModels(current, provider, discovery.models, mergeScope),
          provider,
          selectedModels,
          discovery.models,
          mergeScope,
        ))
      }
      try {
        const products = await client.listProviders()
        const product = products.find((item) => item.id === provider)
        if (product) {
          setProviderProductOverrides((current) => ({
            ...current,
            [provider]: product,
          }))
        }
      } catch {
        // The model catalog already reflects the discovery result; provider
        // summaries will refresh on the next host/provider reload.
      }
      if (announceSuccess) {
        toast({
          variant: discovery.models.length > 0 ? 'success' : 'default',
          description: discovery.models.length > 0
            ? `连接成功，已同步 ${discovery.models.length} 个模型`
            : '连接成功，但服务商未返回任何模型。请确认该服务支持 /models 接口，或使用「添加模型」手工录入。',
        })
      }
      return true
    } catch (error) {
      const message = errorMessage(error)
      setProviderError(provider, message, input?.offeringId)
      return false
    } finally {
      setVerifyingProviders((current) => ({ ...current, [provider]: false }))
    }
  }

  const createApiKeyCredential = async (
    provider: AiConnectionsProvider,
    offering: AiProviderOffering,
    input: {
      apiKey: string
      label?: string
      baseUrl?: string
      proxyUrl?: string
      priority: number
    },
  ) => {
    setBusy(provider, true)
    setProviderError(provider)
    try {
      const credential = await client.createApiKeyCredential(provider, {
        offeringId: offering.id,
        apiKey: input.apiKey,
        label: input.label,
        baseUrl: input.baseUrl,
        proxyUrl: input.proxyUrl,
        priority: input.priority,
      })
      mergeProviderCredential(provider, credential)
      toast({ description: 'API Key 已添加' })
      await syncProviderModels(provider, {
        offeringId: credential.offeringId,
        credentialId: credential.id,
      })
    } catch (error) {
      const message = errorMessage(error)
      setProviderError(provider, message, offering.id)
      throw new Error(message)
    } finally {
      setBusy(provider, false)
    }
  }

  const createLocalCredential = async (
    provider: AiConnectionsProvider,
    offering: AiProviderOffering,
  ) => {
    setBusy(provider, true)
    setProviderError(provider)
    try {
      const isOpenAiSubscription = provider === 'openai' && offering.id === 'official-subscription'
      const credential = await client.createLocalCredential(provider, {
        offeringId: offering.id,
        label: isOpenAiSubscription ? 'OpenAI Subscription' : 'Local Ollama',
        ...(isOpenAiSubscription ? {} : { baseUrl: offering.endpoints?.[0]?.baseUrl }),
        priority: 10,
      })
      mergeProviderCredential(provider, credential)
      toast({ description: isOpenAiSubscription ? '本机 OpenAI 登录已导入' : '本地 Ollama 已连接' })
      if (offering.modelDiscovery?.strategy !== 'unsupported') {
        await syncProviderModels(provider, {
          offeringId: credential.offeringId,
          credentialId: credential.id,
        })
      }
    } catch (error) {
      const message = errorMessage(error)
      setProviderError(provider, message, offering.id)
      throw new Error(message)
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
      proxyUrl?: string
    },
  ) => {
    setBusy(provider, true)
    setProviderError(provider)
    try {
      const updated = await client.updateProviderCredential(provider, credential.id, {
        expectedVersion: credential.version,
        ...patch,
      })
      mergeProviderCredential(provider, updated)
      toast({ description: '凭证已更新' })
      if (updated.enabled) {
        await syncProviderModels(provider, {
          offeringId: updated.offeringId,
          credentialId: updated.id,
        })
      }
    } catch (error) {
      const message = errorMessage(error)
      setProviderError(provider, message, credential.offeringId)
      throw new Error(message)
    } finally {
      setBusy(provider, false)
    }
  }

  const deleteProviderCredential = async (
    provider: AiConnectionsProvider,
    credential: AiProviderCredentialSummary,
  ) => {
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
      setProviderError(provider, errorMessage(error), credential.offeringId)
    } finally {
      setBusy(provider, false)
    }
  }

  const testProviderCredential = async (
    provider: AiConnectionsProvider,
    credential: AiProviderCredentialSummary,
  ) => {
    setBusy(provider, true)
    setProviderError(provider)
    try {
      const result = await client.testProviderCredential(provider, { credentialId: credential.id })
      const testedCredential = providerCredentialFromTestResult(result)
      setProviderProductOverrides((current) => ({
        ...current,
        [provider]: testedCredential
          ? providerProductWithCredential(effectiveProviderProducts[provider], provider, testedCredential)
          : providerProductWithCredentialHealth(
              effectiveProviderProducts[provider], provider, credential.id, 'healthy',
            ),
      }))
      toast({ variant: 'success', description: '测试通过' })
    } catch (error) {
      const refreshedProduct = (await client.listProviders().catch(() => []))
        .find((candidate) => candidate.id === provider)
      setProviderProductOverrides((current) => ({
        ...current,
        [provider]: refreshedProduct ?? providerProductWithCredentialHealth(
          effectiveProviderProducts[provider], provider, credential.id, 'invalid',
        ),
      }))
      setProviderError(provider, errorMessage(error), credential.offeringId)
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
    if (toIndex < 0 || toIndex >= credentials.length) return
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
      setProviderError(provider, errorMessage(error), offering.id)
    } finally {
      setBusy(provider, false)
    }
  }

  const refreshQuota = async (
    provider: AiConnectionsProvider,
    offering: AiProviderOffering,
    credential?: AiProviderCredentialSummary,
  ) => {
    const setQuotaState = (patch: Partial<AiOfferingQuotaState>) => {
      setQuotas((current) => ({
        ...current,
        [provider]: {
          ...current[provider],
          [offering.id]: {
            busy: false,
            ...current[provider]?.[offering.id],
            ...patch,
          },
        },
      }))
    }
    setQuotaState({ busy: true, error: undefined, credentialId: credential?.id })
    try {
      const quota = await client.quota(provider, true, {
        offeringId: offering.id,
        ...(credential ? {
          credentialId: credential.id,
          credentialIri: credential.id,
        } : {}),
      })
      setQuotaState({ quota, busy: false, error: undefined, credentialId: credential?.id })
    } catch (error) {
      setQuotaState({ busy: false, error: errorMessage(error), credentialId: credential?.id })
    }
  }

  const verifyProvider = async (provider: AiConnectionsProvider) => {
    await syncProviderModels(
      provider,
      provider === 'custom' && selectedCredentialId
        ? { credentialId: selectedCredentialId }
        : undefined,
      true,
    )
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
    if (!modelEditor) return
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
      ?? effectiveProviderProducts[provider]?.selectedModels.map(modelSelectionId)
      ?? []
    const generation = (modelSelectionGeneration.current[provider] ?? 0) + 1
    modelSelectionGeneration.current[provider] = generation
    setSelectedModelIds((current) => ({ ...current, [provider]: ids }))
    void (async () => {
      try {
        const candidates = [
          ...models.filter((model) => model.provider === provider),
          ...(effectiveProviderProducts[provider]?.selectedModels ?? []),
        ]
        const selections = ids.map((selectionId): AiConnectionsModelSelection => {
          const model = candidates.find((candidate) => modelSelectionId(candidate) === selectionId)
          if (!model) return { id: selectionId }
          return compactModelSelection(model)
        })
        if (provider === 'custom') {
          await client.saveModelSelection?.(provider, selections, selectedCredentialId)
        } else {
          await client.saveModelSelection?.(provider, selections)
        }
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
  }, [client, effectiveProviderProducts, modelSelectionGeneration, models, onModelSelectionChange, selectedCredentialId, selectedModelIds])

  const providerContent = (
      <section>
          {providerLoadError ? (
            <p className="mb-4 rounded-md border border-destructive/30 px-3 py-2 text-sm text-destructive">
              Provider 状态读取失败：{providerLoadError}
            </p>
          ) : null}
          {PROVIDERS.filter((definition) => definition.id === (selectedProvider ?? 'openai')).map((definition) => {
            const providerProduct = effectiveProviderProducts[definition.id]
            const providerModels = mergeProviderModelCatalog(
              models.filter((model) => model.provider === definition.id
                && (definition.id !== 'custom' || !selectedCredentialId || model.credentialId === selectedCredentialId)),
              providerProduct?.selectedModels ?? [],
            )
            const providerSelectedModelIds = selectedModelIds[definition.id]
              ?? providerProduct?.selectedModels.map(modelSelectionId)
              ?? []
            return (
            <AiProviderCard
              key={definition.id}
              definition={definition}
              product={providerProduct}
              status={resolvedConnectionState(connectionStates[definition.id], providerProduct)}
              accountLabel={providerSummariesInput[definition.id]?.accountLabel}
              attempt={attempts[definition.id]}
              attemptOfferingId={attemptOfferingIds[definition.id]}
              apiKey={apiKeyInputs[definition.id] ?? ''}
              baseUrl={baseUrlInputs[definition.id] ?? providerSummariesInput[definition.id]?.baseUrl ?? ''}
              busy={Boolean(busyProviders[definition.id])}
              error={providerErrors[definition.id]}
              quotas={quotas[definition.id]}
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
              onCreateApiKeyCredential={(offering, input) => createApiKeyCredential(definition.id, offering, input)}
              onCreateLocalCredential={(offering) => createLocalCredential(definition.id, offering)}
              onUpdateCredential={(credential, patch) => updateProviderCredential(definition.id, credential, patch)}
              onDeleteCredential={(credential) => void deleteProviderCredential(definition.id, credential)}
              onTestCredential={(credential) => void testProviderCredential(definition.id, credential)}
              onReorderCredentials={(offering, credentials, fromIndex, toIndex) => void reorderProviderCredentials(
                definition.id,
                offering,
                credentials,
                fromIndex,
                toIndex,
              )}
              onRefreshQuota={(offering, credential) => void refreshQuota(definition.id, offering, credential)}
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
  )

  const keyContent = (
    <AiGatewayKeysSection
      client={client}
      clientConfigurationBridge={clientConfigurationBridge}
    />
  )

  return (
    <div
      data-testid="ai-connections-panel"
      className="mx-auto w-full max-w-5xl space-y-10 px-4 py-6 sm:px-8 sm:py-8"
    >
      <Toaster />
      {selectedSection === 'keys' ? keyContent : null}
      {selectedSection === 'provider' ? providerContent : null}
      {selectedSection === 'provider' && modelEditor ? (
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

function connectionStateFromProduct(product: AiProviderSummary | undefined): ProviderConnectionState {
  if (!product || product.status === 'unconfigured' || product.status === 'unavailable') {
    return 'disconnected'
  }
  if (product.status === 'configured') return 'configured'
  if (product.status === 'attention') return 'reauthRequired'
  const credential = product.credentials.find((candidate) => candidate.enabled)
    ?? product.credentials[0]
  return credential?.authMode === 'oauth' || credential?.authMode === 'deviceCode'
    ? 'connected'
    : 'configured'
}

function resolvedConnectionState(
  transientState: ProviderConnectionState | undefined,
  product: AiProviderSummary | undefined,
): ProviderConnectionState {
  if (transientState === 'pending' || transientState === 'failed') return transientState
  return product ? connectionStateFromProduct(product) : transientState ?? 'unknown'
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
  const credentials = sortCredentialsByPriority([
    ...base.credentials.filter((item) => item.id !== credential.id),
    credential,
  ])
  return {
    ...base,
    credentials,
    status: providerStatusFromCredentials(credentials),
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
    status: providerStatusFromCredentials(credentials),
  }
}

function providerProductWithCredentialHealth(
  product: AiProviderSummary | undefined,
  provider: AiConnectionsProvider,
  credentialId: string,
  health: AiProviderCredentialSummary['health'],
): AiProviderSummary {
  const base = product ?? emptyProviderProduct(provider)
  const credentials = base.credentials.map((credential) => (
    credential.id === credentialId ? { ...credential, health } : credential
  ))
  return {
    ...base,
    credentials,
    status: credentials.some((credential) => credential.enabled && credential.health === 'invalid')
      ? 'attention'
      : providerStatusFromCredentials(credentials),
  }
}

function providerCredentialFromTestResult(value: Record<string, unknown>): AiProviderCredentialSummary | undefined {
  const credential = value.credential
  if (!credential || typeof credential !== 'object') return undefined
  const candidate = credential as Partial<AiProviderCredentialSummary>
  return typeof candidate.id === 'string'
    && typeof candidate.offeringId === 'string'
    && (candidate.authMode === 'oauth' || candidate.authMode === 'deviceCode' || candidate.authMode === 'apiKey' || candidate.authMode === 'local')
    && typeof candidate.version === 'number'
    ? candidate as AiProviderCredentialSummary
    : undefined
}

function providerStatusFromCredentials(
  credentials: AiProviderCredentialSummary[],
): AiProviderSummary['status'] {
  if (credentials.length === 0) return 'unconfigured'
  const enabled = credentials.filter((credential) => credential.enabled)
  if (enabled.length === 0) return 'configured'
  if (enabled.some((credential) => credential.health === 'expired' || credential.health === 'invalid')) {
    return 'attention'
  }
  return 'available'
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
  const message = normalizeAiConnectionsThrownError(error)
  return message === 'AI Connection request failed. Please try again.'
    ? '请求未完成。请确认 Xpod 正在运行且登录仍有效，然后重试。'
    : message
}

function modelDiscoveryMergeScope(
  provider: AiConnectionsProvider,
  input?: { offeringId?: string; credentialId?: string },
): ModelDiscoveryMergeScope {
  if (provider === 'custom') {
    return input?.credentialId
      ? { markMissing: true, credentialId: input.credentialId }
      : { markMissing: !input }
  }
  return input?.offeringId
    ? { markMissing: true, offeringId: input.offeringId }
    : { markMissing: !input }
}

function mergeDiscoveredModels(
  current: AiGatewayModel[],
  provider: AiConnectionsProvider,
  discovered: Array<DiscoveredProviderModel | AiGatewayModel>,
  scope: ModelDiscoveryMergeScope = { markMissing: false },
): AiGatewayModel[] {
  const discoveredIds = new Set(discovered.map((model) => model.id))
  const merged = current.map((model) => (
    scope.markMissing
    && model.provider === provider
    && !model.custom
    && !discoveredIds.has(model.id)
    && (scope.offeringId === undefined || model.offeringId === scope.offeringId)
    && (scope.credentialId === undefined || model.credentialId === scope.credentialId)
      ? compactModel({ ...model, availability: 'unavailable' })
      : model
  ))
  for (const model of discovered) {
    const candidate = model as DiscoveredProviderModel & Partial<AiGatewayModel>
    const persistedCatalogModel = 'provider' in model
    const offeringId = candidate.offeringId
      ?? (persistedCatalogModel ? undefined : scope.offeringId)
    const credentialId = candidate.credentialId
      ?? (persistedCatalogModel ? undefined : scope.credentialId)
    const index = merged.findIndex((item) => {
      if (item.provider !== provider) return false
      if (candidate.resourceId && item.resourceId) {
        return candidate.resourceId === item.resourceId
      }
      if (credentialId !== undefined) {
        return item.id === candidate.id && item.credentialId === credentialId
      }
      if (offeringId !== undefined) {
        return item.id === candidate.id && item.offeringId === offeringId
      }
      return item.id === candidate.id && item.offeringId === undefined
    })
    if (index === -1) {
      merged.push(compactModel({
        ...candidate,
        id: candidate.id,
        provider,
        availability: candidate.availability ?? 'available',
        ...(offeringId ? { offeringId } : {}),
        ...(credentialId ? { credentialId } : {}),
      }))
    } else {
      merged[index] = compactModel({
        ...merged[index],
        ...candidate,
        provider,
        displayName: candidate.displayName ?? merged[index].displayName,
        availability: candidate.availability ?? 'available',
        ...(offeringId ? { offeringId } : {}),
        ...(credentialId ? { credentialId } : {}),
      })
    }
  }
  return merged
}

function markMissingSelectedModelsUnavailable(
  current: AiGatewayModel[],
  provider: AiConnectionsProvider,
  selectedModels: AiGatewayModel[],
  discovered: DiscoveredProviderModel[],
  scope: ModelDiscoveryMergeScope,
): AiGatewayModel[] {
  if (!scope.markMissing || selectedModels.length === 0) return current
  const discoveredIds = new Set(discovered.map((model) => model.id))
  const merged = [...current]
  for (const selected of selectedModels.filter((model) => model.provider === provider)) {
    if (selected.custom) continue
    if (scope.offeringId !== undefined && selected.offeringId !== scope.offeringId) continue
    if (scope.credentialId !== undefined && selected.credentialId !== scope.credentialId) continue
    if (discoveredIds.has(selected.id)) continue
    const selectionId = modelSelectionId(selected)
    const index = merged.findIndex((model) => model.provider === provider && modelSelectionId(model) === selectionId)
    const unavailable = compactModel({ ...selected, availability: 'unavailable' })
    if (index === -1) {
      merged.push(unavailable)
    } else {
      merged[index] = compactModel({
        ...merged[index],
        ...unavailable,
        displayName: merged[index].displayName ?? unavailable.displayName,
      })
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
    const index = merged.findIndex((model) => modelSelectionId(model) === modelSelectionId(selectedModel))
    if (index === -1) {
      merged.push(selectedModel)
      continue
    }
    merged[index] = compactModel({
      ...merged[index],
      ...selectedModel,
      displayName: merged[index].displayName ?? selectedModel.displayName,
      availability: merged[index].availability === 'unavailable'
        ? 'unavailable'
        : selectedModel.availability,
    })
  }
  return merged
}

function compactModel(model: AiGatewayModel): AiGatewayModel {
  return Object.fromEntries(
    Object.entries(model).filter(([, value]) => value !== undefined),
  ) as AiGatewayModel
}

function modelSelectionId(model: AiGatewayModel): string {
  return model.resourceId
    ?? (model.offeringId ? `${model.offeringId}:${model.id}` : model.id)
}

function compactModelSelection(model: AiGatewayModel): AiConnectionsModelSelection {
  return {
    id: model.id,
    ...(model.offeringId ? { offeringId: model.offeringId } : {}),
    ...(model.resourceId ? { resourceId: model.resourceId } : {}),
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
