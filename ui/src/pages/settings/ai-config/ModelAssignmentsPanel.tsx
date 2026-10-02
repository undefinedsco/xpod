import { embeddingModelSwitch, rebuildInFlight, rebuildStatusFrom, rebuildTargetForCapabilities, type EmbeddingModelSwitch, type RebuildStatus } from './model-assignment-state';
import { useEffect, useState, type FormEvent } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@undefineds.co/shared-ui';
import type {
  AiConfigLifecycleSnapshot,
  AiConfigModelAssignment,
} from '../../../api/ai-config';
import { modelsForAssignment, useAiConfig, type AiConfigModelOption } from './AiConfigContext';
import { BackgroundPodAccess } from './BackgroundPodAccess';
import { isPolicyValueDirty } from './form-state';
import { testAiConfigModel } from '../../../api/ai-config';
import { useXpodSolidRuntime } from '../../../solid/useXpodSolidRuntime';

/**
 * §7.4：条目以**真实用途**为主语，专业角色名作为副文本保留在详情里。
 * schema 里有某个角色不代表它要单独占一行，所以技术名不再充当唯一标识。
 */
const assignments = [
  { label: '对话与通用文本', role: 'General / Chat', name: 'chatModel', description: '用于助手对话与一般文本任务。' },
  { label: '识别图片文字', role: 'OCR', name: 'ocrModel', description: '从图片与扫描页里读出文字。' },
  { label: '理解文档内容', role: 'Document Reader', name: 'readerModel', description: '提取文档的结构与内容。' },
  { label: '按意思搜索', role: 'Embedding', name: 'embeddingModel', description: '为语义搜索生成向量。' },
  { label: '准备与摘要索引', role: 'Indexer / Summarizer', name: 'indexerModel', description: '为索引准备并摘要内容。' },
  { label: '搜索结果重排', role: 'Reranker', name: 'rerankerModel', description: '按相关性重排搜索结果。' },
] as const;

