import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createXpodAiConnectionsClient } from '../../../api/ai-connections';
import {
  fetchAiConfig,
  scheduleAiConfigRebuild,
  updateAiConfig,
  type AiConfigCapabilities,
  type AiConfigPolicy,
  type AiConfigPolicyPatch,
  type AiConfigLifecycleSnapshot,
  type AiConfigRebuildTarget,
} from '../../../api/ai-config';
import { useXpodSolidRuntime } from '../../../solid/useXpodSolidRuntime';
import { aiConfigModelRef } from '@undefineds.co/models/ai-config';
import type { AiGatewayModel } from '@undefineds.co/ai-connections';

interface AiConfigContextValue {
  config?: AiConfigPolicy;
  capabilities?: AiConfigCapabilities;
  lifecycle?: AiConfigLifecycleSnapshot;
  models: AiConfigModelOption[];
  loading: boolean;
  saving: boolean;
  rebuilding: boolean;
  error?: string;
  reload(): void;
  save(patch: AiConfigPolicyPatch): Promise<void>;
  rebuild(target: AiConfigRebuildTarget): Promise<void>;
  saveAndRebuild(patch: AiConfigPolicyPatch, target: AiConfigRebuildTarget): Promise<void>;
}

const AiConfigContext = createContext<AiConfigContextValue | undefined>(undefined);

export function AiConfigProvider({ children }: { children: ReactNode }) {
  const runtime = useXpodSolidRuntime();
  const [config, setConfig] = useState<AiConfigPolicy>();
  const [capabilities, setCapabilities] = useState<AiConfigCapabilities>();
  const [models, setModels] = useState<AiConfigModelOption[]>([]);
  const [lifecycle, setLifecycle] = useState<AiConfigLifecycleSnapshot>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [error, setError] = useState<string>();
  const [loadRequest, setLoadRequest] = useState(0);
  const hasRuntimeTarget = Boolean(runtime.webId && runtime.currentPod);

  useEffect(() => {
    if (!runtime.webId || !runtime.currentPod) {
      return;
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || !runtime.webId || !runtime.currentPod) return;
      setLoading(true);
      setError(undefined);
      const client = createXpodAiConnectionsClient({
        webId: runtime.webId,
        podUrl: runtime.currentPod.podUrl,
        authenticatedFetch: runtime.fetch,
      });
      void Promise.all([
        fetchAiConfig(runtime.fetch),
        client.listModels().catch(() => []),
      ]).then(([result, availableModels]) => {
        if (cancelled) return;
        setConfig(result.config);
        setCapabilities(result.capabilities);
        setLifecycle(result.lifecycle);
        setModels(toAiConfigModelOptions(availableModels));
      }).catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      }).finally(() => {
        if (!cancelled) setLoading(false);
      });
    });
    return () => { cancelled = true; };
  }, [loadRequest, runtime.currentPod, runtime.fetch, runtime.webId]);

  const reload = useCallback(() => {
    setLoadRequest((current) => current + 1);
  }, []);

  const save = useCallback(async (patch: AiConfigPolicyPatch) => {
    setSaving(true);
    setError(undefined);
    try {
      const result = await updateAiConfig(runtime.fetch, patch);
      setConfig(result.config);
      setCapabilities(result.capabilities);
      setLifecycle(result.lifecycle);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      setSaving(false);
    }
  }, [runtime.fetch]);

  const rebuild = useCallback(async (target: AiConfigRebuildTarget) => {
    setRebuilding(true);
    setError(undefined);
    try {
      const job = await scheduleAiConfigRebuild(runtime.fetch, target);
      setLifecycle((current) => ({
        configurationVersion: current?.configurationVersion,
        pending: (current?.pending ?? 0) + 1,
        recent: [job, ...(current?.recent ?? [])].slice(0, 20),
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      setRebuilding(false);
    }
  }, [runtime.fetch]);

  const saveAndRebuild = useCallback(async (patch: AiConfigPolicyPatch, target: AiConfigRebuildTarget) => {
    await save(patch);
    await rebuild(target);
  }, [rebuild, save]);

  const effectiveLoading = hasRuntimeTarget ? loading : false;
  const value = useMemo(() => ({ config, capabilities, lifecycle, models, loading: effectiveLoading, saving, rebuilding, error, reload, save, rebuild, saveAndRebuild }), [
    capabilities, config, effectiveLoading, error, lifecycle, models, rebuild, rebuilding, reload, save, saveAndRebuild, saving,
  ]);
  return <AiConfigContext.Provider value={value}>{children}</AiConfigContext.Provider>;
}

export interface AiConfigModelOption {
  id: string;
  displayName?: string;
  owner: string;
  ref: string;
  capabilities: string[];
}

// eslint-disable-next-line react-refresh/only-export-components -- covered by focused tests and shared with non-component panels.
export function toAiConfigModelOptions(models: AiGatewayModel[]): AiConfigModelOption[] {
  return models.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    owner: model.provider,
    ref: aiConfigModelRef(model.provider, model.id),
    capabilities: model.capabilities ?? [],
  }));
}

// eslint-disable-next-line react-refresh/only-export-components -- pure helper exported for focused tests and model assignment controls.
export function modelsForAssignment(models: AiConfigModelOption[], assignment: import('../../../api/ai-config').AiConfigModelAssignment): AiConfigModelOption[] {
  const required: Partial<Record<typeof assignment, string[]>> = {
    chatModel: ['chat'],
    ocrModel: ['ocr'], readerModel: ['document-understanding', 'documentunderstanding'],
    embeddingModel: ['embedding'], indexerModel: ['indexing'], rerankerModel: ['reranking', 'reranker'],
  };
  const accepted = required[assignment];
  if (!accepted) return models;
  return models.filter((model) => model.capabilities.some((capability) => accepted.includes(capability.toLowerCase())));
}

// eslint-disable-next-line react-refresh/only-export-components -- hook is intentionally colocated with its provider context.
export function useAiConfig(): AiConfigContextValue {
  const value = useContext(AiConfigContext);
  if (!value) throw new Error('useAiConfig must be used within AiConfigProvider');
  return value;
}
