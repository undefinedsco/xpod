import { WorkspaceDrawerContext } from '@undefineds.co/extension-sdk/react';
import { StatusDot } from '@undefineds.co/shared-ui';
import { clsx } from 'clsx';
import { useEffect, useRef, useState, type ComponentType } from 'react';
import { Menu, X } from 'lucide-react';
import '../styles/desktop-shell.css';
import { useOptionalShellState } from '../shell/useShellState';
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

export function ProductNavLinks({ items, label, attentionIds = [] }: { items: readonly NavigationLinkItem[]; label: string; attentionIds?: readonly string[] }) {
  const location = useLocation();
  const currentPathname = location.pathname;
  return (
    <nav aria-label={label} className="flex w-full flex-col items-center gap-2">
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
            <span className="sr-only">{item.label}</span>
            {attentionIds.includes(item.id) ? <StatusDot tone="destructive" label="需要处理" className="absolute right-1 top-1" /> : null}
          </Link>
        );
      })}
    </nav>
  );
}

export function XpodProductLayout({ product }: XpodProductLayoutProps) {
  const location = useLocation();
  const shellState = useOptionalShellState();
  const deviceAttention = shellState?.snapshot.attention.some(item => item.kind === 'network') ?? false;
  const [drawerState, setDrawerState] = useState({ path: location.pathname, open: false });
  const drawerOpen = drawerState.path === location.pathname && drawerState.open;
  // Discard the old route's open state so browser Back cannot revive it.
  if (drawerState.path !== location.pathname) {
    setDrawerState({ path: location.pathname, open: false });
  }
  const menuRef = useRef<HTMLButtonElement>(null);
  const drawerWasOpen = useRef(false);
  const shellRef = useRef<HTMLElement>(null);
  const active = globalNavigationItems.find(item => isGlobalNavigationItemActive(item, location.pathname));
  const pageLabels: Record<string, string> = {
    models: '模型设置', search: '检索与索引', indexing: '检索与索引', applications: '授权应用', data: '数据管理',
    network: '网络访问', services: '服务状态', runtime: '运行设置', logs: '查看日志', appearance: '外观',
  };
  const page = pageLabels[location.pathname.split('/').filter(Boolean).at(-1) ?? ''];
  useEffect(() => {
    if (drawerWasOpen.current && !drawerOpen) menuRef.current?.focus();
    drawerWasOpen.current = drawerOpen;
  }, [drawerOpen]);
  useEffect(() => {
    const closeWideDrawer = () => { if (window.innerWidth >= 768) setDrawerState(current => ({ ...current, open: false })); };
    window.addEventListener('resize', closeWideDrawer);
    return () => window.removeEventListener('resize', closeWideDrawer);
  }, []);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setDrawerState(current => ({ ...current, open: false })); menuRef.current?.focus(); }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(shellRef.current?.querySelectorAll<HTMLElement>(
        '[data-app-layout-navigation] a, [data-app-layout-navigation] button, [data-workspace-pane="list"] a, [data-workspace-pane="list"] button, [data-workspace-pane="list"] input, [data-drawer-close]',
      ) ?? []).filter(element => element.getClientRects().length && !element.hasAttribute('disabled'));
      const first = focusable[0]; const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    shellRef.current?.querySelector<HTMLElement>('[data-drawer-close]')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen]);
  const navigationControl = <button ref={menuRef} type="button" className="xpod-navigation-toggle" aria-label="打开导航" aria-expanded={drawerOpen} onClick={() => setDrawerState({ path: location.pathname, open: true })}><Menu aria-hidden="true" size={20} /></button>;
  const headerLeading = <>{navigationControl}<span className="xpod-header-parent">{active?.label ?? 'Xpod'} ›</span></>;
  return (
    <WorkspaceDrawerContext.Provider value={{ open: drawerOpen, onClose: () => setDrawerState(current => ({ ...current, open: false })), headerLeading }}>
    <section ref={shellRef} role={drawerOpen ? 'dialog' : undefined} aria-modal={drawerOpen || undefined} aria-label={drawerOpen ? 'Xpod 导航' : undefined} className={`xpod-desktop-shell xpod-${product}-shell`} data-app-layout="workspace" data-drawer-open={drawerOpen}>
      <header className="xpod-narrow-header" data-app-layout-header>
        {navigationControl}
        <span>{active?.label ?? 'Xpod'}{page ? ` › ${page}` : ''}</span>
      </header>
      {drawerOpen ? <button className="xpod-drawer-backdrop" aria-label="关闭导航" onClick={() => { setDrawerState(current => ({ ...current, open: false })); menuRef.current?.focus(); }} /> : null}
      <aside className="xpod-rail" data-app-layout-navigation aria-label="Xpod 工作区导航" onClick={(event) => { if ((event.target as HTMLElement).closest('a')) setDrawerState(current => ({ ...current, open: false })); }}>
        <div className="xpod-rail-profile"><XpodUserCard /></div>
        <ProductNavLinks items={globalNavigationItems.slice(0, 3)} label="应用" />
        <div className="xpod-rail-host"><ProductNavLinks items={globalNavigationItems.slice(3)} label="本机" attentionIds={deviceAttention ? ['device'] : []} /></div>
      </aside>
      {drawerOpen ? <button data-drawer-close className="xpod-drawer-close" aria-label="收起导航" onClick={() => { setDrawerState(current => ({ ...current, open: false })); menuRef.current?.focus(); }}><X size={18} /></button> : null}
      <div className="xpod-shell-content" data-app-layout-content><Outlet /></div>
    </section>
    </WorkspaceDrawerContext.Provider>
  );
}