export function ModelAssignmentsPanel() {
  const { config, capabilities, lifecycle, models, save, saveAndRebuild, saving, rebuilding } = useAiConfig();
  const runtime = useXpodSolidRuntime();
  const [values, setValues] = useState<Partial<Record<AiConfigModelAssignment, string>>>({});
  const [testing, setTesting] = useState<AiConfigModelAssignment>();
  const [testResults, setTestResults] = useState<Partial<Record<AiConfigModelAssignment, 'ready' | 'failed'>>>({});
  const [pendingChange, setPendingChange] = useState<{
    models: Record<string, string | null>
    switch: EmbeddingModelSwitch
  }>();
  const [rebuildNotice, setRebuildNotice] = useState<string>();
  // §7.4：概要只放用途/当前模型/可用性三列，编辑时才展开兼容选项、恢复默认与测试
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setValues(config?.models ?? {});
    });
    return () => { cancelled = true; };
  }, [config]);
  const dirty = isPolicyValueDirty(values, config?.models ?? {});
  const switchToRebuild = embeddingModelSwitch(values, config);
  const rebuildLocked = rebuildInFlight(lifecycle, rebuilding);
  const assignedModels = () => Object.fromEntries(
    assignments.map(({ name }) => [name, values[name] || null]),
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // 换向量模型等于换掉整套向量：先提示会重建，等二次确认后再保存并排队。
    if (switchToRebuild) {
      if (rebuildLocked) return;
      setPendingChange({ models: assignedModels(), switch: switchToRebuild });
      return;
    }
    await save({ models: assignedModels() });
  };

  /**
   * Restoring the defaults clears the embedding assignment too, so it is the same
   * switch by another name and takes the same confirmation.
   */
  const restoreDefaults = async () => {
    const restored = Object.fromEntries(assignments.map(({ name }) => [name, null]));
    const switchToConfirm = embeddingModelSwitch(restored, config);
    if (!switchToConfirm) {
      await save({ models: restored });
      return;
    }
    if (rebuildLocked) return;
    setPendingChange({ models: restored, switch: switchToConfirm });
  };

  const confirmSwitch = async () => {
    const change = pendingChange;
    setPendingChange(undefined);
    if (!change) return;
    const target = rebuildTargetForCapabilities(capabilities);
    if (!target) {
      await save({ models: change.models });
      setRebuildNotice('模型已保存；此运行时不支持重建索引，请稍后手动重建。');
      return;
    }
    await saveAndRebuild({ models: change.models }, target);
    setRebuildNotice(undefined);
  };

  const modelLabel = (name: AiConfigModelAssignment): string => {
    const assigned = values[name]
    if (!assigned) return '系统默认'
    return models.find((model) => model.id === assigned)?.displayName
      ?? models.find((model) => model.id === assigned)?.ref
      ?? assigned
  }
  const availability = (name: AiConfigModelAssignment): string => {
    const result = testResults[name]
    if (result === 'ready') return '已验证可用'
    if (result === 'failed') return '验证失败'
    return '未验证'
  }

  const summary = (
    <section data-testid="ai-purpose-summary" className="overflow-hidden rounded-xl border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <div className="text-sm font-medium">用途与模型</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            概要只列用途、当前模型与可用性；点「编辑」才展开兼容选项、恢复默认与有边界的测试。
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
          编辑
        </Button>
      </div>
      <div className="divide-y divide-border">
        <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,0.8fr)] gap-2 px-4 py-2 text-xs text-muted-foreground">
          <span>用途</span><span>当前模型</span><span>可用性</span>
        </div>
        {assignments.map((assignment) => (
          <div
            key={assignment.name}
            data-testid="ai-purpose-row"
            data-purpose={assignment.name}
            className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,0.8fr)] gap-2 px-4 py-2 text-sm"
          >
            <span className="min-w-0">
              <span className="block truncate">{assignment.label}</span>
              <span data-testid="model-assignment-role" className="mt-0.5 block font-mono text-[11px] text-muted-foreground">{assignment.role}</span>
            </span>
            <span className="min-w-0">
              <span className="block break-all">{modelLabel(assignment.name)}</span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                {values[assignment.name] ? '显式指定' : '系统默认'}
              </span>
            </span>
            <span className="text-muted-foreground">{availability(assignment.name)}</span>
          </div>
        ))}
      </div>
    </section>
  )

  if (!editing) {
    return (
      <>
        {summary}
        <RebuildStatusLine lifecycle={lifecycle} fallbackNotice={rebuildNotice} />
        <BackgroundPodAccess />
      </>
    )
  }

  return (
    <>
      <AiConfigForm title="用途与模型" description="按真实用途选择模型；未指定的用途使用系统默认。每行的专业角色名只作说明，不改变运行语义。" onSubmit={submit} onRestore={() => void restoreDefaults()} saving={saving || rebuilding} dirty={dirty}>
        <div className="divide-y divide-border rounded-xl border border-border">
          {assignments.map((assignment) => (
            <ModelAssignmentRow
              key={assignment.name}
              {...assignment}
              models={models}
              value={values[assignment.name]}
              testing={testing === assignment.name}
              testResult={testResults[assignment.name]}
              disabled={assignment.name === 'embeddingModel' && rebuildLocked}
              notice={assignment.name !== 'embeddingModel'
                ? undefined
                : rebuildLocked
                  ? '索引重建进行中，完成后才能再次切换向量模型。'
                  : switchToRebuild
                    ? '切换向量模型会重建索引：保存前需要二次确认，确认后立即排队重建。'
                    : undefined}
              onChange={(value) => setValues((current) => ({ ...current, [assignment.name]: value }))}
              onTest={async (selected) => {
                setTesting(assignment.name);
                try {
                  await testAiConfigModel(runtime.fetch, selected);
                  setTestResults((current) => ({ ...current, [assignment.name]: 'ready' }));
                } catch {
                  setTestResults((current) => ({ ...current, [assignment.name]: 'failed' }));
                } finally {
                  setTesting(undefined);
                }
              }}
            />
          ))}
        </div>
        <RebuildStatusLine lifecycle={lifecycle} fallbackNotice={rebuildNotice} />
      </AiConfigForm>
      {/* The embedding model is what turns on vector maintenance, so its grant belongs here too. */}
      <BackgroundPodAccess />
      <EmbeddingSwitchDialog
        request={pendingChange?.switch}
        models={models}
        saving={saving || rebuilding || rebuildLocked}
        onCancel={() => setPendingChange(undefined)}
        onConfirm={() => void confirmSwitch()}
      />
    </>
  );
}

const REBUILD_STATUS_TEXT: Record<RebuildStatus['phase'], string> = {
  queued: '索引重建已排队',
  running: '索引重建进行中',
  succeeded: '索引重建完成',
  failed: '索引重建失败',
}

