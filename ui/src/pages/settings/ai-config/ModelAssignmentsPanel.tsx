import { useEffect, useState, type FormEvent } from 'react';
import type { AiConfigModelAssignment } from '../../../api/ai-config';
import { modelsForAssignment, useAiConfig } from './AiConfigContext';
import { isPolicyValueDirty } from './form-state';
import { testAiConfigModel } from '../../../api/ai-config';
import { useXpodSolidRuntime } from '../../../solid/useXpodSolidRuntime';

const assignments = [
  ['General / Chat', 'chatModel'],
  ['OCR', 'ocrModel'],
  ['Document Reader', 'readerModel'],
  ['Embedding', 'embeddingModel'],
  ['Indexer / Summarizer', 'indexerModel'],
  ['Reranker', 'rerankerModel'],
] as const;

export function ModelAssignmentsPanel() {
  const { config, models, save, saving } = useAiConfig();
  const runtime = useXpodSolidRuntime();
  const [values, setValues] = useState<Partial<Record<AiConfigModelAssignment, string>>>({});
  const [testing, setTesting] = useState<string>();
  const [testResults, setTestResults] = useState<Record<string, 'ready' | 'failed'>>({});
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
    await save({ models: Object.fromEntries(assignments.map(([, key]) => [key, values[key] || null])) });
  };
  return (
    <AiConfigForm title="Model Assignments" description="Choose a connected model for each Xpod capability." onSubmit={submit} onRestore={() => save({ models: Object.fromEntries(assignments.map(([, key]) => [key, null])) })} saving={saving} dirty={dirty}>
      <div className="divide-y divide-border rounded-xl border border-border">
        {assignments.map(([label, name]) => {
          const selected = models.find((model) => model.ref === values[name]);
          const testable = selected?.capabilities.some((capability) => ['chat', 'embedding'].includes(capability.toLowerCase())) === true;
          return (
          <div key={name} className="grid gap-2 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(240px,1fr)_auto] sm:items-center">
            <span>
              <span className="block text-sm font-medium text-foreground">{label}</span>
              <span className="block text-xs text-muted-foreground">System default until a Pod override is saved.</span>
            </span>
            <label className="grid gap-1"><span className="sr-only">{label} model</span><select name={name} value={values[name] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
              <option value="">System default</option>
              {modelsForAssignment(models, name).map((model) => <option key={`${model.owner}:${model.id}`} value={model.ref}>{model.displayName ?? model.id} · {model.owner}</option>)}
            </select><span className="text-xs text-muted-foreground">{selected ? `Connected · credential ready · ${selected.owner}` : values[name] ? 'Selected model is no longer credential-ready' : 'System default'}</span></label>
            <button type="button" disabled={!testable || testing === name} title={!selected ? 'Select a connected model first' : !testable ? 'This model has no bounded probe endpoint' : 'Send a bounded readiness probe'} onClick={async () => {
              if (!selected) return;
              setTesting(name);
              try { await testAiConfigModel(runtime.fetch, selected); setTestResults((current) => ({ ...current, [name]: 'ready' })); }
              catch { setTestResults((current) => ({ ...current, [name]: 'failed' })); }
              finally { setTesting(undefined); }
            }} className="h-9 rounded-md border border-input px-3 text-sm disabled:opacity-50">{testing === name ? 'Testing…' : 'Test'}</button>
            <span role="status" className="text-xs text-muted-foreground sm:col-start-2">{testResults[name] === 'ready' ? 'Probe succeeded' : testResults[name] === 'failed' ? 'Probe failed; review AI Connection health' : selected ? `Capabilities: ${selected.capabilities.join(', ') || 'catalogue only'}` : ''}</span>
          </div>
        );})}
      </div>
    </AiConfigForm>
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
