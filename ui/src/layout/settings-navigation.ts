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
    description: 'Model providers, default models, API keys, and inference preferences.',
    keywords: ['ai', 'llm', 'provider', 'model', 'api key'],
    icon: Bot,
  },
  {
    id: 'pod',
    label: 'Pod',
    path: '/pod',
    description: 'Pod storage, profile, identity, and data access settings.',
    keywords: ['solid', 'storage', 'profile', 'webid', 'data'],
    icon: Box,
  },
  {
    id: 'network',
    label: 'Network',
    path: '/network',
    description: 'Network endpoints, DNS, domains, tunnels, and connectivity.',
    keywords: ['dns', 'domain', 'tunnel', 'endpoint', 'connection'],
    icon: Network,
  },
  {
    id: 'services',
    label: 'Services',
    path: '/services',
    description: 'Runtime services, logs, RDF indexing, diagnostics, and restart controls.',
    keywords: ['runtime', 'logs', 'rdf', 'diagnostics', 'status'],
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
