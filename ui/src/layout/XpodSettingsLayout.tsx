import { AppLayout } from '@undefineds.co/extension-sdk/react';
import { clsx } from 'clsx';
import { NavLink, Outlet } from 'react-router-dom';
import {
  settingsNavigationItems,
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
  items,
  query,
}: {
  items: SettingsNavigationItem[];
  query: string;
}) {
  return (
    <nav
      aria-label="Primary settings sections"
      className="flex flex-1 flex-col items-center gap-4 py-4"
    >
      {items.length === 0 ? <EmptySearchResult query={query} /> : null}
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.id}
            to={item.path}
            aria-label={item.label}
            title={item.label}
            className={({ isActive }) => clsx(
              'flex h-9 w-9 items-center justify-center rounded-md transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              isActive
                ? 'text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            <Icon className="h-6 w-6" aria-hidden="true" />
            <span className="sr-only">{item.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}

export function XpodSettingsLayout() {
  return (
    <AppLayout
      className="xpod-settings-shell"
      navigation={
        <div className="flex min-h-full flex-col items-center">
          <div className="flex shrink-0 flex-col items-center pt-12">
            <div
              aria-label="Xpod"
              className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground shadow-sm"
              role="img"
            >
              X
            </div>
          </div>
          <SettingsNavLinks items={settingsNavigationItems} query="" />
        </div>
      }
    >
      <div className="min-h-full bg-background">
        <Outlet />
      </div>
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
