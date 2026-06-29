import type { ComponentType } from 'react';
import { NavLink } from 'react-router-dom';
import { clsx } from 'clsx';
import { FileText, LayoutDashboard, Settings } from 'lucide-react';

export type AdminPage = 'status' | 'logs' | 'settings';

const items: Array<{ id: AdminPage; label: string; to: string; icon: ComponentType<{ className?: string }> }> = [
  { id: 'status', label: '状态', to: '/status', icon: LayoutDashboard },
  { id: 'logs', label: '日志', to: '/logs', icon: FileText },
  { id: 'settings', label: '设置', to: '/settings', icon: Settings },
];

export function Sidebar() {
  return (
    <aside className="hidden w-48 bg-layout-sidebar border-r border-border shrink-0 flex-col sm:flex">
      <div className="h-14 flex items-center px-4 border-b border-border">
        <span className="font-semibold text-foreground">Xpod</span>
      </div>
      <nav className="flex-1 py-4">
        {items.map((it) => {
          const Icon = it.icon;
          return (
            <NavLink
              key={it.id}
              to={it.to}
              className={({ isActive }) => clsx(
                'w-full px-4 py-2.5 flex items-center gap-3 text-sm transition-colors cursor-pointer',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                isActive
                  ? 'bg-primary/10 text-primary border-r-2 border-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Icon className="w-4 h-4" />
              <span>{it.label}</span>
            </NavLink>
          );
        })}
      </nav>
      <div className="p-4 border-t border-border">
        <div className="text-xs text-muted-foreground">Xpod Runtime</div>
      </div>
    </aside>
  );
}

export function MobileDashboardNav() {
  return (
    <nav className="sm:hidden border-t border-border bg-layout-sidebar px-2 py-2">
      <div className="grid grid-cols-3 gap-1">
        {items.map((it) => {
          const Icon = it.icon;
          return (
            <NavLink
              key={it.id}
              to={it.to}
              className={({ isActive }) => clsx(
                'flex min-h-11 flex-col items-center justify-center gap-1 rounded-md px-2 text-xs transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4" />
              <span>{it.label}</span>
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
