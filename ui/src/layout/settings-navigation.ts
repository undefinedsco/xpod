import { Box, Bot, Network, Server } from 'lucide-react';
import type { ComponentType } from 'react';

export type SettingsSectionId = 'models' | 'pod' | 'network' | 'services';

export interface SettingsNavigationItem {
  id: SettingsSectionId;
  label: string;
  path: string;
  description: string;
  keywords: string[];
  icon: ComponentType<{ className?: string }>;
}

export const settingsNavigationItems: SettingsNavigationItem[] = [
  {
    id: 'models',
    label: 'Models',
    path: '/models',
    description: '模型提供商、默认模型、API Key 与推理偏好。',
    keywords: ['ai', 'llm', 'provider', 'model', 'api key', '模型', '提供商'],
    icon: Bot,
  },
  {
    id: 'pod',
    label: 'Pod',
    path: '/pod',
    description: 'Pod 存储、身份与数据访问设置。',
    keywords: ['solid', 'storage', 'profile', 'webid', 'data', '存储', '身份'],
    icon: Box,
  },
  {
    id: 'network',
    label: 'Network',
    path: '/network',
    description: '网络接入点、DNS、域名、隧道与连通性。',
    keywords: ['dns', 'domain', 'tunnel', 'endpoint', 'connection', '网络', '隧道'],
    icon: Network,
  },
  {
    id: 'services',
    label: 'Services',
    path: '/services',
    description: '运行时服务、日志、RDF 索引、诊断与重启控制。',
    keywords: ['runtime', 'logs', 'rdf', 'diagnostics', 'status', '服务', '日志'],
    icon: Server,
  },
];

export function filterSettingsNavigationItems(query: string): SettingsNavigationItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return settingsNavigationItems;

  return settingsNavigationItems.filter((item) => {
    const searchable = [
      item.label,
      item.description,
      ...item.keywords,
    ].join(' ').toLowerCase();

    return searchable.includes(normalized);
  });
}

export function firstSettingsSearchMatch(query: string): SettingsNavigationItem | null {
  return filterSettingsNavigationItems(query)[0] ?? null;
}

export interface PreventableSearchEvent {
  preventDefault(): void;
}

export function submitSettingsSearch(
  query: string,
  event: PreventableSearchEvent,
  navigate: (path: string) => void,
): void {
  event.preventDefault();
  if (!query.trim()) return;

  const target = firstSettingsSearchMatch(query);
  if (target) navigate(target.path);
}

export interface SettingsSearchKeyEvent extends PreventableSearchEvent {
  key: string;
}

export function clearSettingsSearchOnEscape(
  event: SettingsSearchKeyEvent,
  clearQuery: () => void,
): void {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  clearQuery();
}

export const legacyDashboardRedirects = {
  status: '/services/runtime',
  logs: '/services/logs',
  rdf: '/services/rdf',
  settings: '/services/configuration',
} as const;

/** Public entry paths kept in sync with the API-served product aliases. */
export const productEntryTargets = {
  status: '/dashboard/overview',
  network: '/dashboard/network',
  aiConfig: '/settings/models?surface=ai-config',
  aiConnections: '/settings/models?surface=ai-connections',
} as const;
