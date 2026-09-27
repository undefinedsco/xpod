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
    <nav aria-label={label} className="flex flex-row items-center gap-3 md:w-full md:flex-col md:items-stretch md:gap-1">
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
            <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span className="truncate md:inline">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export function XpodProductLayout({ product }: XpodProductLayoutProps) {
  // 四个任务入口同属一组；身份入口是用户卡，不再是工作区入口（spec §3.1）
  const navigationItems = globalNavigationItems;
  return (
    <AppLayout
      className={`xpod-${product}-shell`}
      navigation={
        <div className="flex h-full w-full flex-row items-center px-2 md:min-h-full md:flex-col md:px-0 md:py-4" data-list-navigation>
          <div className="mr-1 shrink-0 md:mb-2 md:ml-2 md:mr-0">
            <XpodUserCard />
          </div>
          <div className="flex min-w-0 flex-1 flex-row items-center justify-center md:mt-5 md:w-full md:flex-none md:flex-col md:justify-start">
            <ProductNavLinks items={navigationItems} label="Xpod workspaces" />
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
