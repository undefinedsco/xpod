import { AppLayout } from '@undefineds.co/extension-sdk/react';
import { clsx } from 'clsx';
import type { ComponentType } from 'react';
import { NavLink, Outlet } from 'react-router-dom';

export interface ProductNavigationItem {
  id: string;
  label: string;
  path: string;
  icon: ComponentType<{ className?: string }>;
}

export interface XpodProductLayoutProps {
  product: 'dashboard' | 'settings';
  items: readonly ProductNavigationItem[];
  switchHref: '/dashboard/overview' | '/settings/models';
}

export function ProductNavLinks({ items, label }: { items: readonly ProductNavigationItem[]; label: string }) {
  return (
    <nav aria-label={label} className="flex flex-1 flex-col items-center gap-4 py-4">
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
              isActive ? 'text-primary' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
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

export function XpodProductLayout({ product, items, switchHref }: XpodProductLayoutProps) {
  const switchLabel = product === 'dashboard' ? 'Open Settings' : 'Open Dashboard';
  return (
    <AppLayout
      className={`xpod-${product}-shell`}
      navigation={
        <div className="flex min-h-full flex-col items-center">
          <div className="flex shrink-0 flex-col items-center pt-12">
            <a
              aria-label={switchLabel}
              className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground shadow-sm"
              href={switchHref}
              title={switchLabel}
            >
              X
            </a>
          </div>
          <ProductNavLinks items={items} label={`Primary ${product} sections`} />
        </div>
      }
    >
      <div className="min-h-full bg-background">
        <Outlet />
      </div>
    </AppLayout>
  );
}
