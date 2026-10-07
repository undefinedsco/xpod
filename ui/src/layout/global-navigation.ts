import { CheckSquare, Database, Monitor, Settings, Sparkles } from 'lucide-react';
import type { ComponentType } from 'react';

export type GlobalNavigationItemId = 'tasks' | 'ai' | 'pod' | 'device' | 'settings';
export interface GlobalNavigationItem {
  id: GlobalNavigationItemId;
  label: string;
  labelEn: string;
  href: string;
  activePaths: readonly string[];
  icon: ComponentType<{ className?: string }>;
}

/** Applets above, local host controls below; none require an Account session. */
export const globalNavigationItems = [
  { id: 'tasks', label: '任务', labelEn: 'Tasks', href: '/tasks', activePaths: ['/tasks'], icon: CheckSquare },
  { id: 'ai', label: 'AI 连接', labelEn: 'AI connections', href: '/ai-connections', activePaths: ['/ai-connections'], icon: Sparkles },
  { id: 'pod', label: 'Pod', labelEn: 'Pod', href: '/pod/models', activePaths: ['/pod'], icon: Database },
  { id: 'device', label: '这台设备', labelEn: 'This device', href: '/device/network', activePaths: ['/device'], icon: Monitor },
  { id: 'settings', label: '设置', labelEn: 'Settings', href: '/settings/appearance', activePaths: ['/settings'], icon: Settings },
] as const satisfies readonly GlobalNavigationItem[];

export function isGlobalNavigationItemActive(item: GlobalNavigationItem, pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  return item.activePaths.some((path) => normalized === path || normalized.startsWith(`${path}/`));
}
