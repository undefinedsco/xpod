import { useEffect, useState } from 'react';
import { eligiblePodEmbeddingModels, podCapabilityNames, podModelsForAssignment } from './model-options';
import { PodBody, type PodBodyProps, type PodModel, type PodModelRow, type PodSection } from '@undefineds.co/pod-settings';
import { AiConfigProvider, useAiConfig } from '../settings/ai-config/AiConfigContext';
import { rebuildInFlight, rebuildTargetForCapabilities } from '../settings/ai-config/model-assignment-state';
import { useBackgroundPodAccess } from '../settings/ai-config/useBackgroundPodAccess';
import { useXpodSolidRuntime } from '../../solid/useXpodSolidRuntime';
import { testAiConfigModel, type AiConfigModelAssignment } from '../../api/ai-config';
import { fetchPodSettingsStatus, type PodStorageStatus } from '../../api/pod-settings';
import { matchesPlatformModelRole, type PLATFORM_MODEL_ROLES } from '@undefineds.co/ai-connections/client';

export interface PodPageProps { section: PodSection; onSection(section: PodSection): void; accountUrl?: string }
export default function PodPage(props: PodPageProps) {
  return <AiConfigProvider><PodPageContent {...props} /></AiConfigProvider>;
}

function PodPageContent({ section, onSection, accountUrl }: PodPageProps) {
  const state = useAiConfig();
  const runtime = useXpodSolidRuntime();
  const access = useBackgroundPodAccess();
  const [storage, setStorage] = useState<{ webId: string; podUrl: string; value: PodStorageStatus }>();
  useEffect(() => {
    let cancelled = false;
    if (section !== 'data' || !runtime.webId || !runtime.currentPod) return;
    void fetchPodSettingsStatus({ webId: runtime.webId, podUrl: runtime.currentPod.podUrl, authenticatedFetch: runtime.fetch }).then(result => { if (!cancelled) setStorage({ webId: runtime.webId!, podUrl: runtime.currentPod!.podUrl, value: result.storage }); }).catch(() => { if (!cancelled) setStorage({ webId: runtime.webId!, podUrl: runtime.currentPod!.podUrl, value: { status: 'error' } }); });
    return () => { cancelled = true; };
  }, [section, runtime.webId, runtime.currentPod, runtime.fetch]);
  if ((section === 'models' || section === 'search') && !state.config) {
    return <div className="p-6 text-sm">{state.loading ? '正在读取 Pod 设置…' : '暂时无法读取 Pod 设置。'}{!state.loading && (state.error?.includes('service_access_missing') ? <button className="ml-3 text-primary" disabled={access.working || access.loading} onClick={() => void access.grant().then(state.reload).catch(() => undefined)}>允许 Xpod 访问</button> : <button className="ml-3 text-primary" onClick={state.reload}>重试</button>)}</div>;
  }
  const config = state.config;
  const gatewayStatus: PodModelRow['status'] = state.gatewayCatalog.status === 'available' && state.gatewayCatalog.models.length === 0 ? 'empty' : state.gatewayCatalog.status;
  const gatewayModel = (role: keyof typeof PLATFORM_MODEL_ROLES) => state.gatewayCatalog.models.find(model => matchesPlatformModelRole(model.id, role));
  const option = (model: (typeof state.models)[number]): PodModel => ({ ref: model.ref, label: `${model.displayName ?? model.id} · ${model.owner}`, capabilities: model.capabilities, source: 'own' });
  const assignment = (id: AiConfigModelAssignment, label: string, group: string, defaultLabel: string): PodModelRow => {
    const models = podModelsForAssignment(state.models, id);
    const selected = models.find(model => model.ref === config?.models[id]);
    return { id, label, group, defaultLabel, value: config?.models[id], models: models.map(option), supported: true, status: config?.models[id] && !selected ? 'unavailable' : undefined, testable: Boolean(selected && podCapabilityNames(selected.capabilities).some(value => ['chat', 'embedding'].includes(value))) };
  };
  const smartDefault = gatewayModel('smart');
  const fastDefault = gatewayModel('fast');
  const smart = assignment('chatModel', '智能', '对话', smartDefault?.displayName ?? 'Xpod 提供');
  if (!smart.value) {
    smart.status = gatewayStatus;
    smart.testable = state.gatewayCatalog.status === 'available' && Boolean(smartDefault);
    smart.testValue = smartDefault?.id;
  }
  const modelRows: PodModelRow[] = [
    smart,
    { id: 'fast', label: '快速', group: '对话', defaultLabel: fastDefault?.displayName ?? 'Xpod 提供', supported: true, status: gatewayStatus, testable: state.gatewayCatalog.status === 'available' && Boolean(fastDefault), testValue: fastDefault?.id },
    assignment('ocrModel', '视觉辅助', '对话', '不使用'),
    assignment('readerModel', '文档理解', '文档理解', 'PaddleOCR · 百度（Xpod 提供）'),
    { id: 'embeddingModel', label: '语义检索', group: '向量', defaultLabel: '' },
    ...['语音合成', '语音识别'].map(label => ({ id: label, label, group: '语音', defaultLabel: '不使用' })),
    ...['图像生成', '视频生成'].map(label => ({ id: label, label, group: '图像与视频', defaultLabel: '不使用' })),
    { id: 'decision', label: '决策', group: '决策', defaultLabel: '不使用' },
  ];
  const embedding = state.models.find(model => model.ref === config?.models.embeddingModel);
  const target = rebuildTargetForCapabilities(state.capabilities);
  const toggle: PodBodyProps['onToggle'] = async (id, checked) => {
    if (id === 'ftsEnabled' || id === 'vectorEnabled' || id === 'progressiveIndexingEnabled') await state.save({ searchIndexing: { [id]: checked } });
    else if (id === 'automaticIndexing' || id === 'refreshAfterSourceUpdate' || id === 'removeAfterSourceDeletion') await state.save({ lifecycle: { [id]: checked } });
  };
  const currentStorage = storage?.webId === runtime.webId && storage?.podUrl === runtime.currentPod?.podUrl ? storage?.value : undefined;
  const usage = currentStorage?.status === 'available' ? currentStorage.usage : undefined;
  return <PodBody section={section} onSection={onSection} accountUrl={accountUrl} busy={state.saving || state.rebuilding} error={state.error}
    models={modelRows} embeddingLabel={embedding ? option(embedding).label : config?.models.embeddingModel ? '当前模型暂不可用' : 'Xpod 提供'} embeddingValue={config?.models.embeddingModel}
    embeddingModels={eligiblePodEmbeddingModels(state.models, state.capabilities?.embeddingModels).map(option)} canChangeEmbedding={Boolean(target) && !rebuildInFlight(state.lifecycle, state.rebuilding)}
    search={[
      { id: 'ftsEnabled', label: '全文检索', checked: config?.searchIndexing.ftsEnabled ?? false },
      { id: 'vectorEnabled', label: '语义检索', checked: config?.searchIndexing.vectorEnabled ?? false, description: '资料片段会发给向量模型的服务商。' },
      { id: 'progressiveIndexingEnabled', label: '渐进式索引', checked: config?.searchIndexing.progressiveIndexingEnabled ?? false },
    ]}
    maintenance={[
      { id: 'automaticIndexing', label: '自动索引新资料', checked: config?.lifecycle.automaticIndexing ?? false },
      { id: 'refreshAfterSourceUpdate', label: '资料更新后刷新索引', checked: config?.lifecycle.refreshAfterSourceUpdate ?? false },
      { id: 'removeAfterSourceDeletion', label: '资料删除后清理索引', checked: config?.lifecycle.removeAfterSourceDeletion ?? false },
    ]}
    pending={state.lifecycle?.pending} version={state.lifecycle?.configurationVersion} jobs={(state.lifecycle?.recent ?? []).map(job => ({ id: job.id, label: { all: '全部索引', fts: '全文索引', vector: '语义索引' }[job.target], status: job.status, progress: job.progress }))}
    rebuildTargets={state.capabilities?.rebuildTargets ?? []} onRebuild={state.rebuild}
    backgroundAccess={{ granted: Boolean(access.credential), loading: access.loading, busy: access.working, error: access.error }} onGrant={access.grant} onRevoke={access.revoke}
    usage={[
      { label: '存储', value: usage ? `${(usage.storageBytes / 1024 / 1024).toFixed(1)} MiB` : '—' },
      { label: '流量', value: usage ? `${((usage.ingressBytes + usage.egressBytes) / 1024 / 1024).toFixed(1)} MiB` : '—' },
      { label: 'AI 用量', value: usage ? `${usage.tokensUsed.toLocaleString()} tokens` : '—' },
      { label: '计算时长', value: usage ? `${usage.computeSeconds.toLocaleString()} 秒` : '—' },
    ]}
    onModel={async (id, value) => { if (id === 'chatModel' || id === 'ocrModel' || id === 'readerModel') await state.save({ models: { [id]: value || null } }); }}
    onTest={async (_id, ref) => { const model = state.models.find(item => item.ref === ref); const gateway = state.gatewayCatalog.models.find(item => item.id === ref); if (!model && !gateway) throw new Error('Model unavailable'); await testAiConfigModel(runtime.fetch, model ? { ...model, capabilities: podCapabilityNames(model.capabilities) } : { id: gateway!.id, capabilities: ['chat'] }); }}
    onToggle={toggle} onEmbedding={async value => { if (!target || rebuildInFlight(state.lifecycle, state.rebuilding)) throw new Error('Rebuild unavailable'); if (value === config?.models.embeddingModel) await state.rebuild(target); else await state.saveAndRebuild({ models: { embeddingModel: value } }, target); }}
  />;
}
