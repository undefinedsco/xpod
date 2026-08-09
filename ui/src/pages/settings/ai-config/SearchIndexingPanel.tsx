import { useEffect, useState, type FormEvent } from 'react';
import { AiConfigForm } from './ModelAssignmentsPanel';
import { useAiConfig } from './AiConfigContext';
import { isPolicyValueDirty } from './form-state';

export function SearchIndexingPanel() {
  const { config, capabilities, save, rebuild, saveAndRebuild, saving, rebuilding } = useAiConfig();
  const [value, setValue] = useState(config?.searchIndexing);
  useEffect(() => setValue(config?.searchIndexing), [config]);
  if (!value) return null;
  const submit = async (event: FormEvent) => { event.preventDefault(); await save({ searchIndexing: value }); };
  const rebuildTarget = value.ftsEnabled && value.vectorEnabled ? 'all' : value.vectorEnabled ? 'vector' : 'fts';
  const canRebuild = capabilities?.rebuildTargets?.includes(rebuildTarget) === true;
  const dirty = isPolicyValueDirty(value, config?.searchIndexing);
  return (
    <AiConfigForm title="Search & Indexing" description="Choose which derived search indexes Xpod maintains for this Pod." onSubmit={submit} onRestore={() => save({ searchIndexing: { ftsEnabled: true, vectorEnabled: true, progressiveIndexingEnabled: true, textBackend: 'auto', vectorBackend: 'auto' } })} saving={saving || rebuilding} dirty={dirty} footerActions={<button type="button" disabled={!canRebuild || saving || rebuilding} onClick={() => dirty ? saveAndRebuild({ searchIndexing: value }, rebuildTarget) : rebuild(rebuildTarget)} className="h-9 rounded-md border border-input px-3 text-sm font-medium disabled:opacity-50">{rebuilding ? 'Scheduling…' : dirty && canRebuild ? 'Save and schedule rebuild' : canRebuild ? 'Schedule rebuild' : 'Rebuild unavailable on this runtime'}</button>}>
      <div className="grid gap-4 md:grid-cols-2">
        <IndexCard title="Full-text Search" enabled={value.ftsEnabled} onEnabled={(ftsEnabled) => setValue({ ...value, ftsEnabled })} backend={value.textBackend} onBackend={(textBackend) => setValue({ ...value, textBackend: textBackend as typeof value.textBackend })} backends={[['auto', 'Auto'], ...(capabilities?.textBackends ?? []).map((item) => [item, item === 'fts5' ? 'FTS5' : 'PostgreSQL FTS'] as const)]} />
        <IndexCard title="Vector Search" enabled={value.vectorEnabled} onEnabled={(vectorEnabled) => setValue({ ...value, vectorEnabled })} backend={value.vectorBackend} onBackend={(vectorBackend) => setValue({ ...value, vectorBackend: vectorBackend as typeof value.vectorBackend })} backends={[['auto', 'Auto'], ...(capabilities?.vectorBackends ?? []).map((item) => [item, item === 'vec' ? 'VEC' : 'pgvector'] as const)]} />
      </div>
      <label className="flex items-start justify-between gap-4 rounded-xl border border-border p-4">
        <span>
          <span className="block text-sm font-medium">Progressive indexing</span>
          <span className="block text-xs text-muted-foreground">Expand coverage as content becomes relevant instead of embedding everything eagerly.</span>
        </span>
        <input name="progressiveIndexingEnabled" type="checkbox" checked={value.progressiveIndexingEnabled} onChange={(event) => setValue({ ...value, progressiveIndexingEnabled: event.target.checked })} className="mt-1 h-4 w-4 rounded border-input" />
      </label>
    </AiConfigForm>
  );
}

function IndexCard({ title, enabled, onEnabled, backend, onBackend, backends }: { title: string; enabled: boolean; onEnabled(value: boolean): void; backend: string; onBackend(value: string): void; backends: ReadonlyArray<readonly [string, string]> }) {
  const manualBackends = backends.filter(([id]) => id !== 'auto');
  const manual = isManualBackendSelection(backend);
  return (
    <section className="rounded-xl border border-border p-4">
      <label className="flex items-center justify-between gap-3 text-sm font-medium">
        {title}
        <input type="checkbox" checked={enabled} onChange={(event) => onEnabled(event.target.checked)} className="h-4 w-4 rounded border-input" />
      </label>
      <label className="mt-4 flex items-center justify-between gap-3 text-xs font-medium text-muted-foreground">
        Choose backend manually
        <input type="checkbox" checked={manual} disabled={manualBackends.length === 0} onChange={(event) => onBackend(event.target.checked ? manualBackends[0]?.[0] ?? 'auto' : 'auto')} className="h-4 w-4 rounded border-input" />
      </label>
      {manual ? <label className="mt-3 block space-y-2 text-xs font-medium text-muted-foreground">Backend
        <select value={backend} onChange={(event) => onBackend(event.target.value)} className="block h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground">
          {manualBackends.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </label> : <p className="mt-3 text-xs text-muted-foreground">Auto selects the runtime-supported backend.</p>}
    </section>
  );
}

export function isManualBackendSelection(backend: string): boolean { return backend !== 'auto'; }