export function RebuildStatusLine({
  lifecycle,
  fallbackNotice,
}: {
  lifecycle?: AiConfigLifecycleSnapshot
  fallbackNotice?: string
}) {
  const status = rebuildStatusFrom(lifecycle)
  if (!status) {
    return fallbackNotice
      ? <p role="status" className="text-xs text-warning">{fallbackNotice}</p>
      : null
  }
  const detail = [
    status.progress !== undefined ? `${status.progress}%` : undefined,
    status.pending > 0 ? `队列 ${status.pending}` : undefined,
    status.error,
  ].filter(Boolean).join(' · ')
  return (
    <p
      role="status"
      className={`text-xs ${status.phase === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}
    >
      {REBUILD_STATUS_TEXT[status.phase]}{detail ? ` · ${detail}` : ''}
    </p>
  )
}

function EmbeddingSwitchDialog({
  request,
  models,
  saving,
  onCancel,
  onConfirm,
}: {
  request?: EmbeddingModelSwitch
  models: AiConfigModelOption[]
  saving: boolean
  onCancel(): void
  onConfirm(): void
}) {
  const label = (ref?: string) => {
    if (!ref) return '系统默认'
    const model = models.find((candidate) => candidate.ref === ref)
    return model ? `${model.displayName ?? model.id} · ${model.owner}` : ref
  }
  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent data-testid="embedding-switch-dialog">
        <DialogHeader>
          <DialogTitle>切换向量模型并重建索引？</DialogTitle>
          <DialogDescription>
            已建立的向量由原模型生成，切换后需要用新模型重建索引才能参与检索。重建期间检索只会返回文本命中。
          </DialogDescription>
        </DialogHeader>
        {request && (
          <dl className="grid gap-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">当前</dt>
              <dd className="min-w-0 break-all text-right">{label(request.from)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">切换为</dt>
              <dd className="min-w-0 break-all text-right">{label(request.to)}</dd>
            </div>
          </dl>
        )}
        <DialogFooter>
          <button
            type="button"
            onClick={onCancel}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent"
          >
            取消
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={onConfirm}
            className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {saving ? '提交中…' : '确认切换并重建'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ModelAssignmentRow({
  label,
  role,
  name,
  description,
  models,
  value,
  testing,
  testResult,
  notice,
  disabled = false,
  onChange,
  onTest,
}: {
  label: string;
  /** 专业角色名（§7.4：放在详情里，不作唯一标识）。 */
  role?: string;
  name: AiConfigModelAssignment;
  description: string;
  models: AiConfigModelOption[];
  value?: string;
  testing: boolean;
  testResult?: 'ready' | 'failed';
  /** Consequence of the pending change, shown before anything is saved. */
  notice?: string;
  /** Set while a change must not be made at all, such as during a rebuild. */
  disabled?: boolean;
  onChange(value: string): void;
  onTest(model: AiConfigModelOption): void | Promise<void>;
}) {
  const selected = models.find((model) => model.ref === value);
  const availableModels = modelsForAssignment(models, name);
  const testable = selected?.capabilities.some((capability) => ['chat', 'embedding'].includes(capability.toLowerCase())) === true;
  const selectionStatus = selected
    ? `Connected · credential ready · ${selected.owner}`
    : value
      ? 'Selected model is no longer credential-ready'
      : undefined;
  const probeStatus = testResult === 'ready'
    ? 'Probe succeeded'
    : testResult === 'failed'
      ? 'Probe failed; review AI Connection health'
      : undefined;
  const status = [selectionStatus, probeStatus].filter(Boolean).join(' · ');
  const statusIsError = Boolean(value && !selected) || testResult === 'failed';

  return (
    <div
      data-testid="model-assignment-row"
      className="grid gap-3 p-4 lg:grid-cols-[minmax(220px,1fr)_minmax(320px,440px)] lg:items-start"
    >
      <div className="min-w-0 pt-1">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {role ? (
          <span data-testid="model-assignment-role" className="mt-0.5 block font-mono text-xs text-muted-foreground">
            {role}
          </span>
        ) : null}
        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{description}</span>
      </div>
      <div data-testid="model-assignment-controls" className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_4.5rem] sm:items-start">
        <label className="min-w-0">
          <span className="sr-only">{label} model</span>
          <select
            name={name}
            value={value ?? ''}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground disabled:opacity-50"
          >
            <option value="">System default</option>
            {availableModels.map((model) => (
              <option key={`${model.owner}:${model.id}`} value={model.ref}>
                {model.displayName ?? model.id} · {model.owner}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          aria-label={`Test ${label} model`}
          disabled={disabled || !testable || testing}
          title={!selected ? 'Select a connected model first' : !testable ? 'This model has no bounded probe endpoint' : 'Send a bounded readiness probe'}
          onClick={() => selected && void onTest(selected)}
          className="h-10 w-full self-start rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50"
        >
          {testing ? 'Testing…' : 'Test'}
        </button>
        {status && (
          <span
            role="status"
            className={`text-xs sm:col-span-2 ${statusIsError ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {status}
          </span>
        )}
        {notice && (
          <span data-testid="model-assignment-notice" className="text-xs text-warning sm:col-span-2">
            {notice}
          </span>
        )}
      </div>
    </div>
  );
}

export function AiConfigForm({
  title,
  description,
  children,
  onSubmit,
  onRestore,
  footerActions,
  saving = false,
  dirty = true,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  onRestore?: () => void;
  footerActions?: React.ReactNode;
  saving?: boolean;
  dirty?: boolean;
}) {
  return (
    <form onSubmit={onSubmit} className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{description}</p>
      </header>
      {children}
      <div className="flex justify-end gap-2 border-t border-border pt-4">
        <span role="status" className="mr-auto self-center text-xs text-muted-foreground">{dirty ? 'Unsaved changes' : 'Applied'}</span>
        {footerActions}
        <button type="button" onClick={onRestore} disabled={saving || !onRestore} className="h-9 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent disabled:opacity-50">Restore defaults</button>
        <button type="submit" disabled={saving || !onSubmit || !dirty} className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50">{saving ? 'Saving…' : 'Save configuration'}</button>
      </div>
    </form>
  );
}
