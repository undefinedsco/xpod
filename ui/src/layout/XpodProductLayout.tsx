import { AppLayout } from '@undefineds.co/extension-sdk/react';
import { clsx } from 'clsx';
import type { ComponentType } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { globalNavigationItems, isGlobalNavigationItemActive, type GlobalNavigationItem } from './global-navigation';
import { XpodUserCard } from './XpodUserCard';
import { handleListNavigationKeyDown } from './list-keyboard-navigation';
import { getRailNavItemClass } from './nav-item-style';

export interface ProductNavigationItem {
  id: string;
  label: string;
  path: string;
  icon: ComponentType<{ className?: string }>;
}

export interface XpodProductLayoutProps {
  product: 'dashboard' | 'settings';
}

type NavigationLinkItem = Pick<ProductNavigationItem, 'id' | 'label' | 'icon'> & {
  href?: string;
  path?: string;
  activePaths?: readonly string[];
};

export function ProductNavLinks({ items, label }: { items: readonly NavigationLinkItem[]; label: string }) {
  const location = useLocation();
  const currentPathname = location.pathname;
  return (
    <nav aria-label={label} className="flex flex-row items-center gap-3 sm:flex-col sm:gap-4">
      {items.map((item) => {
        const Icon = item.icon;
        const href = item.href ?? item.path ?? '/';
        const active = item.activePaths
          ? isGlobalNavigationItemActive(item as GlobalNavigationItem, currentPathname)
          : currentPathname === item.path || currentPathname.startsWith(`${item.path}/`);
        return (
          <Link
            key={item.id}
            to={href}
            aria-label={item.label}
            aria-current={active ? 'page' : undefined}
            data-list-item="true"
            title={item.label}
            onKeyDown={handleListNavigationKeyDown}
            className={clsx(getRailNavItemClass(active), 'text-sm')}
          >
            <Icon className="h-6 w-6" aria-hidden="true" />
            <span className="sr-only">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export function XpodProductLayout({ product }: XpodProductLayoutProps) {
  const primaryItems = globalNavigationItems.filter((item) => item.placement === 'primary');
  const bottomItems = globalNavigationItems.filter((item) => item.placement === 'bottom');
  return (
    <AppLayout
      className={`xpod-${product}-shell`}
      navigation={
        <div className="flex h-full w-full flex-row items-center px-2 sm:min-h-full sm:flex-col sm:px-0 sm:py-4" data-list-navigation>
          <div className="mr-1 shrink-0 sm:mr-0 sm:ml-2 sm:mb-2">
            <XpodUserCard />
          </div>
          <div className="flex min-w-0 flex-1 flex-row items-center justify-center sm:mt-5 sm:flex-none sm:flex-col sm:justify-start">
            <ProductNavLinks items={primaryItems} label="Primary Xpod workspaces" />
          </div>
          <div className="flex shrink-0 flex-row items-center gap-3 sm:mt-auto sm:flex-col sm:gap-0">
            <ProductNavLinks items={bottomItems} label="Xpod settings" />
          </div>
        </div>
      }
    >
      <div className="flex h-full min-h-0 flex-col bg-background">
        <Outlet />
      </div>
    </AppLayout>
  );
}
