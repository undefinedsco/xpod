import { useEffect, useState, type FormEvent } from 'react';
import type { AiConfigModelAssignment } from '../../../api/ai-config';
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
  const { config, models, save, saving } = useAiConfig();
  const runtime = useXpodSolidRuntime();
  const [values, setValues] = useState<Partial<Record<AiConfigModelAssignment, string>>>({});
  const [testing, setTesting] = useState<AiConfigModelAssignment>();
  const [testResults, setTestResults] = useState<Partial<Record<AiConfigModelAssignment, 'ready' | 'failed'>>>({});
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setValues(config?.models ?? {});
    });
    return () => { cancelled = true; };
  }, [config]);
  const dirty = isPolicyValueDirty(values, config?.models ?? {});

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await save({ models: Object.fromEntries(assignments.map(({ name }) => [name, values[name] || null])) });
  };
  return (
    <AiConfigForm title="Model Assignments" description="Choose a connected model for each Xpod capability. Unassigned capabilities use the system default." onSubmit={submit} onRestore={() => save({ models: Object.fromEntries(assignments.map(({ name }) => [name, null])) })} saving={saving} dirty={dirty}>
      <div className="divide-y divide-border rounded-xl border border-border">
        {assignments.map((assignment) => (
          <ModelAssignmentRow
            key={assignment.name}
            {...assignment}
            models={models}
            value={values[assignment.name]}
            testing={testing === assignment.name}
            testResult={testResults[assignment.name]}
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
    </AiConfigForm>
  );
}

export function ModelAssignmentRow({
  label,
  name,
  description,
  models,
  value,
  testing,
  testResult,
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
            onChange={(event) => onChange(event.target.value)}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
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
          disabled={!testable || testing}
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
