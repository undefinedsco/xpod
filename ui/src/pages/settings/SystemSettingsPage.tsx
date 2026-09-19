import { TwoPaneLayout, useWorkspaceLayout } from '@undefineds.co/extension-sdk/react';
import { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  systemSettingsNavigationGroups,
  type SystemSettingsNavigationGroup,
} from '../../layout/system-settings-navigation';
import { getDdnsStatus, getProvisionStatus } from '../../api/admin';
import { projectSystemCapabilities } from './settings-projection';
import { getListNavItemClass } from '../../layout/nav-item-style';
import { PaneListHeader } from './PaneListHeader';
import { handleListNavigationKeyDown } from '../../layout/list-keyboard-navigation';

export default function SystemSettingsPage() {
  const location = useLocation();
  const [cloudSupported, setCloudSupported] = useState(false);
  useEffect(() => {
    let cancelled = false;
    // Coordination is observed, not inferred from the compiled edition: a
    // `local` node that is registered and cluster-managed still has cloud
    // settings, and hiding them left operators with no surface for that state.
    void Promise.all([getProvisionStatus(), getDdnsStatus()]).then(([provision, ddns]) => {
      if (cancelled) return;
      setCloudSupported(projectSystemCapabilities({
        registered: provision?.registered === true,
        managed: provision?.managed === true,
        domainAllocated: ddns?.allocated === true,
      }).cloud);
    });
    return () => { cancelled = true; };
  }, []);
  const groups = useMemo(() => systemSettingsNavigationGroups
    .map((group) => ({ ...group, items: group.items.filter((item) => item.id !== 'cloud' || cloudSupported) }))
    .filter((group) => group.items.length > 0), [cloudSupported]);
  const items = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const selected = items.find((item) => location.pathname.endsWith(`/${item.path}`)) ?? items[0];
  const selectedScope = groups.find((group) => group.items.includes(selected))?.scope;
  return <TwoPaneLayout
    mode="auto"
    listHeader={<PaneListHeader title="Settings" />}
    list={<SystemSettingsList groups={groups} />}
    mainHeader={<div className="flex h-full items-center px-4"><div><h1 className="text-sm font-semibold">Settings · {selected.label}</h1><div className="text-xs text-muted-foreground">{selected.description}</div>{selectedScope === 'node' ? <div className="text-xs text-amber-700 dark:text-amber-300">Applies to every Pod on this machine.</div> : null}</div></div>}
    main={<section className="min-h-full bg-background"><Outlet /></section>}
    className="min-h-full"
  />;
}

function SystemSettingsList({ groups }: { groups: SystemSettingsNavigationGroup[] }) {
  const workspace = useWorkspaceLayout();
  return <aside className="h-full border-r border-border bg-muted/20 py-2"><nav aria-label="Settings sections" data-list-navigation>
    {groups.map((group) => <div key={group.scope}>
      <div className="px-4 pb-1 pt-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.label}</div>
        <div className="text-xs leading-4 text-muted-foreground">{group.description}</div>
      </div>
      {group.items.map((item) => {
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
    </div>)}
  </nav></aside>;
}
