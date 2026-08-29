import { TwoPaneLayout, useWorkspaceLayout } from '@undefineds.co/extension-sdk/react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { statusNavigationItems, type StatusNavigationGroup } from '../../layout/status-navigation';
import { PaneListHeader } from '../settings/PaneListHeader';
import { handleListNavigationKeyDown } from '../../layout/list-keyboard-navigation';
import { getListNavItemClass } from '../../layout/nav-item-style';

const groups: StatusNavigationGroup[] = ['Overview', 'Services', 'Diagnostics', 'Index', 'Usage'];

export default function StatusWorkspace() {
  const location = useLocation();
  const selected = [...statusNavigationItems]
    .sort((a, b) => b.path.length - a.path.length)
    .find((item) => location.pathname.endsWith(item.path)) ?? statusNavigationItems[0];
  return (
    <TwoPaneLayout
      mode="auto"
      listHeader={<PaneListHeader title="Status" />}
      list={<StatusList />}
      mainHeader={<div className="flex h-full items-center px-4"><div><h1 className="text-sm font-semibold">Status · {selected.label}</h1><div className="text-xs text-muted-foreground">Observed state and operational evidence</div></div></div>}
      main={<section className="min-h-full bg-background"><Outlet /></section>}
      className="min-h-full"
    />
  );
}

function StatusList() {
  const workspace = useWorkspaceLayout();
  return <aside data-list-navigation className="h-full overflow-y-auto border-r border-border bg-muted/20 py-2">
    {groups.map((group) => <section key={group} className="mb-3">
      <h2 className="px-5 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{group}</h2>
      {statusNavigationItems.filter((item) => item.group === group).map((item) => {
        const Icon = item.icon;
        return <NavLink
          key={item.id}
          to={item.path}
          end={item.end}
          onKeyDown={handleListNavigationKeyDown}
          onClick={() => workspace.openMain()}
          className={({ isActive }) => getListNavItemClass(isActive, { compact: false })}
        >
          <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />{item.label}
        </NavLink>;
      })}
    </section>)}
  </aside>;
}
