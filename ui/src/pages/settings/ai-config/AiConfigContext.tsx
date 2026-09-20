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
import type { AiGatewayModel } from '@undefineds.co/ai-connections-core/client';
import { createXpodAiConnectionsPodStore } from '../../../extensions/XpodAiConnectionsPodStore';

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

/**
 * How often a queued rebuild is polled while the page is waiting on it.
 *
 * The queue is drained by the API service, so the page can only learn a job's
 * outcome by asking again; two seconds keeps the progress line moving without
 * turning the settings page into a busy loop.
 */
const REBUILD_POLL_INTERVAL_MS = 2_000;

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
      // The routing projection publishes what the account picked; the Pod
      // catalog holds every model a sync discovered. A Pod that only picked chat
      // models would otherwise offer no embedding model at all, which is exactly
      // the assignment this page exists to make.
      const podModelsPromise = createXpodAiConnectionsPodStore({
        database: runtime.currentPod.database,
        authenticatedFetch: runtime.fetch,
        podUrl: runtime.currentPod.podUrl,
        webId: runtime.currentPod.webId,
      }).listModels?.() as Promise<AiGatewayModel[]> | undefined;
      const catalogModels = podModelsPromise?.catch(() => [] as AiGatewayModel[])
        ?? Promise.resolve([] as AiGatewayModel[]);
      void Promise.all([
        fetchAiConfig(runtime.fetch),
        client.listModels().catch(() => []),
        catalogModels,
      ]).then(([result, publishedModels, catalogModels]) => {
        if (cancelled) return;
        setConfig(result.config);
        setCapabilities(result.capabilities);
        setLifecycle(result.lifecycle);
        setModels(toAiConfigModelOptions(mergeModelCatalog(catalogModels, publishedModels)));
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

  /**
   * Follow a queued rebuild to its outcome.
   *
   * A model switch only takes effect once the derived index is rebuilt with the
   * new model, so the page that asked for the rebuild has to show it running
   * instead of leaving the user on a saved form. Only the lifecycle is replaced
   * here: re-applying `config` would discard the unsaved edits the panels hold
   * while the rebuild is in flight.
   */
  const pendingRebuilds = lifecycle?.pending ?? 0;
  useEffect(() => {
    if (pendingRebuilds <= 0 || !runtime.webId || !runtime.currentPod) {
      return;
    }
    let cancelled = false;
    const timer = setInterval(() => {
      void fetchAiConfig(runtime.fetch)
        .then((result) => { if (!cancelled) setLifecycle(result.lifecycle); })
        .catch(() => undefined);
    }, REBUILD_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pendingRebuilds, runtime.currentPod, runtime.fetch, runtime.webId]);

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

/**
 * Pod catalog first, published projection as the enrichment.
 *
 * One model can arrive from both sources: the Pod row carries the stored type and
 * the identity it is stored under, the projection carries the catalog's
 * capability set. Folding them keeps the union of both, so an embedding model
 * stays recognizable and a chat model keeps every mark the catalog declares.
 *
 * The folded row is named by its model id, not by the resource it lives in: the
 * assignment is persisted as a reference built from `provider + id`, so a
 * resource-shaped id here would be stored as the model's name.
 */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper exported for focused tests and model assignment controls.
export function mergeModelCatalog(catalog: AiGatewayModel[], published: AiGatewayModel[]): AiGatewayModel[] {
  const merged = new Map<string, AiGatewayModel>()
  const keyOf = (model: AiGatewayModel): string => `${model.provider}\u0000${modelCatalogId(model.id)}`
  for (const model of [...catalog, ...published]) {
    const key = keyOf(model)
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { ...model, id: modelCatalogId(model.id) })
      continue
    }
    const capabilities = [...new Set([...(existing.capabilities ?? []), ...(model.capabilities ?? [])])]
    merged.set(key, {
      ...existing,
      ...model,
      id: modelCatalogId(model.id),
      resourceId: existing.resourceId ?? model.resourceId,
      displayName: existing.displayName ?? model.displayName,
      availability: existing.availability === 'available' ? existing.availability : model.availability,
      modelType: existing.modelType ?? model.modelType,
      ...(capabilities.length > 0 ? { capabilities } : {}),
      ...(existing.inputModalities ?? model.inputModalities
        ? { inputModalities: existing.inputModalities ?? model.inputModalities }
        : {}),
    })
  }
  return [...merged.values()]
}

/** A model id is the fragment it names, whatever document it is stored under. */
function modelCatalogId(id: string): string {
  const fragment = id.lastIndexOf('#')
  return fragment >= 0 ? id.slice(fragment + 1) : id
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
