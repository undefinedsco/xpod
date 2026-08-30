import { TwoPaneLayout, useWorkspaceLayout } from '@undefineds.co/extension-sdk/react';
import { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { systemSettingsNavigationItems } from '../../layout/system-settings-navigation';
import { getAdminStatus } from '../../api/admin';
import { getListNavItemClass } from '../../layout/nav-item-style';
import { PaneListHeader } from './PaneListHeader';
import { handleListNavigationKeyDown } from '../../layout/list-keyboard-navigation';

export default function SystemSettingsPage() {
  const location = useLocation();
  const [cloudSupported, setCloudSupported] = useState(false);
  useEffect(() => { let cancelled = false; void getAdminStatus().then((status) => { if (!cancelled) setCloudSupported(status?.env.XPOD_EDITION === 'cloud'); }); return () => { cancelled = true; }; }, []);
  const items = useMemo(() => systemSettingsNavigationItems.filter((item) => item.id !== 'cloud' || cloudSupported), [cloudSupported]);
  const selected = items.find((item) => location.pathname.endsWith(`/${item.path}`)) ?? items[0];
  return <TwoPaneLayout
    mode="auto"
    listHeader={<PaneListHeader title="Settings" />}
    list={<SystemSettingsList items={items} />}
    mainHeader={<div className="flex h-full items-center px-4"><div><h1 className="text-sm font-semibold">Settings · {selected.label}</h1><div className="text-xs text-muted-foreground">{selected.description}</div></div></div>}
    main={<section className="min-h-full bg-background"><Outlet /></section>}
    className="min-h-full"
  />;
}

function SystemSettingsList({ items }: { items: typeof systemSettingsNavigationItems }) {
  const workspace = useWorkspaceLayout();
  return <aside className="h-full border-r border-border bg-muted/20 py-2"><nav aria-label="Settings sections" data-list-navigation>
    {items.map((item) => {
      const Icon = item.icon;
      return <NavLink
        key={item.id}
        to={item.path}
        aria-label={item.label}
        onKeyDown={handleListNavigationKeyDown}
        onClick={() => workspace.openMain()}
        className={({ isActive }) => getListNavItemClass(isActive, { compact: false })}
      >
        <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span><span className="block text-sm font-medium">{item.label}</span><span className="block text-xs leading-4 text-muted-foreground">{item.description}</span></span>
      </NavLink>;
    })}
  </nav></aside>;
}
