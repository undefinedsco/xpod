import {
  settingsNavigationItems,
  type SettingsNavigationItem,
} from './settings-navigation';
import { ProductNavLinks, XpodProductLayout } from './XpodProductLayout';

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
    <>
      {items.length === 0 ? <EmptySearchResult query={query} /> : null}
      <ProductNavLinks items={items} label="Primary settings sections" />
    </>
  );
}

export function XpodSettingsLayout() {
  return (
    <XpodProductLayout product="settings" items={settingsNavigationItems} switchHref="/dashboard/overview" />
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
