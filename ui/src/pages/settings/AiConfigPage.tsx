import { TwoPaneLayout, useWorkspaceLayout } from '@undefineds.co/extension-sdk/react';
import { clsx } from 'clsx';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { aiConfigNavigationItems } from '../../layout/ai-config-navigation';
import { PaneListHeader } from './PaneListHeader';
import { AiConfigProvider, useAiConfig } from './ai-config/AiConfigContext';
import { handleListNavigationKeyDown } from '../../layout/list-keyboard-navigation';

export default function AiConfigPage() {
  return <AiConfigProvider><AiConfigWorkspace /></AiConfigProvider>;
}

function AiConfigWorkspace() {
  const location = useLocation();
  const { loading, saving, error } = useAiConfig();
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
        {(loading || saving || error) && (
          <div role={error ? 'alert' : 'status'} aria-live={error ? 'assertive' : 'polite'} className={clsx('border-b px-6 py-2 text-xs', error ? 'border-destructive/30 text-destructive' : 'border-border text-muted-foreground')}>
            {error ?? (saving ? 'Saving AI configuration…' : 'Loading AI configuration…')}
          </div>
        )}
        <Outlet />
      </section>}
      className="min-h-full"
    />
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
              className={({ isActive }) => clsx(
                'mx-2 flex gap-3 rounded-lg px-3 py-3 transition-colors',
                isActive ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/60',
              )}
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
