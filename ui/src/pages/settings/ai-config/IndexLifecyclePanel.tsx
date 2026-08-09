import { useEffect, useState, type FormEvent } from 'react';
import { AiConfigForm } from './ModelAssignmentsPanel';
import { useAiConfig } from './AiConfigContext';
import { isPolicyValueDirty } from './form-state';

export function IndexLifecyclePanel() {
  const { config, capabilities, lifecycle, save, rebuild, saving, rebuilding } = useAiConfig();
  const [value, setValue] = useState(config?.lifecycle);
  useEffect(() => setValue(config?.lifecycle), [config]);
  if (!value) return null;
  const dirty = isPolicyValueDirty(value, config?.lifecycle);
  const submit = async (event: FormEvent) => { event.preventDefault(); await save({ lifecycle: value }); };
  return (
    <AiConfigForm title="Index Lifecycle" description="Control automatic maintenance and explicitly schedule rebuilds of derived data." onSubmit={submit} onRestore={() => save({ lifecycle: { automaticIndexing: true, refreshAfterSourceUpdate: true, removeAfterSourceDeletion: true } })} saving={saving} dirty={dirty}>
      <div className="divide-y divide-border rounded-xl border border-border">
      <label className="flex items-start justify-between gap-4 p-4">
        <span>
          <span className="block text-sm font-medium">Automatically index changes</span>
          <span className="block text-xs text-muted-foreground">Index new and updated resources, and remove derived entries after deletion.</span>
        </span>
        <input name="automaticIndexing" type="checkbox" checked={value.automaticIndexing} onChange={(event) => setValue({ ...value, automaticIndexing: event.target.checked })} className="mt-1 h-4 w-4 rounded border-input" />
      </label>
      <LifecycleToggle label="Refresh after source updates" checked={value.refreshAfterSourceUpdate} onChange={(refreshAfterSourceUpdate) => setValue({ ...value, refreshAfterSourceUpdate })} />
      <LifecycleToggle label="Remove derived entries after source deletion" checked={value.removeAfterSourceDeletion} onChange={(removeAfterSourceDeletion) => setValue({ ...value, removeAfterSourceDeletion })} />
      </div>
      <section className="rounded-xl border border-border p-4">
        <h2 className="text-sm font-medium">Rebuild derived indexes</h2>
        <p className="mt-1 text-xs text-muted-foreground">Rebuild actions never modify authority data in the Pod.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {(['fts', 'vector', 'all'] as const).map((target) => <button key={target} type="button" disabled={!capabilities?.rebuildTargets?.includes(target) || rebuilding} onClick={() => rebuild(target)} className="h-9 rounded-md border border-input px-3 text-sm font-medium disabled:opacity-50">Rebuild {target === 'all' ? 'all' : target.toUpperCase()}</button>)}
        </div>
      </section>
      <section className="rounded-xl border border-border p-4">
        <h2 className="text-sm font-medium">Lifecycle evidence</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2"><Evidence label="Configuration version" value={lifecycle?.configurationVersion ?? config?.updatedAt ?? 'Default'} /><Evidence label="Pending queue" value={String(lifecycle?.pending ?? 0)} /></div>
        <div className="mt-4 space-y-2">{lifecycle?.recent.length ? lifecycle.recent.map((job) => <div key={job.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm"><span>{job.target.toUpperCase()} · {job.status}</span><span className="text-xs text-muted-foreground">{job.progress ?? 0}% · {new Date(job.createdAt).toLocaleString()}</span>{job.error ? <span className="w-full text-xs text-destructive">{job.error}</span> : null}</div>) : <p className="text-sm text-muted-foreground">No rebuild jobs have been scheduled.</p>}</div>
      </section>
    </AiConfigForm>
  );
}

function LifecycleToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }) { return <label className="flex items-start justify-between gap-4 p-4"><span className="text-sm font-medium">{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-1 h-4 w-4 rounded border-input" /></label>; }
function Evidence({ label, value }: { label: string; value: string }) { return <div className="rounded-md border border-border p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 text-sm font-medium">{value}</div></div>; }
