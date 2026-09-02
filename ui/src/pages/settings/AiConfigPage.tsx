import { TwoPaneLayout, useWorkspaceLayout } from '@undefineds.co/extension-sdk/react';
import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { aiConfigNavigationItems } from '../../layout/ai-config-navigation';
import { getListNavItemClass } from '../../layout/nav-item-style';
import { PaneListHeader } from './PaneListHeader';
import { AiConfigProvider, useAiConfig } from './ai-config/AiConfigContext';
import { handleListNavigationKeyDown } from '../../layout/list-keyboard-navigation';

export default function AiConfigPage() {
  return <AiConfigProvider><AiConfigWorkspace /></AiConfigProvider>;
}

function AiConfigWorkspace() {
  const location = useLocation();
  const { config, loading, saving, error, reload } = useAiConfig();
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);
  const selected = aiConfigNavigationItems.find((item) => location.pathname.endsWith(item.path))
    ?? aiConfigNavigationItems[0];

  return (
    <TwoPaneLayout
      mode="auto"
      listHeader={<PaneListHeader title="AI Config" />}
      list={<AiConfigList />}
      mainHeader={(
        <div className="flex h-full min-w-0 items-center px-4">
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-foreground">AI Config · {selected.label}</h1>
            <div className="truncate text-xs text-muted-foreground">Pod-level AI and derived-index policy</div>
          </div>
        </div>
      )}
      main={<section className="min-h-full bg-background">
        {saving && (
          <div role="status" aria-live="polite" className="border-b border-border px-6 py-2 text-xs text-muted-foreground">
            Saving AI configuration…
          </div>
        )}
        {error ? (
          <AiConfigLoadError
            error={error}
            showTechnicalDetails={showTechnicalDetails}
            onToggleTechnicalDetails={() => setShowTechnicalDetails((current) => !current)}
            onRetry={() => {
              setShowTechnicalDetails(false);
              reload();
            }}
          />
        ) : loading || !config ? (
          <AiConfigLoading />
        ) : (
          <Outlet />
        )}
      </section>}
      className="min-h-full"
    />
  );
}

function AiConfigLoadError({
  error,
  showTechnicalDetails,
  onToggleTechnicalDetails,
  onRetry,
}: {
  error: string;
  showTechnicalDetails: boolean;
  onToggleTechnicalDetails(): void;
  onRetry(): void;
}) {
  return (
    <div className="mx-auto w-full max-w-4xl p-6">
      <div role="alert" aria-live="assertive" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
        <h2 className="text-sm font-semibold text-foreground">AI configuration could not be loaded</h2>
        <p className="mt-1 text-sm text-muted-foreground">Xpod could not read this Pod’s AI settings. Your existing settings were not changed.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={onRetry} className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            Try again
          </button>
          <button type="button" aria-expanded={showTechnicalDetails} onClick={onToggleTechnicalDetails} className="h-9 rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground hover:bg-accent">
            {showTechnicalDetails ? 'Hide details' : 'Show details'}
          </button>
        </div>
        {showTechnicalDetails && <p className="mt-3 break-words font-mono text-xs text-muted-foreground">{error}</p>}
      </div>
    </div>
  );
}

function AiConfigLoading() {
  return (
    <div role="status" aria-live="polite" className="mx-auto w-full max-w-4xl p-6">
      <div className="h-7 w-52 animate-pulse rounded bg-muted" />
      <div className="mt-3 h-4 w-80 max-w-full animate-pulse rounded bg-muted" />
      <div className="mt-6 divide-y divide-border overflow-hidden rounded-xl border border-border">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="grid gap-4 p-4 lg:grid-cols-[minmax(220px,1fr)_minmax(320px,440px)]">
            <div className="space-y-2"><div className="h-4 w-28 animate-pulse rounded bg-muted" /><div className="h-3 w-52 animate-pulse rounded bg-muted" /></div>
            <div className="h-10 animate-pulse rounded-md bg-muted" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading AI configuration…</span>
    </div>
  );
}

function AiConfigList() {
  const workspace = useWorkspaceLayout();
  return (
    <aside className="h-full border-r border-border bg-muted/20 py-2">
      <nav aria-label="AI Config sections" data-list-navigation>
        {aiConfigNavigationItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.id}
              to={item.path}
              end={item.end}
              onClick={() => workspace.openMain()}
              onKeyDown={handleListNavigationKeyDown}
              className={({ isActive }) => getListNavItemClass(isActive, { compact: false })}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{item.label}</span>
                <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{item.description}</span>
              </span>
            </NavLink>
          );
        })}
      </nav>
    </aside>
  );
}
