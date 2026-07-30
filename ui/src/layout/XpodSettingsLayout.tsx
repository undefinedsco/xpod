import { AppLayout } from '@undefineds.co/extension-sdk/react';
import { Button, Input } from '@undefineds.co/shared-ui';
import { clsx } from 'clsx';
import { Search } from 'lucide-react';
import { useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { SettingsAuthBoundary } from '../solid/SettingsAuthBoundary';
import {
  clearSettingsSearchOnEscape,
  filterSettingsNavigationItems,
  submitSettingsSearch,
  type SettingsNavigationItem,
} from './settings-navigation';

function EmptySearchResult({ query }: { query: string }) {
  return (
    <div role="status" className="px-3 py-2 text-sm text-muted-foreground">
      No settings sections match "{query}".
    </div>
  );
}

export function SettingsNavLinks({
  compact = false,
  items,
  query,
}: {
  compact?: boolean;
  items: SettingsNavigationItem[];
  query: string;
}) {
  return (
    <nav
      aria-label={compact ? 'Settings sections' : 'Primary settings sections'}
      className={clsx(compact ? 'flex gap-1 overflow-x-auto px-3 pb-3 md:hidden' : 'space-y-1 p-3')}
    >
      {items.length === 0 ? <EmptySearchResult query={query} /> : null}
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.id}
            to={item.path}
            className={({ isActive }) => clsx(
              'flex items-center gap-2 rounded-md text-sm font-medium transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              compact ? 'h-9 shrink-0 px-3' : 'px-3 py-2',
              isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            <span>{item.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}

function SettingsHostHeader({
  query,
  onQueryChange,
  onSubmit,
  onSearchKeyDown,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="flex h-full min-w-0 flex-col justify-center gap-2 px-4 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0">
        <div className="text-sm font-semibold leading-5 text-foreground">Xpod Settings</div>
        <div className="text-xs text-muted-foreground">Runtime workspace</div>
      </div>
      <form className="relative w-full md:max-w-sm" role="search" onSubmit={onSubmit}>
        <label className="sr-only" htmlFor="xpod-settings-search">Search settings</label>
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id="xpod-settings-search"
          aria-label="Search settings"
          className="h-9 pl-9"
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search settings"
          type="search"
          value={query}
        />
      </form>
    </div>
  );
}

export function XpodSettingsLayout({
  authBoundary: AuthBoundaryComponent = SettingsAuthBoundary,
}: {
  authBoundary?: ({ children }: { children: React.ReactNode }) => React.ReactNode;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const filteredItems = useMemo(() => filterSettingsNavigationItems(query), [query]);

  const handleSearchSubmit = (event: FormEvent<HTMLFormElement>) => {
    submitSettingsSearch(query, event, navigate);
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    clearSettingsSearchOnEscape(event, () => setQuery(''));
  };

  return (
    <AppLayout
      className="xpod-settings-shell"
      navigation={
        <div className="flex min-h-full flex-col">
          <div className="flex h-16 shrink-0 items-center border-b border-border px-4">
            <span className="text-sm font-semibold text-foreground">Xpod</span>
          </div>
          <SettingsNavLinks items={filteredItems} query={query} />
        </div>
      }
      header={
        <>
          <SettingsHostHeader
            query={query}
            onQueryChange={setQuery}
            onSubmit={handleSearchSubmit}
            onSearchKeyDown={handleSearchKeyDown}
          />
          <SettingsNavLinks compact items={filteredItems} query={query} />
        </>
      }
    >
      <main className="min-h-full bg-background" aria-label="Xpod settings workspace">
        <AuthBoundaryComponent>
          <Outlet />
        </AuthBoundaryComponent>
      </main>
    </AppLayout>
  );
}

export function PlaceholderSettingsSection({ title, description }: { title: string; description: string }) {
  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
        This workspace is ready for the real settings applet.
      </div>
    </section>
  );
}

export function ServicesHome() {
  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Services</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Runtime service health, diagnostics, RDF indexing, logs, and configuration.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <NavLink to="/services/logs">Logs</NavLink>
        </Button>
        <Button asChild variant="outline" size="sm">
          <NavLink to="/services/rdf">RDF</NavLink>
        </Button>
        <Button asChild variant="outline" size="sm">
          <NavLink to="/services/runtime">Runtime</NavLink>
        </Button>
      </div>
    </section>
  );
}
