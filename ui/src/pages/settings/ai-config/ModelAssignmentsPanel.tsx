import { useEffect, useState, type FormEvent } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@undefineds.co/shared-ui';
import type {
  AiConfigCapabilities,
  AiConfigLifecycleSnapshot,
  AiConfigModelAssignment,
  AiConfigPolicy,
  AiConfigRebuildTarget,
} from '../../../api/ai-config';
import { modelsForAssignment, useAiConfig, type AiConfigModelOption } from './AiConfigContext';
import { isPolicyValueDirty } from './form-state';
import { testAiConfigModel } from '../../../api/ai-config';
import { useXpodSolidRuntime } from '../../../solid/useXpodSolidRuntime';

const assignments = [
  { label: 'General / Chat', name: 'chatModel', description: 'Used for assistant conversations and general text tasks.' },
  { label: 'OCR', name: 'ocrModel', description: 'Reads text from images and scanned pages.' },
  { label: 'Document Reader', name: 'readerModel', description: 'Extracts structure and content from documents.' },
  { label: 'Embedding', name: 'embeddingModel', description: 'Creates vectors for semantic search.' },
  { label: 'Indexer / Summarizer', name: 'indexerModel', description: 'Prepares and summarizes content for indexes.' },
  { label: 'Reranker', name: 'rerankerModel', description: 'Reorders search results by relevance.' },
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

  return (
    <>
      <AiConfigForm title="Model Assignments" description="Choose a connected model for each Xpod capability. Unassigned capabilities use the system default." onSubmit={submit} onRestore={() => void restoreDefaults()} saving={saving || rebuilding} dirty={dirty}>
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
                  await testAiConfigModel(runtime.fetch, selected, {
                    ...(runtime.requestPodAuthorization
                      ? { authorization: runtime.requestPodAuthorization }
                      : {}),
                  });
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

export interface EmbeddingModelSwitch {
  from?: string
  to?: string
}

/**
 * The embedding assignment a user just changed, if any.
 *
 * Only the embedding model invalidates derived vectors, so it is the one
 * assignment whose save has to warn about - and wait for - a rebuild.
 */
export function embeddingModelSwitch(
  values: Partial<Record<AiConfigModelAssignment, string | null>>,
  config?: AiConfigPolicy,
): EmbeddingModelSwitch | undefined {
  // An absent key means "this form never touched the embedding row"; an explicit
  // value - including the null that restores the default - is a switch and has
  // to be confirmed, because it changes which vectors the index holds.
  const next = values.embeddingModel
  if (next === undefined) return undefined
  const current = config?.models?.embeddingModel ?? ''
  return (next ?? '') === current ? undefined : { from: current || undefined, to: next || undefined }
}

/**
 * Whether a rebuild is queued or running right now.
 *
 * A second model switch while the index is being rebuilt would invalidate the
 * rebuild that is already in flight, so the embedding row stays locked until the
 * queue drains. `scheduling` covers the moment between the click and the first
 * lifecycle snapshot.
 */
export function rebuildInFlight(
  lifecycle?: AiConfigLifecycleSnapshot,
  scheduling = false,
): boolean {
  if (scheduling) return true
  const phase = rebuildStatusFrom(lifecycle)?.phase
  return phase === 'queued' || phase === 'running'
}

/** The rebuild target a deployment can run for a model switch. */
export function rebuildTargetForCapabilities(
  capabilities?: AiConfigCapabilities,
): AiConfigRebuildTarget | undefined {
  const targets = capabilities?.rebuildTargets ?? []
  if (targets.includes('vector')) return 'vector'
  if (targets.includes('all')) return 'all'
  return undefined
}

export interface RebuildStatus {
  phase: 'queued' | 'running' | 'succeeded' | 'failed'
  pending: number
  progress?: number
  target?: string
  error?: string
}

/**
 * What to show about the newest rebuild.
 *
 * `pending` is the queue depth the API reports, and the newest job carries the
 * outcome; a page that just scheduled one shows it queued until the queue moves.
 */
export function rebuildStatusFrom(lifecycle?: AiConfigLifecycleSnapshot): RebuildStatus | undefined {
  if (!lifecycle) return undefined
  const newest = lifecycle.recent[0]
  if (!newest) {
    return lifecycle.pending > 0 ? { phase: 'queued', pending: lifecycle.pending } : undefined
  }
  if (newest.status === 'queued' && lifecycle.pending <= 0) return undefined
  return {
    phase: newest.status,
    pending: lifecycle.pending,
    target: newest.target,
    ...(newest.progress !== undefined ? { progress: newest.progress } : {}),
    ...(newest.error ? { error: newest.error } : {}),
  }
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
      ? <p role="status" className="text-xs text-amber-600">{fallbackNotice}</p>
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
          <span data-testid="model-assignment-notice" className="text-xs text-amber-600 sm:col-span-2">
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
