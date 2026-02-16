import type { ComponentType, Dispatch, SetStateAction } from 'react';
import { clsx } from 'clsx';
import { LayoutDashboard, Settings, FileText } from 'lucide-react';

export type AdminPage = 'dashboard' | 'logs' | 'settings';

export function Sidebar(props: {
  currentPage: AdminPage;
  onPageChange: Dispatch<SetStateAction<AdminPage>>;
}) {
  const { currentPage, onPageChange } = props;

  const items: Array<{ id: AdminPage; label: string; icon: ComponentType<{ className?: string }> }> = [
    { id: 'dashboard', label: '监控', icon: LayoutDashboard },
    { id: 'logs', label: '日志', icon: FileText },
    { id: 'settings', label: '设置', icon: Settings },
  ];

  return (
    <aside className="w-48 bg-layout-sidebar border-r border-border flex flex-col shrink-0">
      <div className="h-14 flex items-center px-4 border-b border-border">
        <span className="font-semibold text-foreground">Xpod</span>
      </div>
      <nav className="flex-1 py-4">
        {items.map((it) => {
          const Icon = it.icon;
          const active = currentPage === it.id;
          return (
            <button
              key={it.id}
              type="button"
              onClick={() => onPageChange(it.id)}
              className={clsx(
                'w-full px-4 py-2.5 flex items-center gap-3 text-sm transition-colors cursor-pointer',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                active
                  ? 'bg-primary/10 text-primary border-r-2 border-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Icon className="w-4 h-4" />
              <span>{it.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="p-4 border-t border-border">
        <div className="text-xs text-muted-foreground">Xpod Desktop</div>
      </div>
    </aside>
  );
}
